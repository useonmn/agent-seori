import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { BLOCKED_PROMPT_MINUTES, dutyTick, send, startLane } from "../src/harness.ts";
import { interactiveShellInFront } from "../src/runtime/foreground.ts";
import { World, paneRef } from "./fake.ts";

// A pane whose agent shows a dialog (a tool approval) reads `blocked`: text typed there goes into the dialog and the
// Enter after it could approve it.
function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", paneRef("t1"));
  return { w, d, lead };
}

/** Keys pressed, or text typed with no status gate (hc send without --if). */
const keystrokes = (w: World, pane: string) =>
  w.calls.filter((c) => c.cmd === "hc" && c.argv[2] === pane && (c.argv[1] === "keys" || (c.argv[1] === "send" && !c.argv.includes("--if"))));
const prompts = (w: World, pane: string) => w.calls.filter((c) => c.cmd === "hc" && c.argv[1] === "send" && c.argv[2] === pane);

describe("delivery never types into a pane with an open dialog (B1)", () => {

  test("a dialog opens between the flush's status read and deliver -> no prompt, no keystrokes, QUEUED", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "idle");
    w.getHook.set("t7", (n) => { if (n >= 2) pane.status = "blocked"; });
    expect(await send(d, "hc:t7", "yes", "cli")).toBe("QUEUED");
    expect(prompts(w, "t7")).toEqual([]);
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(pane.received).toEqual([]);
  });

  test("once the dialog is closed, the duty loop delivers the queued message", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "blocked");
    expect(await send(d, "hc:t7", "hello", "cli")).toBe("QUEUED");
    pane.status = "idle";
    await dutyTick(d);
    expect(pane.received).toEqual(["hello"]);
  });
});

describe("a lane stuck on a dialog is told to the lead once (B2)", () => {
  async function blockedLane() {
    const s = setup();
    const brief = `${s.d.store.root}/brief.md`;
    await Bun.write(brief, "Fix it.");
    const lane = await startLane(s.d, "lane-a", brief, {});
    const pane = s.w.panes.get(lane.paneId)!;
    pane.status = "blocked";
    pane.received.length = 0;
    s.lead.received.length = 0;
    s.w.calls.length = 0; // the agent start typed `omp` at the shell; only what duty does from here counts
    return { ...s, lane, pane };
  }
  const toldLead = (lead: { received: string[] }) => lead.received.filter((t) => t.includes("[BLOCKED-PROMPT lane-a]"));

  test(`blocked for ${BLOCKED_PROMPT_MINUTES} min -> one [BLOCKED-PROMPT] to the lead, nothing to the lane, never repeated`, async () => {
    const { w, d, lead, lane, pane } = await blockedLane();
    await dutyTick(d);
    expect(d.store.lane("lane-a")?.blockedSince).toBe(w.clock);
    w.clock += (BLOCKED_PROMPT_MINUTES * 60_000) - 1;
    await dutyTick(d);
    expect(toldLead(lead)).toEqual([]);
    w.clock += 1;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "lane-a", action: "blocked-prompt", detail: `${BLOCKED_PROMPT_MINUTES} min` });
    expect(toldLead(lead)).toHaveLength(1);
    expect(toldLead(lead)[0]).toContain(`pane hc:${lane.paneId} waits on a dialog`);
    w.clock += 60 * 60_000;
    await dutyTick(d);
    expect(toldLead(lead)).toHaveLength(1);
    expect(pane.received).toEqual([]);
    expect(keystrokes(w, lane.paneId)).toEqual([]);
    expect(d.store.lane("lane-a")?.log.filter((e) => e.kind === "blocked")).toHaveLength(1);
  });

  test("the dialog closes: blockedSince is cleared, and a later dialog is a new spell told again", async () => {
    const { w, d, lead, pane } = await blockedLane();
    await dutyTick(d);
    w.clock += BLOCKED_PROMPT_MINUTES * 60_000;
    await dutyTick(d);
    expect(toldLead(lead)).toHaveLength(1);
    pane.status = "working";
    await dutyTick(d);
    expect(d.store.lane("lane-a")?.blockedSince).toBeUndefined();
    pane.status = "blocked";
    w.clock += 1;
    await dutyTick(d);
    w.clock += BLOCKED_PROMPT_MINUTES * 60_000;
    await dutyTick(d);
    expect(toldLead(lead)).toHaveLength(2);
  });

  test("config.json blockedPromptMin sets the wait: 0.5 -> told after 30 s, not before", async () => {
    const { w, d, lead } = await blockedLane();
    await Bun.write(`${d.store.root}/config.json`, JSON.stringify({ blockedPromptMin: 0.5 }));
    await dutyTick(d);
    w.clock += 29_999;
    await dutyTick(d);
    expect(toldLead(lead)).toEqual([]);
    w.clock += 1;
    expect(await dutyTick(d)).toContainEqual({ lane: "lane-a", action: "blocked-prompt", detail: "30 s" });
    expect(toldLead(lead)).toHaveLength(1);
  });

  test("a blocked lane is not nudged however long it stays silent", async () => {
    const { w, d, pane } = await blockedLane();
    w.clock += 120 * 60_000;
    await dutyTick(d);
    w.clock += 120 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.action.startsWith("nudge") || e.action === "escalated")).toEqual([]);
    expect(pane.received).toEqual([]);
  });
});
