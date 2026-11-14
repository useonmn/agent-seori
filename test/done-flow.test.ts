import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { autoCloseTick, objectDone } from "../src/done-flow.ts";
import { done, ready, Refusal, startLane } from "../src/harness.ts";
import { addLesson } from "../src/lessons.ts";
import type { SignalIo } from "../src/signals.ts";
import { World, paneRef } from "./fake.ts";

const MERGED = '{"state":"MERGED","mergeCommit":{"oid":"abc123"}}';

/** A lead pane, a brief, a work dir that is a clean git checkout with no remote, and PR o/r#1 open until `merged`. */
function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", paneRef("t1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  const cwd = join(d.store.root, "work");
  mkdirSync(cwd);
  const state = { merged: false, dirty: "" };
  w.gh = () => ({ code: 0, stdout: state.merged ? MERGED : '{"state":"OPEN","mergeCommit":null}' });
  // Every command that is neither gh nor hc reaches World.reviewer: here, git.
  w.reviewer = (argv) => {
    const verb = argv[2];
    if (verb === "rev-parse") return { code: 0, stdout: "true\n" };
    if (verb === "worktree") return { code: 0, stdout: `worktree ${cwd}\nbranch refs/heads/main\n` };
    if (verb === "status") return { code: 0, stdout: state.dirty };
    return { code: 0, stdout: "" };
  };
  return { w, d, lead, brief, cwd, state };
}

const noIo: SignalIo = {
  run: async () => ({ code: 1, stdout: "", stderr: "unexpected command" }),
  get: async () => ({ status: 599, body: "" }),
};

describe("start with a Done line", () => {
  test("stores the Done line, thread and ceilings, and the footer states the line and the close rule", async () => {
    const { d, brief, cwd } = setup();
    const ceilings = { wallMinutes: 90, tokens: null, costUsd: 5 };
    new Channel(d.store.root).appendInbound({ id: "telegram:42:5", kind: "messenger", source: "telegram", chat: "42", from: "42", at: 1, text: "fix login" });
    const lane = await startLane(d, "fix-login", brief, { cwd, done: "Done = merged o/r#1", thread: "telegram:42:5", ceilings });
    expect(lane.done).toBe("merged o/r#1");
    expect(lane.thread).toBe("telegram:42:5");
    expect(lane.ceilings).toEqual(ceilings);
    expect(d.store.lane("fix-login")!.done).toBe("merged o/r#1");
    const text = readFileSync(lane.brief, "utf8");
    expect(text).toContain("`Done = merged o/r#1`");
    expect(text).toContain("closes this lane 5 min after READY unless the lead objects");
    expect(text).toContain("`[LEAD] not done: <reasons>`");
    expect(text).not.toContain("{{");
  });

  test("stores --activity-path values on the lane; none stores nothing", async () => {
    const { d, brief, cwd } = setup();
    const lane = await startLane(d, "fix-login", brief, { cwd, activityPaths: ["out", "/data/run.log"] });
    expect(d.store.lane(lane.key)!.activityPaths).toEqual(["out", "/data/run.log"]);
    const plain = await startLane(d, "fix-other", brief, { cwd, activityPaths: [] });
    expect("activityPaths" in d.store.lane(plain.key)!).toBe(false);
    await expect(startLane(d, "fix-empty", brief, { cwd, activityPaths: ["out", " "] })).rejects.toThrow("--activity-path needs a path");
    expect(d.store.lane("fix-empty")).toBeUndefined();
  });

  test("closeAfterMin comes from config.json", async () => {
    const { d, brief, cwd } = setup();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ closeAfterMin: 12 }));
    const lane = await startLane(d, "fix-login", brief, { cwd, done: "merged o/r#1" });
    expect(readFileSync(lane.brief, "utf8")).toContain("12 min after READY");
  });

  test("a lane without a Done line keeps the lead-closes rule", async () => {
    const { d, brief, cwd } = setup();
    const lane = await startLane(d, "fix-login", brief, { cwd });
    expect(lane.done).toBeUndefined();
    expect(readFileSync(lane.brief, "utf8")).toContain("8. Never close your own pane. The lead closes it with `seori done fix-login`.");
  });

  test("a bad Done line is refused before any terminal opens", async () => {
    const { w, d, brief } = setup();
    await expect(startLane(d, "fix-login", brief, { done: "tests pass" })).rejects.toThrow(Refusal);
    await expect(startLane(d, "fix-login", brief, { done: "" })).rejects.toThrow("empty Done line");
    expect(w.calls.some((c) => c.argv[1] === "run")).toBe(false);
    expect(d.store.lane("fix-login")).toBeUndefined();
  });

  test("lessons for the repo go above the brief, exactly once on a retry with the written brief", async () => {
    const { d, brief, cwd } = setup();
    addLesson(d.store.root, { cwd, rule: "run bun test twice", evidence: "/tmp/log" }, 1000);
    const lane = await startLane(d, "fix-login", brief, { cwd });
    const first = readFileSync(lane.brief, "utf8");
    expect(first).toStartWith("## Lessons for this repo\n- [pending; lead] run bun test twice\n\nFix the flaky login test.\n\n## Lane rules");
    d.store.saveLane({ ...d.store.lane("fix-login")!, status: "lost" });
    await startLane(d, "fix-login", lane.brief, { cwd });
    expect(readFileSync(lane.brief, "utf8")).toBe(first);
  });
});

