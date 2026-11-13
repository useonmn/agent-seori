import type { AgentIdentity, SessionRef, SessionRuntime } from "./types.ts";

/**
 * A delivery that failed after the message may already have reached the session (#89): sending it again could deliver
 * it twice. `typed`: the text is in the session's input and only the Enter that submits it is missing.
 */
export class DeliveryUncertain extends Error {
  constructor(readonly failure: unknown, readonly typed: boolean, readonly agent?: AgentIdentity) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/**
 * The harness's view of SessionRuntime.deliver: true when delivered, false having typed nothing (no agent in front,
 * or one that may not take it now), and DeliveryUncertain thrown when the message may already be in the session.
 */
export async function deliverOrThrow(rt: SessionRuntime, ref: SessionRef, text: string): Promise<boolean> {
  const out = await rt.deliver(ref, text);
  switch (out.kind) {
    case "delivered":
      return true;
    case "no-agent":
    case "not-ready":
      return false;
    case "typed":
      throw new DeliveryUncertain(out.failure, true, out.into);
    case "ambiguous":
      throw new DeliveryUncertain(out.failure, false);
  }
}
