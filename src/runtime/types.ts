// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// The session runtime interface: everything seori does to an agent session (create, start, read, deliver, close) goes
// through a SessionRuntime, so the terminal multiplexer behind it (herdr today, hc next) is one adapter.

export type RuntimeKind = "herdr" | "hc";

/**
 * One session as its runtime addresses it. `group`: the herdr workspace id (hc: the seori.group label). `container`:
 * the herdr tab id (absent on hc).
 */
export type SessionRef = {
  readonly runtime: RuntimeKind;
  readonly id: string;
  readonly group?: string;
  readonly container?: string;
};

/** Agent lifecycle as the runtime reports it. `shell` = no recognised agent in the session; `gone` = no such session. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "shell" | "gone";

/**
 * Which agent typed text went into (#108): `agent` is the agent name the runtime reports, `pgid` the foreground process
 * group id. herdr's `pane get` `revision` is not used: in herdr 0.9.5 it stayed the same across an agent exit and
 * restart in the same pane, so it cannot tell two agents apart.
 */
export type AgentIdentity = { readonly agent?: string; readonly pgid?: number };

export type ForegroundProcess = { readonly name: string; readonly argv: readonly string[]; readonly pid?: number };

/**
 * One snapshot: status, identity, foreground and discovery data together. `rootPid`: the session's root process
 * (herdr process_info.shell_pid, hc terminal pid).
 */
export type Probe = {
  readonly status: AgentStatus;
  readonly agent?: string;
  readonly pgid?: number;
  readonly rootPid?: number;
  readonly turn?: number;
  readonly title?: string;
  readonly cwd?: string;
  readonly shellInFront: boolean;
  readonly foreground?: readonly ForegroundProcess[];
};

export type SessionInfo = {
  readonly ref: SessionRef;
  readonly name?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly status?: AgentStatus;
  readonly agent?: string;
  /** hc, listed with `homes`: the seori.home label (homeTag of the home that opened it); absent on an unlabelled terminal. */
  readonly home?: string;
};

/** One session group as the runtime lists it (herdr: a workspace and its label). */
export type GroupInfo = { readonly id: string; readonly label: string };

export type SessionRole = "lead" | "duty" | "duty-loop" | "hourly-loop" | "daemon" | "lane";

/**
 * Where the session is created. herdr: "workspace-root" = `workspace create` (the root pane is the session; the new
 * workspace id becomes the ref's group); "tab" = `tab create` in `group` (no --workspace when group is absent or
 * empty); "split-below" = `pane split` below `near`. An hc adapter ignores the container kind: one labelled terminal
 * running the user's shell with `env` set.
 */
export type CreateSpec = {
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly role: SessionRole;
  readonly container: "workspace-root" | "tab" | "split-below";
  readonly group?: string;
  readonly near?: SessionRef;
  /** The seori home that opens the session. hc labels the terminal `seori.home=<homeTag(home)>`; herdr ignores it. */
  readonly home?: string;
};

/**
 * `group`: one session group. `homes`: also read which seori home opened each session into SessionInfo.home (hc: its
 * seori.home label, one lookup per session; herdr ignores it).
 */
export type ListFilter = { readonly group?: string; readonly homes?: boolean };

export type DeliverWhen = "idle" | "working" | "any";
/** `when`: the status the text may be typed under (hc: --if idle / --if working / none). `force`: type into a blocked agent (hc --force; herdr: no-op). */
export type DeliverOptions = { readonly when?: DeliverWhen; readonly force?: boolean };

/**
 * `delivered`: the agent has the message. `no-agent`, having typed nothing: no running agent is in front (text typed
 * into a bare shell runs as a command, #66). `not-ready`, having typed nothing: an agent is there but may not take it
 * now (herdr: a dialog is open, `blocked`). `typed`: the text is in the agent's input and only the Enter that submits
 * it is missing (#108 identity in `into`). `ambiguous`: the message may already be in the session (#89) and must not
 * be sent again as is.
 */
export type DeliverOutcome =
  | { readonly kind: "delivered"; readonly turn?: number; readonly started?: boolean }
  | { readonly kind: "no-agent" }
  | { readonly kind: "not-ready"; readonly status: AgentStatus }
  | { readonly kind: "typed"; readonly into: AgentIdentity; readonly failure: unknown }
  | { readonly kind: "ambiguous"; readonly detail: string; readonly failure: unknown };

/** What submitTyped did: pressed Enter, found the agent away for now (suspended), or found a different or no agent. */
export type SubmitResult = "submitted" | "wait" | "changed";
export type Key = "enter" | "escape";
export type CloseScope = "session" | "container";

/** `unwrapped`: a line the terminal wrapped over several rows comes back as one line, not one line per row. */
export type ReadOptions = { readonly unwrapped?: boolean };

