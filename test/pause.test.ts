import { describe, expect, test } from "bun:test";
import { Refusal } from "../src/harness.ts";
import { ESCAPE_WATCH_MS, pauseLane, READ_BACK_TRIES, resumeLane, Unverified } from "../src/pause.ts";
import type { Lane, LaneStatus } from "../src/store.ts";
import { World } from "./fake.ts";

const noSleep = { sleep: async () => {} };

function setup(status: LaneStatus = "working", extra: Partial<Lane> = {}) {
  const w = new World();
  const d = w.deps();
  w.addPane("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
  const pane = w.addPane("w1:p5", "idle");
  pane.agent = "omp";
  pane.screen = ["some output"];
  d.store.saveLane({
    key: "fix-a", paneId: "w1:p5", tabId: "w1:t5", brief: "/dev/null", cwd: "/", status,
    createdAt: 0, lastActivityAt: 0, nudges: 2, log: [], ...extra,
  });
  const reads = () => w.calls.filter((c) => c.argv[0] === "pane" && c.argv[1] === "read").length;
  const keys = () => w.calls.filter((c) => c.argv[0] === "pane" && c.argv[1] === "send-keys").map((c) => c.argv.slice(2));
  return { w, d, pane, reads, keys };
}

describe("seori pause", () => {
  test("a working lane: /goal pause goes in, omp's status line confirms it, the lane is paused and logged", async () => {
    const { w, d, pane, keys } = setup();
    pane.onPrompt = (text) => { if (text === "/goal pause") pane.screen!.push("", " Goal mode paused."); };
    w.clock = 5_000;
    const out = await pauseLane(d, "fix-a", "owner said wait", noSleep);
    expect(out.lines).toEqual(["PAUSED fix-a goal paused"]);
    expect(pane.received).toEqual(["/goal pause"]);
    expect(keys()).toEqual([]);
    const lane = d.store.lane("fix-a")!;
    expect(lane.status).toBe("paused");
    expect(lane.pausedFrom).toBe("working");
    expect(lane.log.at(-1)).toEqual({ at: 5_000, kind: "pause", text: "owner said wait" });
  });

  test("the read-back uses recent-unwrapped lines of the lane's pane", async () => {
    const { w, d, pane } = setup();
    pane.onPrompt = () => pane.screen!.push(" Goal mode paused.");
    await pauseLane(d, "fix-a", undefined, noSleep);
    const read = w.calls.find((c) => c.argv[1] === "read")!;
    expect(read.argv).toEqual(["pane", "read", "w1:p5", "--source", "recent-unwrapped", "--lines", "200"]);
    expect(d.store.lane("fix-a")!.log.at(-1)!.text).toBe("paused");
  });

  test("a turn still running after the goal is paused is interrupted with Escape, after the goal", async () => {
    const { w, d, pane, keys } = setup();
    pane.status = "working";
    pane.onPrompt = () => pane.screen!.push(" Goal mode paused.");
    const out = await pauseLane(d, "fix-a", undefined, noSleep);
    expect(out.lines).toEqual(["PAUSED fix-a goal paused, running turn interrupted"]);
    expect(keys()).toEqual([["w1:p5", "esc"]]);
    const prompt = w.calls.findIndex((c) => c.argv[0] === "agent" && c.argv[1] === "prompt");
    const esc = w.calls.findIndex((c) => c.argv[1] === "send-keys");
    expect(prompt).toBeLessThan(esc);
  });

  test("a failed Escape still leaves the lane paused and says so", async () => {
    const { w, d, pane } = setup();
    pane.status = "working";
    pane.onPrompt = () => pane.screen!.push(" Goal mode paused.");
    w.keyFails = 1;
    const out = await pauseLane(d, "fix-a", undefined, noSleep);
    expect(out.lines).toEqual(["PAUSED fix-a goal paused; the running turn could not be interrupted (key press failed)"]);
    expect(d.store.lane("fix-a")!.status).toBe("paused");
  });

  test("omp's warning that there is no active goal also confirms: nothing can auto-continue", async () => {
    const { d, pane } = setup("waiting");
    pane.onPrompt = () => pane.screen!.push(" Warning: No active goal to pause.");
    await pauseLane(d, "fix-a", undefined, noSleep);
    const lane = d.store.lane("fix-a")!;
    expect(lane.status).toBe("paused");
    expect(lane.pausedFrom).toBe("waiting");
  });

  test("a status line already on screen before the command proves nothing: PAUSE_UNVERIFIED, lane unchanged", async () => {
    const { d, pane, reads } = setup();
    pane.screen = [" Goal mode paused."];
    const err = await pauseLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unverified);
    expect((err as Error).message).toBe("PAUSE_UNVERIFIED fix-a /goal pause unconfirmed; lane left working");
    expect(reads()).toBe(1 + READ_BACK_TRIES);
    expect(d.store.lane("fix-a")!.status).toBe("working");
  });

  test("lane output that only mentions the words is not a confirmation", async () => {
    const { d, pane } = setup();
    pane.onPrompt = () => pane.screen!.push("echo 'Goal mode paused.'", "  > Goal mode paused. (quoted)");
    expect(await pauseLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e)).toBeInstanceOf(Unverified);
  });

  test("a pane with no agent gets nothing typed: PAUSE_UNVERIFIED", async () => {
    const { d, pane } = setup();
    pane.status = "shell";
    const err = await pauseLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e);
    expect((err as Error).message).toBe("PAUSE_UNVERIFIED fix-a /goal pause no agent; lane left working");
    expect(pane.received).toEqual([]);
  });

  test("an uncertain delivery is read back like a sure one; unconfirmed stays unverified", async () => {
    const { w, d } = setup();
    w.promptFails.set("w1:p5", "timeout");
    const err = await pauseLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unverified);
  });

  test("an already paused lane is reported and nothing is sent; a closed lane is refused", async () => {
    const paused = setup("paused");
    expect((await pauseLane(paused.d, "fix-a", undefined, noSleep)).lines).toEqual(["PAUSED fix-a already"]);
    expect(paused.pane.received).toEqual([]);
    const closed = setup("done");
    expect(await pauseLane(closed.d, "fix-a", undefined, noSleep).catch((e: unknown) => e)).toBeInstanceOf(Refusal);
    expect(await pauseLane(closed.d, "nope", undefined, noSleep).catch((e: unknown) => e)).toBeInstanceOf(Refusal);
  });

  test("a ready lane can be paused and returns to ready", async () => {
    const { d, pane } = setup("ready");
    pane.onPrompt = (t) => pane.screen!.push(t === "/goal pause" ? " Warning: No active goal to pause." : " Goal mode resumed.");
    await pauseLane(d, "fix-a", undefined, noSleep);
    expect((await resumeLane(d, "fix-a", undefined, noSleep)).lines).toEqual(["RESUMED fix-a as ready, goal resumed"]);
  });

  test("a turn that starts just after the goal is paused is still interrupted, once, within the watch window", async () => {
    const { d, pane, keys } = setup();
    pane.onPrompt = () => pane.screen!.push(" Goal mode paused.");
    // herdr read idle when the pause was confirmed (the kickoff turn's first second); the turn shows up a moment later.
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); if (slept.length === 2) pane.status = "working"; };
    const out = await pauseLane(d, "fix-a", undefined, { sleep });
    expect(out.lines).toEqual(["PAUSED fix-a goal paused, running turn interrupted"]);
    expect(keys()).toEqual([["w1:p5", "esc"]]);
    expect(d.store.lane("fix-a")!.status).toBe("paused");
  });

  test("a pane that stays idle through the watch window gets no Escape; the window is about 3 s", async () => {
    const { d, pane, keys } = setup();
    pane.onPrompt = () => pane.screen!.push(" Goal mode paused.");
    const slept: number[] = [];
    const out = await pauseLane(d, "fix-a", undefined, { sleep: async (ms) => { slept.push(ms); } });
    expect(out.lines).toEqual(["PAUSED fix-a goal paused"]);
    expect(keys()).toEqual([]);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(ESCAPE_WATCH_MS);
  });

  test("a lane closed while the pause was read back stays closed: refused, not reopened as paused", async () => {
    const { d, pane } = setup("ready");
    pane.onPrompt = () => {
      d.store.saveLane({ ...d.store.lane("fix-a")!, status: "done" });
      pane.screen!.push(" Goal mode paused.");
    };
    const err = await pauseLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toBe("lane fix-a is now done; it was not marked paused");
    expect(d.store.lane("fix-a")!.status).toBe("done");
    expect(d.store.lane("fix-a")!.pausedFrom).toBeUndefined();
  });

  test("a gone pane is a clear refusal and nothing is sent", async () => {
    const { w, d } = setup();
    w.panes.delete("w1:p5");
    const err = await pauseLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toBe("lane fix-a's pane w1:p5 is gone; nothing to pause");
    expect(d.store.lane("fix-a")!.status).toBe("working");
  });

  test("a pane that vanishes during the read-back is a clear refusal too", async () => {
    const { w, d, pane } = setup();
    pane.onPrompt = () => { w.panes.delete("w1:p5"); };
    const err = await pauseLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toBe("lane fix-a's pane w1:p5 is gone; nothing to pause");
  });
});

