import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/harness.ts";
import { agentGone, deadDutyText, deadLaneText, panesTick, UNOWNED_AFTER_MS, unownedText } from "../src/panes.ts";
import type { LaneStatus } from "../src/store.ts";
import { World, paneRef } from "./fake.ts";

const MIN = 60_000;

function setup(status: LaneStatus = "working") {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", paneRef("t1"));
  const duty = w.addPane("t2", "idle");
  d.store.setRole("duty", paneRef("t2"));
  const pane = w.addPane("t5", "working");
  d.store.saveLane({
    key: "fix-a", sessionRef: paneRef("t5"), paneId: "t5", tabId: "w1:t5", brief: "/dev/null", cwd: "/repo", status,
    createdAt: w.clock, lastActivityAt: w.clock, nudges: 0, log: [],
  });
  /** One duty pass of the pane-health module, `gap` after the last (a minute, as the duty loop runs). */
  const pass = async (gap = MIN) => {
    w.clock += gap;
    return panesTick(d);
  };
  return { w, d, lead, duty, pane, pass };
}

describe("dead agents", () => {
  test("a lane pane showing a shell on two passes in a row is told once, and again in a later spell", async () => {
    const { lead, pane, pass } = setup();
    pane.status = "shell";
    expect(await pass()).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(await pass()).toEqual([{ lane: "fix-a", pane: "hc:t5", action: "dead" }]);
    expect(lead.received).toEqual([deadLaneText("fix-a", paneRef("t5"))]);
    expect(await pass()).toEqual([]);
    expect(lead.received).toHaveLength(1);
    // The agent is back: the spell ends, and a new one is told again after two passes.
    pane.status = "idle";
    await pass();
    pane.status = "shell";
    await pass();
    expect(lead.received).toHaveLength(1);
    await pass();
    expect(lead.received).toHaveLength(2);
  });

  test("the message names the pane as seori does and gives hc commands with the bare terminal id", () => {
    const text = deadLaneText("fix-a", paneRef("t5"));
    expect(text).toStartWith("[DEAD fix-a] pane hc:t5 ");
    expect(text).toContain("(hc read t5)");
    expect(text).toContain("(hc kill t5:");
    expect(unownedText(paneRef("t9"), "omp", 5)).toContain("seori adopt <key> --ref hc:t9 to make it a lane, or close it (hc kill t9)");
  });

  test("an agent suspended with Ctrl+Z (hc still says idle, the shell is in front) is a dead agent too", async () => {
    const { lead, pane, pass } = setup();
    pane.status = "idle";
    pane.foreground = "-bash";
    await pass();
    await pass();
    expect(lead.received).toEqual([deadLaneText("fix-a", paneRef("t5"))]);
  });

  test("one pass with a shell is not a dead agent", async () => {
    const { lead, pane, pass } = setup();
    pane.status = "shell";
    await pass();
    pane.status = "working";
    await pass();
    pane.status = "shell";
    await pass();
    expect(lead.received).toEqual([]);
  });

  test("a pass right after another (duty --once beside the loop) does not count twice", async () => {
    const { lead, pane, pass } = setup();
    pane.status = "shell";
    await pass();
    await pass(1_000);
    expect(lead.received).toEqual([]);
    await pass();
    expect(lead.received).toHaveLength(1);
  });

  test("a lane record naming a terminal outside the group (an id reused after an hc restart) is not reported", async () => {
    const { lead, pane, pass } = setup();
    pane.labels = { "seori.group": "someone-else" };
    pane.status = "shell";
    for (let i = 0; i < 3; i++) await pass();
    expect(lead.received).toEqual([]);
  });

  test("an agent still reporting, whose foreground cannot be read, is not taken for a dead one", async () => {
    const { w, d, lead, pass } = setup();
    w.processInfoFails = true;
    expect(agentGone(await d.runtime.probe(paneRef("t5")))).toBe(false);
    await pass();
    await pass();
    expect(lead.received).toEqual([]);
  });

  test("with no lead recorded nothing is marked told; the lead hears of it once one is recorded", async () => {
    const { d, lead, pane, pass } = setup();
    writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ duty: "hc:t2" })); // no lead recorded
    pane.status = "shell";
    await pass();
    expect(await pass()).toEqual([]);
    d.store.setRole("lead", paneRef("t1"));
    expect(await pass()).toEqual([{ lane: "fix-a", pane: "hc:t5", action: "dead" }]);
    expect(lead.received).toEqual([deadLaneText("fix-a", paneRef("t5"))]);
  });

  test("waiting and paused lanes are watched; a READY lane is not (its agent may end once it has answered)", async () => {
    for (const status of ["waiting", "paused"] as const) {
      const lane = setup(status);
      lane.pane.status = "shell";
      await lane.pass();
      await lane.pass();
      expect(lane.lead.received).toEqual([deadLaneText("fix-a", paneRef("t5"))]);
    }
    const ready = setup("ready");
    ready.pane.status = "shell";
    await ready.pass();
    await ready.pass();
    expect(ready.lead.received).toEqual([]);
  });

  test("the duty pane showing a shell is told as [DEAD duty]", async () => {
    const { lead, duty, pass } = setup();
    duty.status = "shell";
    await pass();
    expect(await pass()).toEqual([{ pane: "hc:t2", action: "dead" }]);
    expect(lead.received).toEqual([deadDutyText(paneRef("t2"))]);
    expect(lead.received[0]).toContain("(hc read t2)");
    expect(lead.received[0]).toContain("(hc kill t2)");
  });

  test("a lead pane that is gone: the event is still reported, and the failed delivery is its own event", async () => {
    const { w, pane, pass } = setup();
    w.panes.delete("t1");
    pane.status = "shell";
    await pass();
    const events = await pass();
    expect(events[0]).toEqual({ lane: "fix-a", pane: "hc:t5", action: "dead" });
    expect(events[1]).toMatchObject({ pane: "hc:t5", action: "panes-delivery-failed" });
    expect(await pass()).toEqual([]);
  });

  test("duty does not nudge a lane with no agent in front", async () => {
    const { w, d, pane } = setup();
    pane.status = "shell";
    w.clock += 15 * MIN;
    const events = await dutyTick(d);
    expect(events.filter((e) => e.action.startsWith("nudge") || e.action === "escalated")).toEqual([]);
    expect(d.store.lane("fix-a")!.nudges).toBe(0);
    expect(pane.received).toEqual([]);
  });

  test("duty does not nudge a suspended agent either (hc says idle, the shell is in front)", async () => {
    const { w, d, pane } = setup();
    pane.status = "idle";
    pane.foreground = "-bash";
    w.clock += 15 * MIN;
    await dutyTick(d);
    expect(d.store.lane("fix-a")!.nudges).toBe(0);
    expect(d.store.queued(paneRef("t5"))).toEqual([]);
  });

  test("each duty pass runs the pane-health check", async () => {
    const { w, d, lead, pane } = setup();
    pane.status = "shell";
    await dutyTick(d);
    w.clock += MIN;
    expect(await dutyTick(d)).toContainEqual({ lane: "fix-a", pane: "hc:t5", action: "dead" });
    expect(lead.received).toContain(deadLaneText("fix-a", paneRef("t5")));
  });
});

