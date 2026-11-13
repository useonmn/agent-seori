// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import type { Exec } from "../exec.ts";
import { shq } from "../exec.ts";
import type {
  AgentIdentity,
  AgentStatus,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  GroupInfo,
  Key,
  ListFilter,
  Probe,
  ReadOptions,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { deliver, keys, read, typeIntoShell } from "./deliver.ts";
import { type Env, envExec } from "./exec.ts";
import { probe } from "./probe.ts";
import { close, create, groups, list, selfRef, start } from "./sessions.ts";

export { HcError } from "./exec.ts";

export type HcRuntimeOptions = {
  /** The env hc runs with (it names the core: HC_SESSION, XDG_RUNTIME_DIR, HC_TERMINAL_SOCKET) and SHELL/HC_TERMINAL_ID. */
  readonly env?: Env;
  /** The agent command startAgent types (default `omp`, the agent hc reports a status for). */
  readonly agentCommand?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
};

const AGENT_START_MS = 60_000;
const AGENT_POLL_MS = 500;
/** Statuses that mean the agent has reported over OSC 7501 (a shell or a silent program has not). */
const REPORTING: ReadonlySet<AgentStatus> = new Set(["idle", "working", "blocked", "done"]);

/** herdr-core (`hc`) behind the session runtime interface, one `hc --json` call per step. */
export class HcRuntime implements SessionRuntime {
  readonly kind = "hc" as const;
  private readonly exec: Exec;
  private readonly env: Env;
  private readonly agentCommand: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(exec?: Exec, options: HcRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    this.exec = exec ?? envExec(this.env);
    this.agentCommand = options.agentCommand ?? "omp";
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => void process.stderr.write(`${line}\n`));
  }

  self(): SessionRef | undefined {
    return selfRef(this.env);
  }

  /** hc has no workspaces: a group is only the `seori.group` label value. */
  async createGroup(label: string, _cwd: string): Promise<string> {
    return label;
  }

  create(spec: CreateSpec): Promise<SessionRef> {
    return create(this.exec, spec, this.env["SHELL"] || "sh");
  }

  start(ref: SessionRef, command: string): Promise<void> {
    return start(this.exec, ref.id, command);
  }

  list(filter?: ListFilter): Promise<readonly SessionInfo[]> {
    return list(this.exec, filter?.group, filter?.homes);
  }

  probe(ref: SessionRef): Promise<Probe> {
    return probe(this.exec, ref.id);
  }

  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string> {
    return read(this.exec, ref.id, lines, opts?.unwrapped ?? false);
  }

  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome> {
    return deliver(this.exec, ref.id, text, opts);
  }

  /**
   * Always `changed`, touching nothing: hc's send pastes and presses Enter in one step, so it never leaves typed text
   * waiting for an Enter. A `typed` entry can only come from another runtime, and pressing Enter here would submit
   * whatever a person has in this input instead.
   */
  async submitTyped(_ref: SessionRef, _into?: AgentIdentity): Promise<SubmitResult> {
    return "changed";
  }

  typeIntoShell(ref: SessionRef, text: string): Promise<boolean> {
    return typeIntoShell(this.exec, ref.id, text);
  }

  keys(ref: SessionRef, names: readonly Key[]): Promise<void> {
    return keys(this.exec, ref.id, names);
  }

  /** Kill then remove; hc has no container, so the scope does not change anything. */
  close(ref: SessionRef, _scope?: CloseScope): Promise<void> {
    return close(this.exec, ref.id, this.sleep, this.log);
  }

  /** `hc get` alone: the reported word. */
  async status(ref: SessionRef): Promise<AgentStatus> {
    return (await probe(this.exec, ref.id)).status;
  }

  groups(): Promise<readonly GroupInfo[]> {
    return groups(this.exec);
  }

  /**
   * Types `<agentCommand> <args>` (each shell-quoted) at the session's shell prompt and waits until the agent reports a
   * status over OSC 7501. hc has no agent names, so `name` is not used. Throws when the terminal is gone or nothing
   * reported within `timeoutMs`.
   */
  async startAgent(ref: SessionRef, _name: string, args: readonly string[], timeoutMs = AGENT_START_MS): Promise<void> {
    await start(this.exec, ref.id, [this.agentCommand, ...args].map(shq).join(" "));
    const until = this.now() + timeoutMs;
    for (;;) {
      const status = await this.status(ref);
      if (REPORTING.has(status)) return;
      if (status === "gone") throw new Error(`hc terminal ${ref.id} is gone before ${this.agentCommand} reported`);
      if (this.now() >= until) throw new Error(`${this.agentCommand} in hc terminal ${ref.id} did not report a status within ${timeoutMs} ms`);
      await this.sleep(AGENT_POLL_MS);
    }
  }

  /** hc reports omp's status itself (OSC 7501); there is nothing to install. */
  async agentIntegration(): Promise<boolean> {
    return true;
  }

  /** hc does not report an agent session file. */
  async agentSession(_ref: SessionRef): Promise<string | undefined> {
    return undefined;
  }
}