describe("seori resume", () => {
  test("/goal resume confirmed: status before the pause back, quiet time restarted, paused marks dropped", async () => {
    const { w, d, pane } = setup("paused", { pausedFrom: "waiting", alerts: { "paused-seen-working": 1, "working-while-paused": 2, "ceiling:tokens:5": 3 } });
    pane.onPrompt = (text) => { if (text === "/goal resume") pane.screen!.push("", " Goal mode resumed."); };
    w.clock = 9_000;
    const out = await resumeLane(d, "fix-a", "go on", noSleep);
    expect(out.lines).toEqual(["RESUMED fix-a as waiting, goal resumed"]);
    expect(pane.received).toEqual(["/goal resume"]);
    const lane = d.store.lane("fix-a")!;
    expect(lane.status).toBe("waiting");
    expect(lane.pausedFrom).toBeUndefined();
    expect(lane.lastActivityAt).toBe(9_000);
    expect(lane.nudges).toBe(0);
    expect(lane.alerts).toEqual({ "ceiling:tokens:5": 3 });
    expect(lane.log.at(-1)).toEqual({ at: 9_000, kind: "resume", text: "go on" });
  });

  test("no pausedFrom recorded: back to working", async () => {
    const { d, pane } = setup("paused");
    pane.onPrompt = () => pane.screen!.push(" Warning: No paused goal to resume.");
    await resumeLane(d, "fix-a", undefined, noSleep);
    expect(d.store.lane("fix-a")!.status).toBe("working");
  });

  test("unconfirmed: RESUME_UNVERIFIED and the lane stays paused", async () => {
    const { d } = setup("paused", { pausedFrom: "working" });
    const err = await resumeLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unverified);
    expect((err as Error).message).toBe("RESUME_UNVERIFIED fix-a /goal resume unconfirmed; lane left paused");
    expect(d.store.lane("fix-a")!.status).toBe("paused");
  });

  test("a lane that is not paused is refused", async () => {
    const { d, pane } = setup("working");
    expect(await resumeLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e)).toBeInstanceOf(Refusal);
    expect(pane.received).toEqual([]);
  });

  test("a gone pane is a clear refusal and the lane stays paused for duty to mark lost", async () => {
    const { w, d } = setup("paused", { pausedFrom: "working" });
    w.panes.delete("w1:p5");
    const err = await resumeLane(d, "fix-a", undefined, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toBe("lane fix-a's pane w1:p5 is gone; nothing to resume (duty marks the lane lost)");
    expect(d.store.lane("fix-a")!.status).toBe("paused");
  });
});
