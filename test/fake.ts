import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ompProfile } from "../src/agent/profile.ts";
import type { Deps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import type { AgentStatus } from "../src/runtime/types.ts";
import type { MessengerAdapter, MessengerConfig, SendTarget } from "../src/messenger/adapter.ts";
import { Store, type HostLoad } from "../src/store.ts";
import type { SessionRef } from "../src/runtime/index.ts";

/** An hc terminal as a SessionRef, the way a lane or role record stores it. */
export const paneRef = (id: string): SessionRef => ({ runtime: "hc", id });


/**
 * One terminal of the fake hc. `status` is what `hc get` reports (`shell`: nothing reported, a shell in front; `gone`
 * is never stored, the terminal is removed instead). `agent` is the reporting app (default "omp"), `pgid` the
 * foreground pid (default 101). `started` records the omp args of an agent start typed into its shell, `ran` every
 * other command typed there, `received` every message sent to the agent. `screen` is what `hc read` shows (its last
 * `--lines` lines), `session` the omp session path the runtime reports, and `onPrompt` runs after each message reached
 * the agent (to change the screen, say). The first message after an agent start is the lane kickoff: the next `get`
 * reports `working` once (omp took it). `labels` are the terminal's hc labels (default seori.group=seori).
 */
type Pane = {
  status: AgentStatus; received: string[]; ran: string[];
  foreground?: string | { name: string; argv: string[] }[] | undefined; agent?: string; pgid?: number;
  started?: { args: string[] };
  screen?: string[]; session?: string; onPrompt?: (text: string) => void;
  kicked?: boolean; workingReads?: number; labels: Record<string, string>;
};

/** The words of a command line shq quoted (`'a b'`, `'it'\''s'`), as the shell would split it. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      cur = (cur ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === "\\") {
      cur = (cur ?? "") + line[++i];
    } else if (c === " ") {
      if (cur !== undefined) words.push(cur);
      cur = undefined;
    } else cur = (cur ?? "") + c;
  }
  if (cur !== undefined) words.push(cur);
  return words;
}

/** omp's `--mode json` output for a run whose final assistant message is `text`. */
export function ompJson(text: string, opts: { stopReason?: string; provider?: string; model?: string } = {}): string {
  const message = {
    role: "assistant", content: [{ type: "text", text }], stopReason: opts.stopReason ?? "stop",
    provider: opts.provider ?? "anthropic", model: opts.model ?? "claude-test",
  };
  return [
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "review" }] } },
    { type: "message_end", message },
    { type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "review" }] }, message] },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