describe("agent sessions nothing owns", () => {
  test("an agent session in the group with no lane and no role is told once, after it stayed so for UNOWNED_AFTER_MS", async () => {
    const { w, lead, pass } = setup();
    w.addPane("t9", "idle");
    w.addPane("t8", "idle", { "seori.group": "other" }); // another instance's group: not this home's business
    const passes = Math.ceil(UNOWNED_AFTER_MS / MIN); // first seen on the first pass, told once 5 min have gone by
    for (let i = 0; i < passes; i++) expect(await pass()).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(await pass()).toEqual([{ pane: "hc:t9", action: "unregistered" }]);
    expect(lead.received).toEqual([unownedText(paneRef("t9"), "omp", UNOWNED_AFTER_MS / MIN)]);
    await pass();
    expect(lead.received).toHaveLength(1);
  });

  test("a session that becomes a lane before the wait ends is never told", async () => {
    const { w, d, lead, pass } = setup();
    w.addPane("t9", "idle");
    await pass();
    await pass();
    d.store.saveLane({
      key: "fix-b", sessionRef: paneRef("t9"), paneId: "t9", tabId: "w1:t9", brief: "/dev/null", cwd: "/repo", status: "working",
      createdAt: w.clock, lastActivityAt: w.clock, nudges: 0, log: [],
    });
    for (let i = 0; i < 10; i++) await pass();
    expect(lead.received).toEqual([]);
  });

  test("a shell terminal (hc lists its program as agent, but nothing reports) is not an unowned agent session", async () => {
    const { w, lead, pass } = setup();
    w.addPane("t9", "shell");
    for (let i = 0; i < 10; i++) await pass();
    expect(lead.received).toEqual([]);
  });

  test("with no lead recorded an unowned session is not marked told; it is told once a lead is recorded", async () => {
    const { w, d, lead, pass } = setup();
    writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ duty: "hc:t2" })); // no lead recorded
    w.addPane("t9", "idle");
    for (let i = 0; i < 8; i++) await pass();
    d.store.setRole("lead", paneRef("t1"));
    expect(await pass()).toEqual([{ pane: "hc:t9", action: "unregistered" }]);
    expect(lead.received).toHaveLength(1);
  });
});
