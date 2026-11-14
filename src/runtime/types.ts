// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// The session runtime interface: everything seori does to an agent session (create, start, read, deliver, close) goes
// through a SessionRuntime (hc, src/runtime/hc; tests hand in fakes).

/** One hc terminal as seori stores it. `runtime` is always "hc" (records carry it); `group`: its seori.group label. */
export type SessionRef = {
  readonly runtime: "hc";
  readonly id: string;
  readonly group?: string;
};

/** Agent lifecycle as the runtime reports it. `shell` = no recognised agent in the session; `gone` = no such session. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "shell" | "gone";

export type ForegroundProcess = { readonly name: string; readonly argv: readonly string[]; readonly pid?: number };

/**
 * One snapshot: status, identity, foreground and discovery data together. `rootPid`: the hc terminal's pid.
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
  /** The program that reports this session's status (omp); absent on a terminal no agent reports from, such as a shell. */
  readonly agent?: string;
  /** hc, listed with `homes`: the seori.home label (homeTag of the home that opened it); absent on an unlabelled terminal. */
  readonly home?: string;
};

/** One session group as the runtime lists it (hc: a seori.group label value, which is also its id). */
export type GroupInfo = { readonly id: string; readonly label: string };

export type SessionRole = "lead" | "duty" | "duty-loop" | "hourly-loop" | "daemon" | "lane";

/** A new session: one labelled hc terminal running the user's shell with `env` set, in group `group`. */
export type CreateSpec = {
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly role: SessionRole;
  readonly group?: string;
  /** The seori home that opens the session: the terminal is labelled `seori.home=<homeTag(home)>`. */
  readonly home?: string;
};

/**
 * `group`: one session group. `homes`: also read which seori home opened each session into SessionInfo.home (its
 * seori.home label, one lookup per session).
 */
export type ListFilter = { readonly group?: string; readonly homes?: boolean };

export type DeliverWhen = "idle" | "working" | "any";
/** `when`: the status the text may be typed under (hc: --if idle / --if working / none). `force`: type into a blocked agent (hc --force). */
export type DeliverOptions = { readonly when?: DeliverWhen; readonly force?: boolean };

/**
 * `delivered`: the agent has the message. `no-agent`, having typed nothing: no running agent is in front (text typed
 * into a bare shell runs as a command, #66). `not-ready`, having typed nothing: an agent is there but may not take it
 * now (a dialog is open, `blocked`). `ambiguous`: the message may already be in the session (#89) and must not be
 * sent again as is.
 */
export type DeliverOutcome =
  | { readonly kind: "delivered"; readonly turn?: number; readonly started?: boolean }
  | { readonly kind: "no-agent" }
  | { readonly kind: "not-ready"; readonly status: AgentStatus }
  | { readonly kind: "ambiguous"; readonly detail: string; readonly failure: unknown };

export type Key = "enter" | "escape";

/** `unwrapped`: a line the terminal wrapped over several rows comes back as one line, not one line per row. */
export type ReadOptions = { readonly unwrapped?: boolean };

export interface SessionRuntime {
  /** The caller's own session from the runtime's env (HC_TERMINAL_ID), or undefined. */
  self(): SessionRef | undefined;
  /** A session with the user's shell in it and nothing started. */
  create(spec: CreateSpec): Promise<SessionRef>;
  /** Types `command` at the session's shell prompt. */
  start(ref: SessionRef, command: string): Promise<void>;
  /** Every session (of one group when given). Throws when the runtime's answer cannot be read: a failed list is never an empty one. */
  list(filter?: ListFilter): Promise<readonly SessionInfo[]>;
  probe(ref: SessionRef): Promise<Probe>;
  /** `hc read`; unwrapped joins rows as wide as the terminal's `cols`. */
  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string>;
  /** Never types into a session whose foreground is an interactive shell, whatever the status word says. */
  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome>;
  /** The operator's explicit `seori send --to-shell`: false, typing nothing, when an agent is in the session. */
  typeIntoShell(ref: SessionRef, text: string): Promise<boolean>;
  keys(ref: SessionRef, keys: readonly Key[]): Promise<void>;
  close(ref: SessionRef): Promise<void>;

  // seori additions: what the harness needs beyond upstream's interface (agent start, groups and the agent's session file).

  /** The status word alone: one lookup, no foreground read and no screen check (probe does both). */
  status(ref: SessionRef): Promise<AgentStatus>;
  /** Every open session group with its label. */
  groups(): Promise<readonly GroupInfo[]>;
  /** Starts the agent in a session at its shell prompt and returns once it reports a status (is ready for input). */
  startAgent(ref: SessionRef, args: readonly string[], timeoutMs?: number): Promise<void>;
  /** The agent's session file (omp's session jsonl), or undefined when the session is gone or reports none. */
  agentSession(ref: SessionRef): Promise<string | undefined>;
}

/**
 * A local hc terminal address after the `hc:` prefix. hc numbers terminals in base 36 (`t7`, `t1b`, `t2h`). Another
 * machine's `<machine>/<address>` is not a ref: the id names the session's inbox file.
 */
const HC_ADDRESS = /^t[0-9a-z]+$/;

/** "hc:t7"; undefined otherwise. A bare "t7" is NOT a ref (it is a legal lane key). */
export const parseRef = (text: string): SessionRef | undefined => {
  if (!text.startsWith("hc:")) return undefined;
  const id = text.slice("hc:".length);
  return HC_ADDRESS.test(id) ? { runtime: "hc", id } : undefined;
};

export const formatRef = (ref: SessionRef): string => `${ref.runtime}:${ref.id}`;

/**
 * create + start in one call. A start that fails closes the session create just made, so no idle shell is left
 * behind, and rethrows the start error; a close that fails too is one stderr line.
 */
export async function openSession(rt: SessionRuntime, spec: CreateSpec, command: string): Promise<SessionRef> {
  const ref = await rt.create(spec);
  try {
    await rt.start(ref, command);
  } catch (e) {
    await rt.close(ref).catch((closeError: unknown) => {
      const why = closeError instanceof Error ? closeError.message : String(closeError);
      process.stderr.write(`seori: could not close ${formatRef(ref)} after its start failed (${why})\n`);
    });
    throw e;
  }
  return ref;
}