export class World {
  panes = new Map<string, Pane>();
  calls: { cmd: string; argv: readonly string[] }[] = [];
  clock = 1_000_000;
  host: HostLoad = { load1: 1, cores: 8, memFreePct: 50 };
  next = 1;
  /** pane id -> error text of a failed `hc send` to its agent (exit 1, no JSON: it may or may not have arrived) */
  promptFails = new Map<string, string>();
  /** an agent start from now on never reports a status (omp does not come up) */
  startFails = false;
  /** an agent started from now on never reports working on its kickoff (omp does not take it) */
  kickoffIgnored = false;
  /** what `omp plugin list --json` prints; undefined: the command fails */
  ompPlugins: unknown;
  /** pane id -> called with the 1-based count of `hc get` calls for that pane, before it answers */
  getHook = new Map<string, (n: number) => void>();
  private gets = new Map<string, number>();
  /** `hc get` reports no foreground for every pane (an unreadable foreground counts as a shell in front) */
  processInfoFails = false;
  /** number of upcoming `hc keys` calls that fail (exit 1) */
  keyFails = 0;
  gh: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });
  reviewer: (argv: readonly string[]) => { code: number; stdout: string; stderr?: string } = () => ({ code: 0, stdout: ompJson("VERDICT: CLEAR") });
  /** every duty alert sent through Deps.notify */
  notified: { config: MessengerConfig; target: SendTarget; text: string }[] = [];
  /** thrown by the next Deps.notify calls, one per call, before anything is recorded in `notified` */
  notifyFails: Error[] = [];

  /** Writes `messengers.json` under `root`: duty's channel alerts run only when one is configured. */
  messengers(root: string, configs: MessengerConfig[]): void {
    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: configs }));
  }

  /** The daemon's heartbeat, written `ageMs` before the world clock; undefined removes it. */
  heartbeat(root: string, ageMs: number | undefined): void {
    const dir = join(root, "messenger");
    mkdirSync(dir, { recursive: true });
    if (ageMs === undefined) rmSync(join(dir, "daemon.heartbeat"), { force: true });
    else writeFileSync(join(dir, "daemon.heartbeat"), JSON.stringify({ at: this.clock - ageMs, pid: process.pid }));
  }

  /** The lead extension's consumer lock: held by this live process, by a pid that has exited, or absent. */
  consumerLock(root: string, holder: "alive" | "dead" | "none"): void {
    const dir = join(root, "lead");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "consumer.lock");
    if (holder === "none") return rmSync(path, { force: true });
    const pid = holder === "alive" ? process.pid : Bun.spawnSync([process.execPath, "-e", ""]).pid;
    writeFileSync(path, JSON.stringify({ pid, host: hostname(), at: this.clock }));
  }

  addPane(id: string, status: AgentStatus = "idle", labels: Record<string, string> = { "seori.group": "seori" }): Pane {
    const p: Pane = { status, received: [], ran: [], labels };
    this.panes.set(id, p);
    return p;
  }

  exec: Exec = async (cmd, argv) => {
    this.calls.push({ cmd, argv });
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    if (cmd === "omp" && argv[0] === "plugin") {
      return this.ompPlugins === undefined ? { code: 1, stdout: "", stderr: "unknown command plugin" } : { code: 0, stdout: JSON.stringify(this.ompPlugins), stderr: "" };
    }
    if (cmd !== "hc") return { stderr: "", ...this.reviewer(argv) };
    const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify(result), stderr: "" });
    const fail = (kind: string, code: number) => ({ code, stdout: "", stderr: JSON.stringify({ error: { kind, message: kind } }) });
    const args = argv[0] === "--json" ? argv.slice(1) : argv;
    const [verb, id] = args;
    const status = (p: Pane) => (p.status === "shell" ? null : { app: p.agent ?? "omp", state: p.status === "unknown" ? "error" : p.status });
    if (verb === "run") {
      const labels: Record<string, string> = {};
      const dash = args.indexOf("--");
      args.slice(0, dash).forEach((a, i) => {
        const v = args[i + 1];
        if (a === "--label" && v !== undefined) labels[v.split("=")[0]!] = v.split("=").slice(1).join("=");
      });
      const address = `t${++this.next}`;
      this.addPane(address, "shell", labels);
      return ok({ address, state: "live" });
    }
    if (verb === "ls") {
      const want = args.flatMap((a, i) => (a === "--label" ? [String(args[i + 1])] : []));
      const rows = [...this.panes].filter(([, p]) => want.every((kv) => `${kv.split("=")[0]}=${p.labels[kv.split("=")[0]!]}` === kv));
      // Real hc (0.1.21) lists the terminal's own command as the `agent` of a terminal no agent reports from (`"agent":"sh"`,
      // status absent), so a listed agent alone does not mean an agent session; only a reported status does.
      const agent = (p: Pane) => (p.status === "shell" ? (typeof p.foreground === "string" ? p.foreground : "bash") : (p.agent ?? "omp"));
      return ok({
        terminals: rows.map(([address, p]) => ({ address, state: "live", status: status(p), agent: agent(p) })),
      });
    }
    const pane = id ? this.panes.get(id) : undefined;
    if (!pane) return fail("not_found", 3);
    if (verb === "get") {
      const n = (this.gets.get(id!) ?? 0) + 1;
      this.gets.set(id!, n);
      this.getHook.get(id!)?.(n);
      const fg = pane.foreground ?? (pane.status === "shell" ? "-bash" : "omp");
      const first = typeof fg === "string" ? { name: fg, argv: [fg] } : fg[0];
      const foreground = this.processInfoFails || first === undefined ? null : { ...first, pid: pane.pgid ?? 101 };
      const reported = pane.workingReads ? (pane.workingReads--, { app: pane.agent ?? "omp", state: "working" }) : status(pane);
      return ok({ address: id, state: "live", pid: 100, status: reported, foreground, labels: pane.labels, turn: 0, cols: 200 });
    }
    if (verb === "read") {
      const lines = Number(args[args.indexOf("--lines") + 1]);
      return ok({ text: (pane.screen ?? []).slice(-lines).join("\n") });
    }
    if (verb === "keys") {
      if (this.keyFails > 0) { this.keyFails--; return { code: 1, stdout: "", stderr: "key press failed" }; }
      return ok({});
    }
    if (verb === "send") {
      const text = String(args.at(-1));
      if (pane.status === "shell") {
        // Typed at the shell prompt: an agent start (`omp ...`, which reports idle once up) or any other command.
        const words = shellWords(text);
        if (words[0] !== "omp") { pane.ran.push(text); return ok({ started: null }); }
        pane.started = { args: words.slice(1) };
        if (this.startFails) return ok({ started: null });
        pane.agent = "omp";
        pane.status = "idle";
        pane.session ??= "/h/.omp/agent/sessions/omp.jsonl";
        return ok({ started: null });
      }
      const fail1 = this.promptFails.get(id!);
      if (fail1) return { code: 1, stdout: "", stderr: fail1 };
      const gate = args.indexOf("--if");
      if (gate >= 0 && args[gate + 1] !== pane.status) return fail("status_mismatch", 10);
      if (pane.status === "blocked" && !args.includes("--force")) return fail("blocked", 9);
      pane.received.push(text);
      if (pane.started && !pane.kicked) {
        pane.kicked = true;
        if (!this.kickoffIgnored) pane.workingReads = 1;
      }
      pane.onPrompt?.(text);
      return ok({ started: true, status: pane.status, turn: 1 });
    }
    if (verb === "kill") { this.panes.delete(id!); return ok({}); }
    return { code: 1, stdout: "", stderr: `unhandled ${args.join(" ")}` };
  };

  /**
   * The hc adapter over this world, on the world clock. hc reports no omp session file, so `agentSession` is the
   * pane's `session` here: supervision's token and cost ceilings are tested on it.
   */
  runtime(exec: Exec = this.exec): HcRuntime {
    const rt = new HcRuntime(exec, { env: process.env, sleep: async (ms) => void (this.clock += ms), now: () => this.clock, log: () => {} });
    rt.agentSession = async (ref) => this.panes.get(ref.id)?.session;
    return rt;
  }

  deps(): Deps {
    const root = mkdtempSync(join(tmpdir(), "seori-test-"));
    return {
      store: new Store(root),
      runtime: this.runtime(),
      exec: this.exec,
      now: () => this.clock,
      agent: ompProfile,
      agentCmd: "omp",
      seoriCmd: "seori",
      host: () => this.host,
      // A checkout no test starts a lane in: lanes keep their cwd unless a test points this at its own clone.
      installDir: join(root, "install"),
      sleep: async (ms) => {
        this.clock += ms;
      },
      notify: async (config, target, text) => {
        const fail = this.notifyFails.shift();
        if (fail) throw fail;
        this.notified.push({ config, target, text });
      },
    };
  }
}

/** The edit and reaction beyond send, doing nothing: for test adapters that only care about receive and send. */
export const noActions: Pick<MessengerAdapter, "edit" | "react"> = {
  edit: async () => {},
  react: async () => {},
};
