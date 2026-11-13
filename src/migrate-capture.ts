// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { renderHandoff } from "./migrate-brief.ts";
import type { MigrateJournal } from "./migrate-journal.ts";
import type { AgentStatus, RuntimeKind, SessionRef, SessionRuntime } from "./runtime/types.ts";

export type MigrateOpts = {
  readonly to: RuntimeKind;
  readonly dryRun: boolean;
  readonly waitMinutes: number;
  readonly resume: boolean;
  readonly log: (line: string) => void;
};

/** One agent session being migrated: a lane (record = lanes/<key>.json) or the lead/duty role (record = roles.json). */
export type Subject = {
  readonly name: string;
  readonly kind: "lane" | "role";
  readonly from: SessionRef;
  /** The brief the replacement is built from: the lane's brief (with its footer), or the role's rendered prompt file. */
  readonly brief: () => string;
  readonly logTail: readonly string[];
  /**
   * Opens the replacement on `rt` with omp started in it: on the handoff brief `briefPath`, or resuming omp's session
   * file `resume`. Closes what it opened and throws when omp does not start.
   */
  readonly open: (rt: SessionRuntime, briefPath: string, resume: string | undefined) => Promise<SessionRef>;
  readonly setHold: (on: boolean) => void;
  readonly switchTo: (ref: SessionRef) => void;
};

export const POLL_MS = 5_000;

export const handoffPath = (d: Deps, name: string): string => join(d.store.root, "briefs", `${name}.handoff.md`);

export const askText = (d: Deps, name: string): string =>
  `[MIGRATE ${name}] write a handoff checkpoint now (goal, open todos, last state) to ${handoffPath(d, name)}, then stop`;

/**
 * Step (2): waits until the old agent is no longer working, asks it for a checkpoint, and waits until it stops working
 * again. Nothing is ever delivered to a working agent: `working` (nothing delivered) when it is still working after
 * the wait. `blocked` is returned without delivering anything (a blocked agent waits for a person).
 * `gone`: no agent there to ask (a gone session, a bare shell), so the capture says so.
 */
export async function askCheckpoint(d: Deps, s: Subject, opts: MigrateOpts): Promise<"stopped" | "gone" | "blocked" | "working"> {
  const rt = d.runtimes.for(s.from);
  const idleBy = d.now() + opts.waitMinutes * 60_000;
  let first: AgentStatus = await rt.status(s.from);
  for (; first === "working"; first = await rt.status(s.from)) {
    if (d.now() >= idleBy) return "working";
    await d.sleep(POLL_MS);
  }
  if (first === "blocked") return "blocked";
  if (first === "gone" || first === "shell") return "gone";
  const out = await rt.deliver(s.from, askText(d, s.name), { when: "idle" });
  if (out.kind === "no-agent") return "gone";
  if (out.kind === "not-ready") return out.status === "blocked" ? "blocked" : "working";
  const deadline = d.now() + opts.waitMinutes * 60_000;
  for (let status: AgentStatus = await rt.status(s.from); ; status = await rt.status(s.from)) {
    if (status === "gone" || status === "shell") return "gone";
    if (status !== "working") return "stopped";
    if (d.now() >= deadline) return "working";
    await d.sleep(POLL_MS);
  }
}

/**
 * Step (3): the handoff brief `briefs/<name>.migrate-<at>.md` (original brief + `## Handoff` + the lane footer), from
 * the lane log tail, the checkpoint the agent wrote, the last 80 screen lines and the queued inbox entries.
 */
export async function capture(d: Deps, s: Subject, j: MigrateJournal, agentGone: boolean): Promise<string> {
  const rt = d.runtimes.for(s.from);
  const screen = agentGone
    ? "(agent gone)"
    : await rt.read(s.from, 80).catch((e: unknown) => `(screen unreadable: ${e instanceof Error ? e.message : String(e)})`);
  const handoff = handoffPath(d, s.name);
  const text = renderHandoff({
    brief: s.brief(),
    from: s.from,
    lastState: agentGone ? "(agent gone)" : undefined,
    checkpoint: existsSync(handoff) ? readFileSync(handoff, "utf8") : undefined,
    logTail: s.logTail,
    screen,
    inbox: d.store.queued(s.from),
  });
  const out = join(d.store.root, "briefs", `${s.name}.migrate-${j.at}.md`);
  writeFileSync(out, text);
  return out;
}
