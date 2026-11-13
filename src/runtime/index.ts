import { HcRuntime } from "./hc/index.ts";
import { Herdr, HerdrRuntime } from "./herdr/index.ts";
import { Runtimes } from "./registry.ts";
import type { AgentStatus, RuntimeKind, SessionRef, SessionRuntime } from "./types.ts";

export { DeliveryUncertain, deliverOrThrow } from "./delivery.ts";
export { spawnExec, shq, ToolError, type Exec, type ExecResult } from "./exec.ts";
export { Runtimes } from "./registry.ts";
export type * from "./types.ts";

/**
 * The runtimes of a seori process: new sessions still open on herdr (through `herdr`, tests pass a recorder); a stored
 * hc ref is served by the hc adapter (`hc` builds it, default: the core this process's env names).
 */
export function defaultRuntimes(herdr: Herdr = new Herdr(), hc: () => SessionRuntime = () => new HcRuntime()): Runtimes {
  return new Runtimes("herdr", (kind: RuntimeKind): SessionRuntime => (kind === "herdr" ? new HerdrRuntime(herdr) : hc()));
}

/** A stored session and the runtime that owns it. */
export function session(runtimes: Runtimes, ref: SessionRef): { readonly rt: SessionRuntime; readonly ref: SessionRef } {
  return { rt: runtimes.for(ref), ref };
}

/** The status word of a stored session (see SessionRuntime.status). */
export function statusOf(runtimes: Runtimes, ref: SessionRef): Promise<AgentStatus> {
  return runtimes.for(ref).status(ref);
}
