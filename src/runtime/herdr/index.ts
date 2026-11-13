import type {
  AgentIdentity,
  AgentStatus,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  GroupInfo,
  Key,
  Probe,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { Herdr, paneStatus, type PaneRef } from "./client.ts";

export { fallbackLine, Herdr, HerdrError } from "./client.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** herdr's key names: `esc` is its canonical Escape. */
const HERDR_KEYS: Readonly<Record<Key, string>> = { enter: "enter", escape: "esc" };
const str = (value: unknown): string => String(value ?? "");

const toRef = (paneId: string, workspaceId: string, tabId: string): SessionRef => ({
  runtime: "herdr",
  id: paneId,
  ...(workspaceId ? { group: workspaceId } : {}),
  ...(tabId ? { container: tabId } : {}),
});
const fromPane = (p: PaneRef): SessionRef => toRef(p.paneId, p.workspaceId, p.tabId);

/**
 * herdr behind the session runtime interface: a session is a pane, its group the pane's workspace, its container the
 * pane's tab. Every herdr argv is the one seori sent before the interface existed (see Herdr in ./client.ts).
 */
export class HerdrRuntime implements SessionRuntime {
  readonly kind = "herdr" as const;

  constructor(
    readonly client: Herdr = new Herdr(),
    private readonly env: Env = process.env,
  ) {}

  self(): SessionRef | undefined {
    const paneId = this.env["HERDR_PANE_ID"];
    return paneId ? toRef(paneId, this.env["HERDR_WORKSPACE_ID"] ?? "", "") : undefined;
  }

  async createGroup(label: string, cwd: string): Promise<string> {
    return (await this.client.createWorkspace(label, cwd)).workspaceId;
  }

  async create(spec: CreateSpec): Promise<SessionRef> {
    const env = { ...spec.env };
    switch (spec.container) {
      case "workspace-root":
        return fromPane(await this.client.createWorkspace(spec.name, spec.cwd, env));
      case "tab":
        return fromPane(await this.client.createTab(spec.name, spec.cwd, spec.group, env));
      case "split-below":
        if (spec.near === undefined) throw new Error("a split-below session needs `near`");
        return fromPane(await this.client.split(spec.near.id, spec.cwd, env));
    }
  }

  start(ref: SessionRef, command: string): Promise<void> {
    return this.client.run(ref.id, command);
  }

  /** `pane list`, keeping only the panes of one workspace when a group is given. */
  async list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    const group = filter?.group;
    return (await this.client.paneList())
      .filter((p) => group === undefined || str(p["workspace_id"]) === group)
      .map((p): SessionInfo => {
        const status = paneStatus(p);
        const [title, cwd] = [str(p["title"]), str(p["cwd"])];
        return {
          ref: toRef(str(p["pane_id"]), str(p["workspace_id"]), str(p["tab_id"])),
          ...(title ? { title } : {}),
          ...(cwd ? { cwd } : {}),
          status,
          ...(status !== "shell" ? { agent: str(p["agent"]) } : {}),
        };
      });
  }

  probe(ref: SessionRef): Promise<Probe> {
    return this.client.probe(ref.id);
  }

  read(ref: SessionRef, lines: number): Promise<string> {
    return this.client.read(ref.id, lines);
  }

  /** herdr types whatever the status word says (the caller decided), so `when` and `force` change nothing here. */
  deliver(ref: SessionRef, text: string, _opts?: DeliverOptions): Promise<DeliverOutcome> {
    return this.client.deliver(ref.id, text);
  }

  submitTyped(ref: SessionRef, into: AgentIdentity = {}): Promise<SubmitResult> {
    return this.client.submitTyped(ref.id, into);
  }

  typeIntoShell(ref: SessionRef, text: string): Promise<boolean> {
    return this.client.typeIntoShell(ref.id, text);
  }

  async keys(ref: SessionRef, pressed: readonly Key[]): Promise<void> {
    for (const key of pressed) await this.client.sendKeys(ref.id, HERDR_KEYS[key]);
  }

  /** "session" closes the pane; "container" closes its tab, or the pane when the ref names no tab. */
  async close(ref: SessionRef, scope: CloseScope = "session"): Promise<void> {
    if (scope === "container" && ref.container !== undefined) await this.client.closeTab(ref.container);
    else await this.client.close(ref.id);
  }

  status(ref: SessionRef): Promise<AgentStatus> {
    return this.client.status(ref.id);
  }

  async groups(): Promise<readonly GroupInfo[]> {
    return (await this.client.workspaces()).map((w) => ({ id: w.workspaceId, label: w.label }));
  }

  startAgent(ref: SessionRef, name: string, args: readonly string[], timeoutMs?: number): Promise<void> {
    return this.client.agentStart(name, ref.id, args, timeoutMs);
  }

  agentIntegration(): Promise<boolean> {
    return this.client.ompIntegration();
  }

  agentSession(ref: SessionRef): Promise<string | undefined> {
    return this.client.agentSessionPath(ref.id);
  }
}