export interface SessionRuntime {
  readonly kind: RuntimeKind;
  /** The caller's own session from the runtime's env (HERDR_PANE_ID + HERDR_WORKSPACE_ID / HC_TERMINAL_ID), or undefined. */
  self(): SessionRef | undefined;
  /** herdr: `workspace create --label <label> --cwd <cwd> --no-focus` -> the workspace id (its root pane is left as is). */
  createGroup(label: string, cwd: string): Promise<string>;
  /** A session with the user's shell in it and nothing started. */
  create(spec: CreateSpec): Promise<SessionRef>;
  /** herdr: `pane run <id> <command>`. */
  start(ref: SessionRef, command: string): Promise<void>;
  /** Every session (of one group when given). Throws when the runtime's answer cannot be read: a failed list is never an empty one. */
  list(filter?: ListFilter): Promise<readonly SessionInfo[]>;
  probe(ref: SessionRef): Promise<Probe>;
  /** herdr: `pane read --source recent-unwrapped` (always unwrapped). hc: `read`; unwrapped joins rows as wide as the terminal's `cols`. */
  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string>;
  /** Never types into a session whose foreground is an interactive shell, whatever the status word says. */
  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome>;
  /**
   * Presses only Enter for text an earlier deliver typed into `into` (#89/#108). Throws DeliveryUncertain (typed, with
   * the identity seen) when every Enter failed.
   */
  submitTyped(ref: SessionRef, into?: AgentIdentity): Promise<SubmitResult>;
  /** The operator's explicit `seori send --to-shell`: false, typing nothing, when an agent is in the session. */
  typeIntoShell(ref: SessionRef, text: string): Promise<boolean>;
  keys(ref: SessionRef, keys: readonly Key[]): Promise<void>;
  /** herdr: "session" = `pane close <id>`; "container" = `tab close <ref.container>` (pane close when the ref has no container). Default "session". */
  close(ref: SessionRef, scope?: CloseScope): Promise<void>;

  // seori additions: what the harness needs beyond upstream's interface (agent start and the agent integration).

  /** The status word alone: one lookup, no foreground read and no screen check (probe does both). */
  status(ref: SessionRef): Promise<AgentStatus>;
  /** Every open session group with its label (herdr: `workspace list`). */
  groups(): Promise<readonly GroupInfo[]>;
  /**
   * Starts the agent in a session at its shell prompt and returns once it is ready for input (herdr: `agent start
   * --kind omp`). Names are unique among live agents; a busy session or a taken name is refused by the runtime.
   */
  startAgent(ref: SessionRef, name: string, args: readonly string[], timeoutMs?: number): Promise<void>;
  /** Whether the runtime can report the agent's status at all (herdr: its omp integration is installed). */
  agentIntegration(): Promise<boolean>;
  /** The agent's session file (omp's session jsonl), or undefined when the session is gone or reports none. */
  agentSession(ref: SessionRef): Promise<string | undefined>;
}

/** Id shape of a bare ref: only a herdr pane `w<ws>:p<pane>` may appear without its prefix. */
const BARE_HERDR = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
/**
 * Id shape after each prefix: a herdr pane, or a local hc terminal address. hc numbers terminals in base 36 (`t7`,
 * `t1b`, `t2h`). Another machine's `<machine>/<address>` is not a ref: the id names the session's inbox file.
 */
const HC_ADDRESS = /^t[0-9a-z]+$/;
const ID_SHAPES: Readonly<Record<RuntimeKind, RegExp>> = { herdr: BARE_HERDR, hc: HC_ADDRESS };
const KINDS = Object.keys(ID_SHAPES) as RuntimeKind[];

/** "herdr:w1:p3", "hc:t7", bare "w1:p3" (herdr). A bare "t7" is NOT a ref (it is a legal lane key); undefined otherwise. */
export const parseRef = (text: string): SessionRef | undefined => {
  for (const runtime of KINDS) {
    if (!text.startsWith(`${runtime}:`)) continue;
    const id = text.slice(runtime.length + 1);
    return ID_SHAPES[runtime].test(id) ? { runtime, id } : undefined;
  }
  return BARE_HERDR.test(text) ? { runtime: "herdr", id: text } : undefined;
};

export const formatRef = (ref: SessionRef): string => `${ref.runtime}:${ref.id}`;

/**
 * create + start in one call. A start that fails closes the session create just made (scope "session"), so no idle
 * shell is left behind, and rethrows the start error; a close that fails too is one stderr line.
 */
export async function openSession(rt: SessionRuntime, spec: CreateSpec, command: string): Promise<SessionRef> {
  const ref = await rt.create(spec);
  try {
    await rt.start(ref, command);
  } catch (e) {
    await rt.close(ref, "session").catch((closeError: unknown) => {
      const why = closeError instanceof Error ? closeError.message : String(closeError);
      process.stderr.write(`seori: could not close ${formatRef(ref)} after its start failed (${why})\n`);
    });
    throw e;
  }
  return ref;
}