describe("ready and objections", () => {
  test("READY on a Done lane tells the lead how to object and the lane when it closes; a new READY clears the objection", async () => {
    const { d, lead, brief, cwd, w } = setup();
    const lane = await startLane(d, "fix-login", brief, { cwd, done: "merged o/r#1" });
    const pane = w.panes.get(lane.paneId)!;
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe(
      "[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1\n" +
        "closes in 5 min after its Done signals read back live, unless you object: seori object fix-login --reason '<why>'",
    );
    expect(pane.received.at(-1)).toBe("[LEAD] claim recorded; the lane closes in 5 min unless the lead objects");

    w.clock += 60_000;
    expect(await objectDone(d, "fix-login", ["CI is red", " ", "no test"])).toBe("DELIVERED");
    const objected = d.store.lane("fix-login")!;
    expect(objected.status).toBe("working");
    expect(objected.objection).toEqual({ at: w.clock, reasons: ["CI is red", "no test"] });
    expect(objected.lastActivityAt).toBe(w.clock);
    expect(objected.log.at(-1)).toEqual({ at: w.clock, kind: "object", text: "CI is red; no test" });
    expect(pane.received.at(-1)).toBe("[LEAD] not done: CI is red; no test; keep working and send ready again when fixed");
    await expect(objectDone(d, "fix-login", ["again"])).rejects.toThrow("not ready: there is no claim to object to");

    await ready(d, "fix-login", "fixed for real", ["https://github.com/o/r/pull/1"]);
    expect(d.store.lane("fix-login")!.objection).toBeUndefined();
  });

  test("READY on a lane without a Done line keeps the old message and tells the lane nothing", async () => {
    const { d, lead, brief, cwd, w } = setup();
    const lane = await startLane(d, "fix-login", brief, { cwd });
    const before = w.panes.get(lane.paneId)!.received.length;
    await ready(d, "fix-login", "fixed", ["e"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: e");
    expect(w.panes.get(lane.paneId)!.received.length).toBe(before);
  });

  test("an objection needs a reason and a lane", async () => {
    const { d } = setup();
    await expect(objectDone(d, "nope", [])).rejects.toThrow("at least one --reason");
    await expect(objectDone(d, "nope", ["x"])).rejects.toThrow("no lane nope");
  });
});

describe("done", () => {
  test("refuses a Done lane while a signal is not live or work is uncommitted, listing every reason; closes once both hold", async () => {
    const { d, brief, cwd, w, state } = setup();
    const lane = await startLane(d, "fix-login", brief, { cwd, done: "merged o/r#1; file out.txt" });
    await ready(d, "fix-login", "fixed", ["e"]);
    state.dirty = " M src/a.ts\n";
    await expect(done(d, "fix-login")).rejects.toThrow(
      `lane fix-login is not done:\n- merged o/r#1 -> state OPEN\n- file out.txt -> missing: ${join(cwd, "out.txt")}\n- uncommitted tracked changes in ${cwd}`,
    );
    expect(w.panes.has(lane.paneId)).toBe(true);
    state.merged = true;
    state.dirty = "";
    writeFileSync(join(cwd, "out.txt"), "x");
    await done(d, "fix-login");
    expect(w.panes.has(lane.paneId)).toBe(false);
    const closed = d.store.lane("fix-login")!;
    expect(closed.status).toBe("done");
    expect(closed.log.at(-1)!.text).toBe("closed by lead: every Done signal read back live");
  });

  test("a lane objected to while its signals were read is not closed", async () => {
    const { d, brief, cwd, w, state } = setup();
    const lane = await startLane(d, "fix-login", brief, { cwd, done: "merged o/r#1" });
    await ready(d, "fix-login", "fixed", ["e"]);
    w.gh = () => {
      void objectDone(d, "fix-login", ["CI is red on main"]);
      return { code: 0, stdout: MERGED };
    };
    state.merged = true;
    await expect(done(d, "fix-login")).rejects.toThrow("lane fix-login changed while it was being checked (now working); run done again");
    expect(w.panes.has(lane.paneId)).toBe(true);
    const now = d.store.lane("fix-login")!;
    expect(now.status).toBe("working");
    expect(now.objection!.reasons).toEqual(["CI is red on main"]);
  });
});

describe("autoCloseTick", () => {
  async function claimed(over: { done?: string } = {}) {
    const s = setup();
    const lane = await startLane(s.d, "fix-login", s.brief, { cwd: s.cwd, ...("done" in over ? (over.done === undefined ? {} : { done: over.done }) : { done: "merged o/r#1" }) });
    await ready(s.d, "fix-login", "fixed", ["e"]);
    return { ...s, lane, pane: s.w.panes.get(lane.paneId)! };
  }

  test("does nothing before closeAfterMin, then closes a lane whose signals read back live and tells the lead", async () => {
    const { d, w, lead, lane, state } = await claimed();
    state.merged = true;
    w.clock += 5 * 60_000 - 1;
    expect(await autoCloseTick(d, noIo)).toEqual([]);
    w.clock += 1;
    expect(await autoCloseTick(d, noIo)).toEqual([{ lane: "fix-login", action: "closed" }]);
    expect(w.panes.has(lane.paneId)).toBe(false);
    const closed = d.store.lane("fix-login")!;
    expect(closed.status).toBe("done");
    expect(closed.log.at(-1)).toEqual({ at: w.clock, kind: "done", text: "closed 5 min after READY: every Done signal read back live" });
    expect(lead.received.at(-1)).toBe("[CLOSED fix-login] closed 5 min after READY: every Done signal reads back live");
    expect(await autoCloseTick(d, noIo)).toEqual([]);
  });

  test("a failed check objects to the claim with the reasons and tells the lead NOT-DONE", async () => {
    const { d, w, lead, pane } = await claimed();
    w.clock += 5 * 60_000;
    expect(await autoCloseTick(d, noIo)).toEqual([{ lane: "fix-login", action: "not-done", detail: "merged o/r#1 -> state OPEN" }]);
    const lane = d.store.lane("fix-login")!;
    expect(lane.status).toBe("working");
    expect(lane.objection!.reasons).toEqual(["merged o/r#1 -> state OPEN"]);
    expect(pane.received.at(-1)).toBe("[LEAD] not done: merged o/r#1 -> state OPEN; keep working and send ready again when fixed");
    expect(lead.received.at(-1)).toBe("[NOT-DONE fix-login] merged o/r#1 -> state OPEN");
  });

  test("a failed check on a lane whose pane is gone (a restart closed it) keeps the claim, tells NOT-DONE once, closes once live", async () => {
    const { d, w, lead, lane, state } = await claimed();
    w.panes.delete(lane.paneId);
    w.clock += 5 * 60_000;
    const deferred = [{ lane: "fix-login", action: "close-deferred", detail: "pane is gone; merged o/r#1 -> state OPEN" }];
    expect(await autoCloseTick(d, noIo)).toEqual(deferred);
    // No objection: one to a gone pane could not be delivered and would make the lane working, then lost.
    expect(d.store.lane("fix-login")).toMatchObject({ status: "ready" });
    expect(d.store.lane("fix-login")!.objection).toBeUndefined();
    expect(d.store.inboxPanes()).toEqual([]);
    const told = lead.received.at(-1)!;
    expect(told).toStartWith("[NOT-DONE fix-login] merged o/r#1 -> state OPEN. Its pane is gone, so it stays ready");
    expect(told).toContain(`resume it with: ${d.seoriCmd} start fix-login`);
    const count = lead.received.length;
    // Read again only every closeAfterMin, not every pass: a signal may run a command or call gh.
    expect(await autoCloseTick(d, noIo)).toEqual([]);
    w.clock += 5 * 60_000;
    expect(await autoCloseTick(d, noIo)).toEqual(deferred);
    expect(lead.received).toHaveLength(count);
    // The lead merged: the next read closes it with no pane at all.
    state.merged = true;
    w.clock += 5 * 60_000;
    expect(await autoCloseTick(d, noIo)).toEqual([{ lane: "fix-login", action: "closed" }]);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });

  test("a NOT-DONE for a gone pane that could not be delivered is told again on the next pass", async () => {
    const { d, w, lead, lane } = await claimed();
    w.panes.delete(lane.paneId);
    w.clock += 5 * 60_000;
    w.promptFails.set("t1", "lead exploded");
    expect(await autoCloseTick(d, noIo)).toContainEqual(expect.objectContaining({ lane: "fix-login", action: "autoclose-failed" }));
    expect(lead.received.some((m) => m.includes("[NOT-DONE fix-login]"))).toBe(false);
    w.promptFails.delete("t1");
    await autoCloseTick(d, noIo);
    // Delivered in the next batch to the lead (with the notice about the uncertain first delivery).
    expect(lead.received.some((m) => m.includes("[NOT-DONE fix-login] merged o/r#1 -> state OPEN. Its pane is gone"))).toBe(true);
    expect(d.store.lane("fix-login")!.status).toBe("ready");
  });

  test("an objection to a lane whose pane is gone is refused and leaves the claim as it was", async () => {
    const { d, w, lane } = await claimed();
    w.panes.delete(lane.paneId);
    await expect(objectDone(d, "fix-login", ["more tests"])).rejects.toThrow(/pane hc:\S+ is gone, so an objection cannot reach it; it stays ready.*start it again: seori start fix-login/);
    expect(d.store.lane("fix-login")).toMatchObject({ status: "ready" });
    expect(d.store.lane("fix-login")!.objection).toBeUndefined();
  });

  test("a pane still working or behind a dialog is left for a later pass", async () => {
    const { d, w, pane, state } = await claimed();
    state.merged = true;
    w.clock += 10 * 60_000;
    pane.status = "working";
    expect(await autoCloseTick(d, noIo)).toEqual([{ lane: "fix-login", action: "close-deferred", detail: "pane is working" }]);
    expect(d.store.lane("fix-login")!.status).toBe("ready");
    pane.status = "idle";
    expect(await autoCloseTick(d, noIo)).toEqual([{ lane: "fix-login", action: "closed" }]);
  });

  test("a READY lane without a Done line is the lead's to close", async () => {
    const { d, w } = await claimed({ done: undefined });
    w.clock += 60 * 60_000;
    expect(await autoCloseTick(d, noIo)).toEqual([]);
    expect(d.store.lane("fix-login")!.status).toBe("ready");
  });

  test("a broken config.json closes nothing and names the problem", async () => {
    const { d, w, state } = await claimed();
    state.merged = true;
    w.clock += 10 * 60_000;
    writeFileSync(join(d.store.root, "config.json"), "{");
    const events = await autoCloseTick(d, noIo);
    expect(events).toEqual([{ action: "autoclose-failed", detail: expect.stringContaining("not valid JSON") }]);
    expect(d.store.lane("fix-login")!.status).toBe("ready");
  });

  test("a lane objected to, or READY'd again, while its signals were read is left alone", async () => {
    const { d, w, lane, pane } = await claimed({ done: 'command ["check"]' });
    w.clock += 5 * 60_000;
    const objecting: SignalIo = { ...noIo, run: async () => {
      await objectDone(d, "fix-login", ["CI is red on main"]);
      return { code: 0, stdout: "", stderr: "" };
    } };
    expect(await autoCloseTick(d, objecting)).toEqual([{ lane: "fix-login", action: "close-deferred", detail: "its claim changed while its signals were read" }]);
    const objected = d.store.lane("fix-login")!;
    expect(objected.status).toBe("working");
    expect(objected.objection!.reasons).toEqual(["CI is red on main"]);
    expect(objected.log.map((e) => e.kind)).toEqual(["start", "ready", "object"]);
    expect(w.panes.has(lane.paneId)).toBe(true);
    // READY again, then a re-READY lands while the next check runs.
    await ready(d, "fix-login", "fixed again", ["e"]);
    w.clock += 5 * 60_000;
    const reReady: SignalIo = { ...noIo, run: async () => {
      w.clock += 1;
      await ready(d, "fix-login", "fixed for real", ["e"]);
      return { code: 1, stdout: "", stderr: "" };
    } };
    expect(await autoCloseTick(d, reReady)).toEqual([{ lane: "fix-login", action: "close-deferred", detail: "its claim changed while its signals were read" }]);
    const now = d.store.lane("fix-login")!;
    expect(now.status).toBe("ready");
    expect(now.objection).toBeUndefined();
    expect(now.final!.text).toBe("fixed for real");
    expect(w.panes.has(lane.paneId)).toBe(true);
    expect(pane.received.some((m) => m.includes("[LEAD] not done: CI is red on main"))).toBe(true);
  });
});
