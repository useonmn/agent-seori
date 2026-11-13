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

/** A stored session and the runtime that owns it. */
export function session(runtimes: Runtimes, ref: SessionRef): { readonly rt: SessionRuntime; readonly ref: SessionRef } {
  return { rt: runtimes.for(ref), ref };
}

/** The status word of a stored session (see SessionRuntime.status). */
export function statusOf(runtimes: Runtimes, ref: SessionRef): Promise<AgentStatus> {
  return runtimes.for(ref).status(ref);
}
