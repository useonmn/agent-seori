import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeliveryUncertain } from "../delivery.ts";
import { type Exec, type ExecResult, spawnExec, ToolError } from "../exec.ts";
import { interactiveShellInFront } from "../foreground.ts";
import type { AgentIdentity, AgentStatus, DeliverOutcome, ForegroundProcess, Probe, SubmitResult } from "../types.ts";

// Thin, typed wrapper over the herdr CLI, behind HerdrRuntime (./index.ts). Every call goes through one injectable
// `Exec`, so tests can replace herdr with a recorder and the e2e test can point at an isolated session.

/** A herdr call that exited non-zero (#89 code matches herdr's own output on it, never its message). */
export class HerdrError extends ToolError {
  constructor(argv: readonly string[], result: ExecResult) {
    super(argv, result, "herdr");
  }
}

/** The terminal needs a moment to finish a bracketed paste before an Enter is read as a submit. */
const PASTE_SETTLE_MS = 400;

/** How often the Enter that submits typed fallback text is tried before the delivery is reported as failed. */
const ENTER_ATTEMPTS = 3;

const NO_AGENT: DeliverOutcome = { kind: "no-agent" };
const BLOCKED: DeliverOutcome = { kind: "not-ready", status: "blocked" };
const DELIVERED: DeliverOutcome = { kind: "delivered" };
/** How a failed process-info lookup ends its stderr line: on the delivery path the message stays queued. */
const HOLDING = "holding delivery";
/** Outside a delivery, a failed lookup is read as doubt and nothing is held by the probe itself. */
const AS_DOUBT = "status read as doubt";

/** herdr's own reason for a failed call; never the error message, which carries argv and so the delivered text. */
const reasonOf = (e: unknown): string => (e instanceof ToolError ? (e.result.stderr || e.result.stdout).trim() : String(e));
const ambiguous = (step: string, failure: unknown): DeliverOutcome => ({ kind: "ambiguous", detail: `herdr ${step} failed: ${reasonOf(failure)}`, failure });

const INPUT_RULE = /^─{10,}$/;
/** Lines omo prints below its input box (cwd/model line, status line); more than this and the box is not at the bottom. */
const FOOTER_MAX_LINES = 3;
/** Recent lines read to look for omo's idle input box. */
const SCREEN_LINES = 30;

/**
 * True only when an omo screen positively shows its idle input at the bottom: a bare rule, an empty `❯` line, a bare
 * rule, and no `esc to interrupt` anywhere. Anything else (a turn, a dialog, a draft in the input, an unknown layout)
 * is false, so the caller keeps queueing. Stopgap for #62: herdr reports an omo whose live monitors or background
 * cells are running as `working` even between turns. Used by probe() only; seori's status() does not read the screen.
 */
export function omoScreenIdle(screen: string): boolean {
  if (screen.includes("esc to interrupt")) return false;
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const input = lines.lastIndexOf("❯");
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!INPUT_RULE.test(lines[input - 1] ?? "") || !INPUT_RULE.test(lines[input + 1] ?? "")) return false;
  return lines.length - 1 - (input + 1) <= FOOTER_MAX_LINES;
}

const nonEmptyText = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** herdr's status word for a pane record: no agent is a shell; herdr's four states pass through, anything else unknown. */
export function paneStatus(pane: Record<string, unknown>): AgentStatus {
  if (!pane["agent"]) return "shell";
  const s = String(pane["agent_status"] ?? "unknown");
  return (["idle", "working", "blocked", "done"].includes(s) ? s : "unknown") as AgentStatus;
}

const toProcess = (value: unknown): ForegroundProcess => {
  const p = (value ?? {}) as { name?: unknown; argv?: unknown; pid?: unknown };
  const argv = Array.isArray(p.argv) ? p.argv.map(String) : [];
  return { name: String(p.name ?? ""), argv, ...(typeof p.pid === "number" ? { pid: p.pid } : {}) };
};

