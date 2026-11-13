import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { flushInbox, releaseHeld } from "../src/harness.ts";
import type { QueuedMessage, Store } from "../src/store.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { World, paneRef } from "./fake.ts";

const PANE = paneRef("t2");

function setup() {
  const w = new World();
  const d = w.deps();
  w.addPane("t1", "idle");
  d.store.setRole("lead", paneRef("t1"));
  const pane = w.addPane("t2", "idle");
  return { w, d, pane };
}

/**
 * A sender in another process that calls enqueue(`ref`, `msg`) right after the next inbox read once armed: between a
 * rewrite's read and its write. While the append lock it needs is held, enqueue gives up (stays locked) and the sender
 * sends again once the rewrite is done (`finish`), as a real sender's enqueue would have waited.
 */
function racingSender(store: Store, ref: SessionRef, msg: QueuedMessage) {
  const read = store.queued.bind(store);
  let armed = false;
  let waiting = false;
  store.queued = (r: SessionRef) => {
    const msgs = read(r);
    if (armed) {
      armed = false;
      try {
        store.enqueue(ref, msg);
      } catch (e) {
        if (!/stays locked/.test(String(e))) throw e;
        waiting = true;
      }
    }
    return msgs;
  };
  return {
    arm: () => void (armed = true),
    finish: () => {
      if (waiting) store.enqueue(ref, msg);
    },
  };
}

describe("an inbox rewrite never drops a message enqueued between its read and its write", () => {
  test("settling a delivered batch keeps a message queued while the batch was being settled", async () => {
    const { d, pane } = setup();
    d.store.enqueue(PANE, { at: 1, from: "cli", text: "first" });
    const sender = racingSender(d.store, PANE, { at: 2, from: "lane-a", text: "late" });
    pane.onPrompt = () => sender.arm();
    expect(await flushInbox(d, PANE)).toBe("delivered");
    sender.finish();
    expect(pane.received).toEqual(["first"]);
    expect(d.store.queued(PANE).map((m) => m.text)).toEqual(["late"]);
  });

  test("seori inbox ack keeps a message queued while it rewrote the inbox", () => {
    const { d } = setup();
    d.store.saveInbox(PANE, [{ at: 0, from: "cli", text: "held", attempt: { at: 1, state: "ambiguous" } }]);
    const sender = racingSender(d.store, PANE, { at: 2, from: "lane-a", text: "late" });
    sender.arm();
    expect(releaseHeld(d, "hc:t2", 1, "ack")).toBe("hc:t2");
    sender.finish();
    expect(d.store.queued(PANE).map((m) => m.text)).toEqual(["late"]);
  });
});
