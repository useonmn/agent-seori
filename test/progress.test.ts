import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { SendUncertain } from "../src/messenger/adapter.ts";
import { progressTick, progressText, scrubForOwner, threadTarget } from "../src/progress.ts";
import type { Lane } from "../src/store.ts";
import { World } from "./fake.ts";

const MIN = 60_000;
const FAKE = { source: "fake", owner: "u1" };

function setup() {
  const w = new World();
  const d = w.deps();
  w.messengers(d.store.root, [FAKE]);
  const lane = (over: Partial<Lane> = {}): Lane => {
    const l: Lane = {
      key: "fix-a", paneId: "w1:p9", tabId: "w1:t9", brief: "b", cwd: "/tmp", status: "working",
      createdAt: w.clock, lastActivityAt: w.clock, nudges: 0, thread: "fake:c1:m1",
      log: [{ at: w.clock, kind: "start", text: "started" }], ...over,
    };
    d.store.saveLane(l);
    return l;
  };
  const reportNow = (text: string): void => {
    const l = d.store.lane("fix-a")!;
    l.log.push({ at: w.clock, kind: "report", text });
    d.store.saveLane(l);
  };
  return { w, d, lane, reportNow };
}

describe("scrubForOwner", () => {
  test("home becomes ~ and pane ids become <pane>", () => {
    const h = join(tmpdir(), "owner-home");
    expect(scrubForOwner(`edited ${h}/dev/x.ts in w1:p12 (also ${h})`, h)).toBe("edited ~/dev/x.ts in <pane> (also ~)");
    expect(progressText("k", `at ${h}/`, `${h}/`)).toBe("[k] at ~/");
    expect(scrubForOwner("lane in wC:p1 and wE:p2b", "/x")).toBe("lane in <pane> and <pane>");
  });
});

describe("threadTarget", () => {
  test("uses the lead channel row (topic/thread) when it is there", () => {
    const { d } = setup();
    new Channel(d.store.root).appendInbound({ id: "fake:c1:m1", kind: "messenger", source: "fake", chat: "c1", thread: "t7", from: "u1", at: 1, text: "hi" });
    expect(threadTarget(d.store.root, "fake:c1:m1")).toEqual({ source: "fake", target: { chat: "c1", thread: "t7", replyTo: "m1" } });
  });
  test("else splits the id; a message id may contain colons", () => {
    const { d } = setup();
    expect(threadTarget(d.store.root, "slack:C9:1.2:3")).toEqual({ source: "slack", target: { chat: "C9", replyTo: "1.2:3" } });
    expect(threadTarget(d.store.root, "fake:c1")).toBeUndefined();
  });
});

describe("progressTick", () => {
  test("posts a new report once progressEveryMin has passed since the lane started, then waits for the next change", async () => {
    const { w, d, lane, reportNow } = setup();
    lane();
    reportNow("tests pass in w1:p9");
    w.clock += 14 * MIN;
    expect(await progressTick(d)).toEqual([]);
    w.clock += MIN;
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "posted" }]);
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0]!.config).toEqual(FAKE);
    expect(w.notified[0]!.target).toEqual({ chat: "c1", replyTo: "m1" });
    expect(w.notified[0]!.text).toBe("[fix-a] tests pass in <pane>");
    const l = d.store.lane("fix-a")!;
    expect(l.posted).toEqual({ at: w.clock, text: "tests pass in w1:p9" });
    expect(l.log.at(-1)).toEqual({ at: w.clock, kind: "posted", text: "to fake:c1:m1" });

    // same report: never posted again
    w.clock += 60 * MIN;
    expect(await progressTick(d)).toEqual([]);
    // a new report: posted once progressEveryMin has passed since the last post
    reportNow("PR opened");
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "posted" }]);
    expect(w.notified.at(-1)!.text).toBe("[fix-a] PR opened");
    reportNow("CI green");
    w.clock += 5 * MIN;
    expect(await progressTick(d)).toEqual([]);
  });

  test("respects config.progressEveryMin", async () => {
    const { w, d, lane, reportNow } = setup();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ progressEveryMin: 2 }));
    lane();
    reportNow("halfway");
    w.clock += 2 * MIN;
    expect((await progressTick(d)).map((e) => e.action)).toEqual(["posted"]);
  });

  test("skips lanes without a thread, without a report, or not working/waiting", async () => {
    const { w, d, lane } = setup();
    lane({ key: "a", thread: undefined, log: [{ at: w.clock, kind: "report", text: "x" }] });
    lane({ key: "b" });
    lane({ key: "c", status: "paused", log: [{ at: w.clock, kind: "report", text: "x" }] });
    lane({ key: "d", status: "ready", log: [{ at: w.clock, kind: "report", text: "x" }] });
    lane({ key: "e", status: "waiting", log: [{ at: w.clock, kind: "report", text: "y" }] });
    w.clock += 15 * MIN;
    expect(await progressTick(d)).toEqual([{ lane: "e", action: "posted" }]);
  });

  test("an uncertain send counts as posted; a definite failure retries next tick", async () => {
    const { w, d, lane, reportNow } = setup();
    lane();
    reportNow("one");
    w.clock += 15 * MIN;
    w.notifyFails.push(new Error("network down"));
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "post-failed", detail: "network down" }]);
    expect(d.store.lane("fix-a")!.posted).toBeUndefined();
    w.notifyFails.push(new SendUncertain("timed out after send"));
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "post-uncertain", detail: "timed out after send" }]);
    expect(d.store.lane("fix-a")!.posted?.text).toBe("one");
    expect(await progressTick(d)).toEqual([]);
  });

  test("keeps a report the lane sent while the post was in flight", async () => {
    const { w, d, lane, reportNow } = setup();
    lane();
    reportNow("one");
    w.clock += 15 * MIN;
    const base = d.notify;
    const racing = { ...d, notify: async (...a: Parameters<typeof base>) => { reportNow("two"); await base(...a); } };
    await progressTick(racing);
    expect(d.store.lane("fix-a")!.log.filter((e) => e.kind === "report").map((e) => e.text)).toEqual(["one", "two"]);
  });

  test("names a missing messenger and a malformed thread", async () => {
    const { w, d, lane } = setup();
    lane({ key: "a", thread: "telegram:5:6", log: [{ at: w.clock, kind: "report", text: "x" }] });
    lane({ key: "b", thread: "bad", log: [{ at: w.clock, kind: "report", text: "x" }] });
    w.clock += 15 * MIN;
    expect(await progressTick(d)).toEqual([
      { lane: "a", action: "post-failed", detail: "no messenger configured for source telegram" },
      { lane: "b", action: "post-failed", detail: "thread bad is not <source>:<chat>:<message id>" },
    ]);
  });
});