/**
 * The typed fallback sends one line (a multi-line paste swallows its Enter). Text whose layout matters (a code fence or
 * an indented line) would be mangled by joining its lines, so it is written to a file and the line points there.
 */
export function fallbackLine(text: string, spill: (body: string) => string): string {
  const body = text.trim();
  if (!body.includes("\n")) return body;
  if (!/```|\n[ \t]+\S/.test(body)) return body.replace(/\s*\n\s*/g, " / ");
  const first = body.split("\n", 1)[0]!.trim();
  return `[seori] a multi-line message is in ${spill(`${body}\n`)}; read that file whole. It starts: ${first}`;
}

export type PaneRef = { readonly paneId: string; readonly tabId: string; readonly workspaceId: string };

export class Herdr {
  constructor(
    private readonly exec: Exec = spawnExec,
    private readonly session: string | undefined = process.env["SEORI_HERDR_SESSION"],
    /** Where the typed fallback writes a multi-line message whose layout matters (see fallbackLine). */
    private readonly spillDir: string = join(process.env["SEORI_HOME"] ?? join(homedir(), ".seori"), "messages"),
  ) {}

  private spill(body: string): string {
    mkdirSync(this.spillDir, { recursive: true });
    const path = join(this.spillDir, `${Date.now()}-${randomUUID().slice(0, 8)}.md`);
    writeFileSync(path, body);
    return path;
  }

  private async call(argv: readonly string[]): Promise<Record<string, unknown>> {
    const full = this.session ? ["--session", this.session, ...argv] : [...argv];
    const res = await this.exec("herdr", full);
    if (res.code !== 0) throw new HerdrError(full, res);
    const text = res.stdout.trim();
    if (!text.startsWith("{")) return {};
    const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
    return parsed.result ?? {};
  }

  /**
   * `env` is set in the root pane's shell. `herdr agent start` has no --env flag (herdr 0.9.5), so an agent that needs
   * its own environment (the lead's channel extension) gets it from the shell it is started in.
   */
  async createWorkspace(label: string, cwd: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const argv = ["workspace", "create", "--label", label, "--cwd", cwd, "--no-focus"];
    for (const [k, v] of Object.entries(env)) argv.push("--env", `${k}=${v}`);
    const r = await this.call(argv);
    return toPaneRef(r["root_pane"]);
  }

  /** `workspace list`: every open workspace's id and label. */
  async workspaces(): Promise<{ workspaceId: string; label: string }[]> {
    const list = (await this.call(["workspace", "list"]))["workspaces"];
    return (Array.isArray(list) ? (list as Record<string, unknown>[]) : []).map((w) => ({
      workspaceId: String(w["workspace_id"] ?? ""),
      label: String(w["label"] ?? ""),
    }));
  }

  async createTab(label: string, cwd: string, workspaceId?: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const argv = ["tab", "create", "--label", label, "--cwd", cwd, "--no-focus"];
    if (workspaceId) argv.push("--workspace", workspaceId);
    for (const [k, v] of Object.entries(env)) argv.push("--env", `${k}=${v}`);
    const r = await this.call(argv);
    return toPaneRef(r["root_pane"]);
  }

  async split(paneId: string, cwd: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const argv = ["pane", "split", paneId, "--direction", "down", "--ratio", "0.3", "--cwd", cwd, "--no-focus"];
    for (const [k, v] of Object.entries(env)) argv.push("--env", `${k}=${v}`);
    const r = await this.call(argv);
    return toPaneRef(r["pane"]);
  }

  async run(paneId: string, commandLine: string): Promise<void> {
    await this.call(["pane", "run", paneId, commandLine]);
  }

  /**
   * `herdr agent start`: starts omp in a pane at its interactive shell prompt and returns once omp is ready for input.
   * herdr refuses a name another live agent already uses (agent_name_taken) and a pane that already runs an agent
   * (agent_pane_busy). No prompt goes in here: with the omp integration, start would wait for that first turn to end.
   */
  async agentStart(name: string, paneId: string, args: readonly string[], timeoutMs = 60_000): Promise<void> {
    await this.call(["agent", "start", name, "--kind", "omp", "--pane", paneId, "--timeout", String(timeoutMs), "--", ...args]);
  }

  /**
   * Whether herdr's omp integration is installed (`herdr integration status`). Without it herdr reports omp as idle
   * at all times, so nothing could tell a busy agent from an idle one.
   */
  async ompIntegration(): Promise<boolean> {
    const res = await this.exec("herdr", ["integration", "status"]);
    if (res.code !== 0) throw new HerdrError(["integration", "status"], res);
    return res.stdout.split("\n").some((line) => line.startsWith("omp:") && !line.includes("not installed"));
  }

  async status(paneId: string): Promise<AgentStatus> {
    return (await this.paneAgent(paneId)).status;
  }

  /** `pane get`: the agent status, the agent name when one is detected, and the pane's title and cwd when reported. */
  private async paneAgent(paneId: string): Promise<{ status: AgentStatus; agent?: string; title?: string; cwd?: string }> {
    let pane: Record<string, unknown>;
    try {
      pane = (await this.call(["pane", "get", paneId]))["pane"] as Record<string, unknown>;
    } catch (e) {
      if (e instanceof HerdrError && /not.?found/i.test(e.message)) return { status: "gone" };
      throw e;
    }
    if (!pane) return { status: "gone" };
    const title = nonEmptyText(pane["title"]);
    const cwd = nonEmptyText(pane["cwd"]);
    const where = { ...(title !== undefined ? { title } : {}), ...(cwd !== undefined ? { cwd } : {}) };
    const status = paneStatus(pane);
    return status === "shell" ? { status, ...where } : { status, agent: String(pane["agent"]), ...where };
  }

  /**
   * `pane list`: every pane record as herdr reports it. Throws on a list without a panes array or a pane without an
   * id: a failed list is never an empty one.
   */
  async paneList(): Promise<Record<string, unknown>[]> {
    const panes = (await this.call(["pane", "list"]))["panes"];
    if (!Array.isArray(panes)) throw new Error("herdr pane list returned no panes array");
    return panes.map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      if (typeof o["pane_id"] !== "string") throw new Error("herdr pane list returned a pane without pane_id");
      return o;
    });
  }

  /**
   * One snapshot of a pane: herdr's status (with the #62 omo screen check), the agent, its foreground, title and cwd.
   * `screenCheck: false` skips the screen read.
   */
  async probe(paneId: string, screenCheck = true): Promise<Probe> {
    const { status, agent, title, cwd } = await this.paneAgent(paneId);
    if (status === "gone") return { status, shellInFront: true };
    const seen: AgentStatus = screenCheck && status === "working" && (await this.screenShowsIdle(paneId)) ? "idle" : status;
    const front = await this.foreground(paneId, AS_DOUBT);
    return {
      status: seen,
      ...(agent !== undefined ? { agent } : {}),
      ...(front.pgid !== undefined ? { pgid: front.pgid } : {}),
      ...(front.rootPid !== undefined ? { rootPid: front.rootPid } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      shellInFront: front.shell,
      ...(front.processes ? { foreground: front.processes } : {}),
    };
  }

  /** #62: believe the screen only when it positively shows the idle input; a failed read is doubt and stays working. */
  private async screenShowsIdle(paneId: string): Promise<boolean> {
    try {
      return omoScreenIdle(await this.read(paneId, SCREEN_LINES));
    } catch {
      return false;
    }
  }

  /**
   * `pane read --source recent-unwrapped`: the last `lines` lines of the pane's terminal, soft-wrapped lines joined back
   * into one, as plain text. herdr prints this raw, not as JSON.
   */
  async read(paneId: string, lines: number): Promise<string> {
    const argv = ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)];
    const full = this.session ? ["--session", this.session, ...argv] : argv;
    const res = await this.exec("herdr", full);
    if (res.code !== 0) throw new HerdrError(full, res);
    return res.stdout;
  }

  /** `pane send-keys`: presses keys in a pane, by herdr's key names (`esc` is its canonical Escape). */
  async sendKeys(paneId: string, ...keys: string[]): Promise<void> {
    await this.call(["pane", "send-keys", paneId, ...keys]);
  }

  /**
   * The session file of the agent in a pane, from `pane get`'s `agent_session` (herdr's omp integration reports omp's
   * session jsonl as `{ kind: "path", value }`). Undefined when the pane is gone, has no agent session or reports
   * another kind.
   */
  async agentSessionPath(paneId: string): Promise<string | undefined> {
    let pane: Record<string, unknown> | undefined;
    try {
      pane = (await this.call(["pane", "get", paneId]))["pane"] as Record<string, unknown> | undefined;
    } catch (e) {
      if (e instanceof HerdrError && /not.?found/i.test(e.message)) return undefined;
      throw e;
    }
    const session = pane?.["agent_session"] as Record<string, unknown> | null | undefined;
    if (session?.["kind"] !== "path" || typeof session["value"] !== "string" || !session["value"]) return undefined;
    return session["value"];
  }

  /**
   * Delivers one message to the agent in a pane as a single argv element: nothing in it is ever expanded by a shell.
   * `no-agent`, having typed nothing, when the pane turns out to have no running agent: text typed into a bare shell
   * runs as a command (#66), so the caller keeps the message queued; `not-ready` when a dialog is open. `ambiguous`
   * or `typed` when the message may already be in the pane (#89); the caller must not send it again as is.
   */
  async deliver(paneId: string, text: string): Promise<DeliverOutcome> {
    // A dialog (a tool approval) may have opened since the caller read the status: an Enter would answer it.
    if ((await this.paneAgent(paneId)).status === "blocked") return BLOCKED;
    if (await this.shellInForeground(paneId)) return NO_AGENT;
    try {
      await this.call(["agent", "prompt", paneId, text]);
      return DELIVERED;
    } catch (e) {
      // herdr refuses `agent prompt` with agent_not_ready when the agent is not the pane's foreground process (an omp
      // suspended with Ctrl+Z) or was launched without `herdr agent start`. Fall back to typing the text and pressing Enter.
      // Match herdr's own output, never e.message: that carries argv, which includes the delivered text.
      // Any other failure (a timeout, say) may come after herdr handed the prompt over: it is ambiguous.
      if (!(e instanceof HerdrError) || !/agent_not_ready/.test(e.result.stderr || e.result.stdout)) return ambiguous("agent prompt", e);
      // agent_not_ready also covers an agent that exited and left a shell in front: typing would run the text there.
      // Re-read right before typing (#66): only a pane that still has an agent gets keystrokes.
      const { status: st, agent } = await this.paneAgent(paneId);
      // `blocked`: a dialog is open; typed text would go into it and the Enter could approve it. Kept queued.
      if (st === "blocked") return BLOCKED;
      if (st === "shell" || st === "gone") return NO_AGENT;
      const front = await this.foreground(paneId);
      if (front.shell) return NO_AGENT;
      // A multi-line paste swallows the Enter that follows it, so type the message as one line.
      // A failed send-text may still have typed some or all of it: ambiguous as well.
      try {
        await this.call(["pane", "send-text", paneId, fallbackLine(text, (body) => this.spill(body))]);
      } catch (err) {
        return ambiguous("pane send-text", err);
      }
      await Bun.sleep(PASTE_SETTLE_MS);
      const into: AgentIdentity = { agent, pgid: front.pgid };
      try {
        await this.pressEnter(paneId);
      } catch (err) {
        return { kind: "typed", into, failure: err };
      }
      return DELIVERED;
    }
  }

  /**
   * Submits text that an earlier deliver typed into `typedInto` but could not submit: presses only Enter, never types
   * the text again. `changed`, pressing nothing: herdr sees no agent in the pane, or a different one (another name or
   * foreground process group), so the typed text is not in this input (#108). `wait`, pressing nothing: the agent is
   * still reported but a shell is in front (suspended with Ctrl+Z, #66/#69), or the lookup failed.
   */
  async submitTyped(paneId: string, typedInto: AgentIdentity = {}): Promise<SubmitResult> {
    const { status: st, agent } = await this.paneAgent(paneId);
    if (st === "gone") return "wait";
    if (st === "shell") return "changed";
    const front = await this.foreground(paneId);
    if (front.shell) return "wait";
    if (typedInto.agent !== undefined && agent !== typedInto.agent) return "changed";
    if (typedInto.pgid !== undefined && front.pgid !== typedInto.pgid) return "changed";
    try {
      await this.pressEnter(paneId);
    } catch (err) {
      throw new DeliveryUncertain(err, true, { agent, pgid: front.pgid });
    }
    return "submitted";
  }

  /** The text is already in the pane: retry only the Enter, so a flaky key press never re-types the message. Throws the last failure. */
  private async pressEnter(paneId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.call(["pane", "send-keys", paneId, "enter"]);
        return;
      } catch (err) {
        if (attempt >= ENTER_ATTEMPTS) throw err;
      }
    }
  }

  /** See interactiveShellInFront. A failed or unreadable lookup is doubt: it holds delivery and says so on stderr. */
  async shellInForeground(paneId: string): Promise<boolean> {
    return (await this.foreground(paneId)).shell;
  }

  /**
   * `pane process-info`: whether a shell is in front (see interactiveShellInFront), the foreground process group, the
   * pane's shell pid and its foreground processes. A failed lookup is doubt (a shell in front) and one stderr line
   * ending in `onFail`.
   */
  private async foreground(paneId: string, onFail = HOLDING): Promise<{ shell: boolean; pgid?: number; rootPid?: number; processes?: ForegroundProcess[] }> {
    try {
      const info = (await this.call(["pane", "process-info", "--pane", paneId]))["process_info"];
      const o = info as { foreground_process_group_id?: unknown; shell_pid?: unknown; foreground_processes?: unknown } | undefined;
      const pgid = o?.foreground_process_group_id;
      const rootPid = o?.shell_pid;
      const processes = Array.isArray(o?.foreground_processes) ? o.foreground_processes.map(toProcess) : undefined;
      return {
        shell: interactiveShellInFront(info),
        ...(typeof pgid === "number" ? { pgid } : {}),
        ...(typeof rootPid === "number" ? { rootPid } : {}),
        ...(processes ? { processes } : {}),
      };
    } catch (e) {
      process.stderr.write(`seori: herdr pane process-info failed for ${paneId} (${reasonOf(e)}); ${onFail}\n`);
      return { shell: true };
    }
  }

  /**
   * The operator's explicit `seori send --to-shell`: types text + Enter into a pane that has no agent. The status is
   * re-read right before typing; if an agent is there now, nothing is typed and false is returned.
   */
  async typeIntoShell(paneId: string, text: string): Promise<boolean> {
    if ((await this.status(paneId)) !== "shell") return false;
    await this.call(["pane", "send-text", paneId, text]);
    await this.call(["pane", "send-keys", paneId, "enter"]);
    return true;
  }

  async close(paneId: string): Promise<void> {
    await this.call(["pane", "close", paneId]);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.call(["tab", "close", tabId]);
  }
}

function toPaneRef(v: unknown): PaneRef {
  const o = (v ?? {}) as Record<string, unknown>;
  const paneId = String(o["pane_id"] ?? "");
  if (!paneId) throw new Error("herdr did not return a pane id");
  return { paneId, tabId: String(o["tab_id"] ?? ""), workspaceId: String(o["workspace_id"] ?? "") };
}

