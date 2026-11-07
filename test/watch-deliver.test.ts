import { describe, expect, test } from "bun:test";
import { Channel } from "../src/channel.ts";
import { deliverWatchEvent } from "../src/watch/deliver.ts";
import type { Watch, WatchOwner } from "../src/watch/store.ts";
import { World } from "./fake.ts";

const watch = (id: string, owner: WatchOwner): Watch => ({
  id,
  name: "ci",
  source: { kind: "checks", repo: "o/r", number: 7 },
  owner,
  persistent: false,
  createdAt: 0,
  expiresAt: 3_600_000,
  status: "active",
  wakes: [],
  mutedEvents: 0,
  restarts: 0,
});

describe("deliverWatchEvent", () => {
  test("a lead watch appends watch rows to the lead channel, seq counting per watch from 1", async () => {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("w1:p1", "working");
    d.store.setRole("lead", "w1:p1");
    await deliverWatchEvent(d, watch("a1", { kind: "lead" }), "[watch ci a1] one");
    await deliverWatchEvent(d, watch("b2", { kind: "lead" }), "[watch ci b2] other");
    w.clock += 5;
    await deliverWatchEvent(d, watch("a1", { kind: "lead" }), "[watch ci a1] two");
    const channel = new Channel(d.store.root);
    expect(channel.inbound()).toEqual([
      { id: "watch:a1:1", kind: "watch", watchId: "a1", name: "ci", at: 1_000_000, text: "[watch ci a1] one" },
      { id: "watch:b2:1", kind: "watch", watchId: "b2", name: "ci", at: 1_000_000, text: "[watch ci b2] other" },
      { id: "watch:a1:2", kind: "watch", watchId: "a1", name: "ci", at: 1_000_005, text: "[watch ci a1] two" },
    ]);
    expect(channel.open().map((s) => s.row.id)).toEqual(["watch:a1:1", "watch:b2:1", "watch:a1:2"]);
    expect(lead.received).toEqual([]); // the lead extension delivers rows; no pane message
  });

  test("a lane watch is sent to the lane's pane (mid-turn too) and leaves the lead channel alone", async () => {
    const w = new World();
    const d = w.deps();
    const pane = w.addPane("w1:p9", "working");
    d.store.saveLane({ key: "fix-1", paneId: "w1:p9", tabId: "w1:t9", brief: "b", cwd: "/", status: "working", createdAt: 0, lastActivityAt: 0, nudges: 0, log: [] });
    await deliverWatchEvent(d, watch("c3", { kind: "lane", key: "fix-1" }), "[watch ci c3] checks passed");
    expect(pane.received).toHaveLength(1);
    expect(pane.received[0]).toContain("[watch ci c3] checks passed");
    expect(new Channel(d.store.root).inbound()).toEqual([]);
  });

  test("a lane that is gone throws, for the engine to log", async () => {
    const w = new World();
    const d = w.deps();
    await expect(deliverWatchEvent(d, watch("c3", { kind: "lane", key: "nope" }), "x")).rejects.toThrow("unknown target nope");
  });
});
