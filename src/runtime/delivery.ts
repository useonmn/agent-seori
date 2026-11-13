import type { DeliverOptions, SessionRef, SessionRuntime } from "./types.ts";

/**
 * A delivery that failed after the message may already have reached the session (#89): sending it again could deliver
 * it twice.
 */
export class DeliveryUncertain extends Error {
  constructor(readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/**
 * The harness's view of SessionRuntime.deliver: true when delivered, false having typed nothing (no agent in front,
 * or one that may not take it now), and DeliveryUncertain thrown when the message may already be in the session.
 */
export async function deliverOrThrow(rt: SessionRuntime, ref: SessionRef, text: string, opts?: DeliverOptions): Promise<boolean> {
  const out = await rt.deliver(ref, text, opts);
  switch (out.kind) {
    case "delivered":
      return true;
    case "no-agent":
    case "not-ready":
      return false;
    case "ambiguous":
      throw new DeliveryUncertain(out.failure);
  }
}
