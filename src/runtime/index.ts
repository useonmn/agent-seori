import { Herdr, HerdrRuntime } from "./herdr/index.ts";
import { Runtimes } from "./registry.ts";
import { RuntimeChoiceError } from "./select.ts";
import type { AgentStatus, RuntimeKind, SessionRef, SessionRuntime } from "./types.ts";

export { DeliveryUncertain, deliverOrThrow } from "./delivery.ts";
export { spawnExec, shq, ToolError, type Exec, type ExecResult } from "./exec.ts";
export { Runtimes } from "./registry.ts";
export type * from "./types.ts";

/**
 * The runtimes of a seori process: every session opens on herdr (through `herdr`, tests pass a recorder) until the hc
 * adapter lands; any other kind is refused.
 */
export function defaultRuntimes(herdr: Herdr = new Herdr()): Runtimes {
  return new Runtimes("herdr", (kind: RuntimeKind): SessionRuntime => {
    if (kind === "herdr") return new HerdrRuntime(herdr);
    throw new RuntimeChoiceError(`the ${kind} runtime is not available in this seori yet`);
  });
}

/** A session id as records store it today: a bare herdr pane id (stored runtime refs come later). */
export const storedRef = (id: string): SessionRef => ({ runtime: "herdr", id });

/** A stored session id and the runtime that owns it. */
export function session(runtimes: Runtimes, id: string): { readonly rt: SessionRuntime; readonly ref: SessionRef } {
  const ref = storedRef(id);
  return { rt: runtimes.for(ref), ref };
}

/** The status word of a stored session (see SessionRuntime.status). */
export function statusOf(runtimes: Runtimes, id: string): Promise<AgentStatus> {
  const { rt, ref } = session(runtimes, id);
  return rt.status(ref);
}
