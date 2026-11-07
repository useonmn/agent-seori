import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { Herdr, type AgentStatus, type Exec } from "../src/herdr.ts";
import type { MessengerConfig, SendTarget } from "../src/messenger/adapter.ts";
import { Store, type HostLoad } from "../src/store.ts";

/**
 * `agent` is the agent name `pane get` reports (default "pi"), `pgid` the foreground process group `pane process-info`
 * reports (default 101). `started` records the name and omp args of a `herdr agent start` into this pane. `screen` is
 * what `pane read` shows (its last `--lines` lines), `session` the omp session path `pane get` reports as
 * `agent_session`, and `onPrompt` runs after each `agent prompt` reached the pane (to change the screen, say).
 */
type Pane = {
  status: AgentStatus; received: string[]; ran: string[];
  foreground?: string | { name: string; argv: string[] }[] | undefined; agent?: string; pgid?: number;
  started?: { name: string; args: string[] };
  screen?: string[]; session?: string; onPrompt?: (text: string) => void;
};

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
  /** pane id -> herdr error text returned by `agent prompt` (exit 1) */
  promptFails = new Map<string, string>();
  /** herdr error text returned by every `agent start` (exit 1); undefined: start succeeds */
  startFails: string | undefined;
  /** what `herdr integration status` reports for omp */
  ompIntegration = true;
  /** pane id -> called with the 1-based count of `pane get` calls for that pane, before it answers */
  getHook = new Map<string, (n: number) => void>();
  private gets = new Map<string, number>();
  /** `pane process-info` fails (exit 1) for every pane */
  processInfoFails = false;
  /** number of upcoming `pane send-keys` calls that fail (exit 1) */
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

  addPane(id: string, status: AgentStatus = "idle"): Pane {
    const p = { status, received: [], ran: [] };
    this.panes.set(id, p);
    return p;
  }

  exec: Exec = async (cmd, argv) => {
    this.calls.push({ cmd, argv });
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    if (cmd !== "herdr") return { stderr: "", ...this.reviewer(argv) };
    const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
    const [group, verb, id] = argv;
    if (group === "integration" && verb === "status") {
      const omp = this.ompIntegration ? "current (v10)" : "not installed";
      return { code: 0, stdout: `pi: not installed (/h/.pi/x.ts)\nomp: ${omp} (/h/.omp/agent/extensions/herdr-omp-agent-state.ts)\n`, stderr: "" };
    }
    if (group === "agent" && verb === "start") {
      const paneId = String(argv[argv.indexOf("--pane") + 1]);
      const target = this.panes.get(paneId);
      if (!target) return { code: 1, stdout: "", stderr: `pane_not_found ${paneId}` };
      if (target.status !== "shell") return { code: 1, stdout: "", stderr: '{"error":{"code":"agent_pane_busy"}}' };
      if (this.startFails) return { code: 1, stdout: "", stderr: this.startFails };
      const dash = argv.indexOf("--");
      target.started = { name: String(id), args: dash < 0 ? [] : argv.slice(dash + 1).map(String) };
      target.agent = "omp";
      target.status = "idle";
      return ok({ agent: { name: id, agent: "omp", agent_status: "idle", pane_id: paneId }, type: "agent_started" });
    }
    if (group === "pane" && verb === "process-info") {
      const target = this.panes.get(String(argv[3]));
      if (!target || this.processInfoFails) return { code: 1, stdout: "", stderr: "process-info failed" };
      const fg = target.foreground ?? (target.status === "shell" ? "-bash" : "omp");
      const procs = typeof fg === "string" ? [{ name: fg, argv: [fg] }] : fg;
      return ok({ process_info: { pane_id: argv[3], shell_pid: 100, foreground_process_group_id: target.pgid ?? 101, foreground_processes: procs.map((x, i) => ({ ...x, pid: 101 + i })) } });
    }
    if ((group === "tab" || group === "workspace") && verb === "create") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ root_pane: { pane_id: pane, tab_id: `w1:t${this.next}`, workspace_id: "w1" } });
    }
    if (group === "pane" && verb === "split") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ pane: { pane_id: pane, tab_id: "w1:t1", workspace_id: "w1" } });
    }
    const pane = id ? this.panes.get(id) : undefined;
    if (!pane) return { code: 1, stdout: "", stderr: `pane_not_found ${id}` };
    if (group === "pane" && verb === "get") {
      const n = (this.gets.get(id!) ?? 0) + 1;
      this.gets.set(id!, n);
      this.getHook.get(id!)?.(n);
      const agentSession = pane.session ? { agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: pane.session } } : {};
      return ok({ pane: { pane_id: id, agent: pane.status === "shell" ? null : (pane.agent ?? "pi"), agent_status: pane.status, ...agentSession } });
    }
    if (group === "pane" && verb === "read") {
      const lines = Number(argv[argv.indexOf("--lines") + 1]);
      return { code: 0, stdout: (pane.screen ?? []).slice(-lines).join("\n") + "\n", stderr: "" };
    }
    if (group === "pane" && verb === "run") { pane.ran.push(String(argv[3])); return ok({}); }
    if (group === "pane" && verb === "send-text") { pane.received.push(String(argv[3])); return ok({}); }
    if (group === "pane" && verb === "send-keys") {
      if (this.keyFails > 0) { this.keyFails--; return { code: 1, stdout: "", stderr: "key press failed" }; }
      return ok({});
    }
    if (group === "agent" && verb === "prompt") {
      const fail = this.promptFails.get(id!);
      if (fail) return { code: 1, stdout: "", stderr: fail };
      pane.received.push(String(argv[3]));
      pane.onPrompt?.(String(argv[3]));
      return ok({});
    }
    if (group === "pane" && verb === "close") { this.panes.delete(id!); return ok({}); }
    return { code: 1, stdout: "", stderr: `unhandled ${argv.join(" ")}` };
  };

  deps(): Deps {
    const root = mkdtempSync(join(tmpdir(), "seori-test-"));
    return {
      store: new Store(root),
      herdr: new Herdr(this.exec, "", join(root, "messages")),
      exec: this.exec,
      now: () => this.clock,
      agentCmd: "omp",
      seoriCmd: "seori",
      host: () => this.host,
      notify: async (config, target, text) => {
        const fail = this.notifyFails.shift();
        if (fail) throw fail;
        this.notified.push({ config, target, text });
      },
    };
  }
}
