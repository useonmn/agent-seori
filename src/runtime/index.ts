import { join } from "node:path";
import { HcRuntime } from "./hc/index.ts";
import { Herdr, HerdrRuntime } from "./herdr/index.ts";
import { Runtimes } from "./registry.ts";
import { readRuntimeChoice, type RuntimeChoice } from "./select.ts";
import type { AgentStatus, RuntimeKind, SessionRef, SessionRuntime } from "./types.ts";

export { DeliveryUncertain, deliverOrThrow } from "./delivery.ts";
export { spawnExec, shq, ToolError, type Exec, type ExecResult } from "./exec.ts";
export { Runtimes } from "./registry.ts";
export type * from "./types.ts";

/** The selector for a seori home: SEORI_RUNTIME, then <home>/config.json, then where this process runs, then PATH. */
export const choiceFor = (root: string, env: Readonly<Record<string, string | undefined>> = process.env): (() => RuntimeChoice) => () =>
  readRuntimeChoice({ env, configPath: join(root, "config.json") });

/**
 * The runtimes of a seori process: new sessions open on `choose` (production passes choiceFor(home): hc by default; the
 * default here is a fixed herdr so tests that hand in a herdr recorder keep it). `herdr` is the herdr API (tests pass a
 * recorder); a stored hc ref is served by the hc adapter (`hc` builds it, default: the core this process's env names).
 */
export function defaultRuntimes(
  herdr: Herdr = new Herdr(),
  hc: () => SessionRuntime = () => new HcRuntime(),
  choose: RuntimeKind | (() => RuntimeChoice) = "herdr",
): Runtimes {
  return new Runtimes(choose, (kind: RuntimeKind): SessionRuntime => (kind === "herdr" ? new HerdrRuntime(herdr) : hc()));
}

/** A stored session and the runtime that owns it. */
export function session(runtimes: Runtimes, ref: SessionRef): { readonly rt: SessionRuntime; readonly ref: SessionRef } {
  return { rt: runtimes.for(ref), ref };
}

/** The status word of a stored session (see SessionRuntime.status). */
export function statusOf(runtimes: Runtimes, ref: SessionRef): Promise<AgentStatus> {
  return runtimes.for(ref).status(ref);
}
