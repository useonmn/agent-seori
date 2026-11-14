import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { ConfigError, loadConfig, type SeoriConfig } from "../src/config.ts";
import { SendUncertain } from "../src/messenger/adapter.ts";
import { PROGRESS_HEADER, progressDue, progressTick, progressText, scrubForOwner, threadTarget } from "../src/progress.ts";
import type { Lane } from "../src/store.ts";
import { World } from "./fake.ts";

const MIN = 60_000;
const FAKE = { source: "fake", owner: "u1" };

/** A world with messengers configured and, when `config` is given, that config.json written. */
function setup(config?: unknown) {
  const w = new World();
  const d = w.deps();
  w.messengers(d.store.root, [FAKE]);
  if (config !== undefined) writeFileSync(join(d.store.root, "config.json"), JSON.stringify(config));
  const lane = (over: Partial<Lane> = {}): Lane => {
    const l: Lane = {
      key: "fix-a", sessionRef: { runtime: "hc", id: "t9" }, paneId: "t9", tabId: "w1:t9", brief: "b", cwd: "/tmp", status: "working",
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

/** A lane that reported and is working: the shape every due check starts from. */
const busy = (w: World, over: Partial<Lane> = {}): Lane => ({
  key: "fix-a", sessionRef: { runtime: "hc", id: "t9" }, paneId: "t9", tabId: "w1:t9", brief: "b", cwd: "/tmp", status: "working",
  createdAt: w.clock, lastActivityAt: w.clock, nudges: 0, thread: "fake:c1:m1",
  log: [{ at: w.clock, kind: "start", text: "started" }, { at: w.clock, kind: "report", text: "halfway" }], ...over,
});

const config = (progressEveryMin: number | null): SeoriConfig => ({ ...loadConfig(tmpdir()), progressEveryMin });

describe("scrubForOwner", () => {
  test("home becomes ~ and pane ids become <pane>", () => {
    const h = join(tmpdir(), "owner-home");
    expect(scrubForOwner(`edited ${h}/dev/x.ts in hc:t12 (also ${h})`, h)).toBe("edited ~/dev/x.ts in <pane> (also ~)");
    expect(scrubForOwner("lane in hc:t1 and hc:t2b", "/x")).toBe("lane in <pane> and <pane>");
  });

  test("a path under the state root becomes (state path), keeping its trailing punctuation", () => {
    const home = "/home/owner";
    const state = join(home, ".seori");
    expect(scrubForOwner(`see ${state}/config.json and ${state}/secrets.json.`, home, state)).toBe("see (state path) and (state path).");
    // The state root is masked before the home directory, so nothing under it is left readable as `~/.seori/...`.
    expect(scrubForOwner(`wrote ${state}/briefs/fix-a.md`, home, state)).toBe("wrote (state path)");
    expect(scrubForOwner(`state at ${state}`, home, state)).toBe("state at (state path)");
  });

  test("the state root is masked by default, so secrets.json never reaches the owner", () => {
    const home = "/home/owner";
    const state = join(home, ".seori");
    // No stateRoot argument: the path must still not come out as `~/.seori/secrets.json`.
    expect(scrubForOwner(`token in ${state}/secrets.json`, home)).toBe("token in (state path)");
    expect(scrubForOwner(`SEORI_HOME=${state}`, home)).toBe("SEORI_HOME=(state path)");
  });

  test("a quoted state path keeps its quotes", () => {
    const home = "/home/owner";
    const state = join(home, ".seori");
    expect(scrubForOwner(`see "${state}/secrets.json" here`, home, state)).toBe('see "(state path)" here');
    expect(scrubForOwner(`see '${state}/secrets.json' here`, home, state)).toBe("see '(state path)' here");
    expect(scrubForOwner("see `" + state + "/secrets.json` here", home, state)).toBe("see `(state path)` here");
  });

  test("other absolute paths stay: a cited log or clone is the lane's evidence", () => {
    const home = "/home/owner";
    const state = join(home, ".seori");
    expect(scrubForOwner("log /tmp/build/out.log, clone /home/them/repos/x", home, state)).toBe("log /tmp/build/out.log, clone /home/them/repos/x");
    // A sibling that merely starts with the same letters is not under the state root.
    expect(scrubForOwner(`kept ${state}-backup/copy.log`, home, state)).toBe("kept ~/.seori-backup/copy.log");
  });

  test("the post is the header constant and the scrubbed report", () => {
    const h = join(tmpdir(), "owner-home");
    expect(progressText("tests pass in hc:t9")).toBe(`${PROGRESS_HEADER}tests pass in <pane>`);
    expect(progressText(`CI log ${h}/work/run.log`, join(h, ".seori"), h)).toBe(`${PROGRESS_HEADER}CI log ~/work/run.log`);
    expect(PROGRESS_HEADER).toBe("Progress (from the lane's last report): ");
  });
});

describe("progressEveryMin off by default", () => {
  test("no config.json: nothing is ever due and no post is sent", async () => {
    const { w, d, lane, reportNow } = setup();
    lane();
    reportNow("halfway");
    w.clock += 60 * MIN;
    expect(progressDue(d.store.lane("fix-a")!, loadConfig(d.store.root), w.clock)).toBeUndefined();
    expect(await progressTick(d)).toEqual([]);
    expect(w.notified).toEqual([]);
    expect(d.store.lane("fix-a")!.posted).toBeUndefined();
  });

  test("a config.json without progressEveryMin is off too", () => {
    const { w, d } = setup({ name: "seori" });
    expect(loadConfig(d.store.root).progressEveryMin).toBeNull();
    expect(progressDue(busy(w), loadConfig(d.store.root), w.clock + 60 * MIN)).toBeUndefined();
  });

  test("null is off as well", () => {
    const { w, d } = setup({ progressEveryMin: null });
    expect(loadConfig(d.store.root).progressEveryMin).toBeNull();
    expect(progressDue(busy(w), loadConfig(d.store.root), w.clock + 60 * MIN)).toBeUndefined();
  });

  test("0 is refused: it is not a second spelling of off", () => {
    const { d } = setup({ progressEveryMin: 0 });
    // The file setup wrote holds 0: assert it before the loop below replaces it, or this case is never tested.
    expect(() => loadConfig(d.store.root)).toThrow(/progressEveryMin must be a positive number of minutes, or null/);
    for (const bad of [-1, "15"]) {
      writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ progressEveryMin: bad }));
      expect(() => loadConfig(d.store.root)).toThrow(ConfigError);
    }
    // JSON has no Infinity: written raw, it parses as an out-of-range number.
    writeFileSync(join(d.store.root, "config.json"), '{"progressEveryMin": 1e999}');
    expect(() => loadConfig(d.store.root)).toThrow(ConfigError);
  });
});

describe("progressDue with progressEveryMin set", () => {
  test("15 means posted once 15 minutes passed, and not before", () => {
    const w = new World();
    const lane = busy(w);
    expect(progressDue(lane, config(15), w.clock + 14 * MIN)).toBeUndefined();
    expect(progressDue(lane, config(15), w.clock + 15 * MIN)).toBe("halfway");
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
    const { w, d, lane, reportNow } = setup({ progressEveryMin: 15 });
    lane();
    reportNow("tests pass in hc:t9");
    w.clock += 14 * MIN;
    expect(await progressTick(d)).toEqual([]);
    w.clock += MIN;
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "posted", detail: "via messenger" }]);
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0]!.config).toEqual(FAKE);
    expect(w.notified[0]!.target).toEqual({ chat: "c1", replyTo: "m1" });
    expect(w.notified[0]!.text).toBe(`${PROGRESS_HEADER}tests pass in <pane>`);
    const l = d.store.lane("fix-a")!;
    expect(l.posted).toEqual({ at: w.clock, text: "tests pass in hc:t9" });
    expect(l.log.at(-1)).toEqual({ at: w.clock, kind: "posted", text: "to fake:c1:m1 via messenger" });

    // same report: never posted again
    w.clock += 60 * MIN;
    expect(await progressTick(d)).toEqual([]);
    // a new report: posted once progressEveryMin has passed since the last post
    reportNow("PR opened");
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "posted", detail: "via messenger" }]);
    expect(w.notified.at(-1)!.text).toBe(`${PROGRESS_HEADER}PR opened`);
    reportNow("CI green");
    w.clock += 5 * MIN;
    expect(await progressTick(d)).toEqual([]);
  });

  test("respects config.progressEveryMin", async () => {
    const { w, d, lane, reportNow } = setup({ progressEveryMin: 2 });
    lane();
    reportNow("halfway");
    w.clock += 2 * MIN;
    expect((await progressTick(d)).map((e) => e.action)).toEqual(["posted"]);
  });

  test("hooks.threadReply carries the post: the argv runs, the messenger does not", async () => {
    const { w, d, lane, reportNow } = setup({
      progressEveryMin: 15,
      hooks: { threadReply: ["notify-owner", "{thread}", "{text}", "{key}"] },
    });
    lane();
    reportNow("tests pass in hc:t9");
    w.clock += 15 * MIN;
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "posted", detail: "via hooks.threadReply" }]);
    expect(w.notified).toEqual([]);
    expect(w.calls.filter((c) => c.cmd === "notify-owner")).toEqual([
      { cmd: "notify-owner", argv: ["fake:c1:m1", `${PROGRESS_HEADER}tests pass in <pane>`, "fix-a"] },
    ]);
    const l = d.store.lane("fix-a")!;
    expect(l.posted).toEqual({ at: w.clock, text: "tests pass in hc:t9" });
    expect(l.log.at(-1)).toEqual({ at: w.clock, kind: "posted", text: "to fake:c1:m1 via hooks.threadReply" });
  });

  test("the hook needs no messenger configured, and a failing hook records nothing for the next tick", async () => {
    const { w, d, lane, reportNow } = setup({
      progressEveryMin: 15,
      hooks: { threadReply: ["notify-owner", "{thread}", "{text}"] },
    });
    w.messengers(d.store.root, []);
    lane();
    reportNow("halfway");
    w.clock += 15 * MIN;
    w.reviewer = () => ({ code: 1, stdout: "", stderr: "chat not found" });
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "post-failed", detail: "hooks.threadReply: chat not found" }]);
    expect(d.store.lane("fix-a")!.posted).toBeUndefined();
    w.reviewer = () => ({ code: 0, stdout: "", stderr: "" });
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "posted", detail: "via hooks.threadReply" }]);
    expect(w.notified).toEqual([]);
  });

  test("the hook run is bounded: onSpawn gets the process and a killed run is a definite failure", async () => {
    const { w, d, lane, reportNow } = setup({
      progressEveryMin: 15,
      hooks: { threadReply: ["notify-owner", "{thread}", "{text}"] },
    });
    lane();
    reportNow("halfway");
    w.clock += 15 * MIN;
    // The tick awaits the sender, so it must be able to kill it (THREAD_REPLY_TIMEOUT_MS does that on a real run).
    // Here the kill is fired straight away instead of waiting 30 s; the observable contract is the same.
    let onSpawnGiven = false;
    const exec = d.exec;
    const hanging = {
      ...d,
      exec: (cmd: string, argv: readonly string[], opts?: { onSpawn?: (p: { kill(): void }) => void }) => {
        if (cmd !== "notify-owner") return exec(cmd, argv, opts);
        const { promise, reject } = Promise.withResolvers<never>();
        // Stand in for the deadline: the tick hands over a kill, and firing it must end the run as a definite failure.
        const proc = { kill: () => reject(new Error("killed")) };
        onSpawnGiven = opts?.onSpawn !== undefined;
        opts?.onSpawn?.(proc);
        proc.kill();
        return promise;
      },
    };
    expect(await progressTick(hanging)).toEqual([{ lane: "fix-a", action: "post-failed", detail: "hooks.threadReply: killed" }]);
    expect(onSpawnGiven).toBe(true);
    expect(d.store.lane("fix-a")!.posted).toBeUndefined();
  });

  test("skips lanes without a thread, without a report, or not working/waiting", async () => {
    const { w, d, lane } = setup({ progressEveryMin: 15 });
    lane({ key: "a", thread: undefined, log: [{ at: w.clock, kind: "report", text: "x" }] });
    lane({ key: "b" });
    lane({ key: "c", status: "paused", log: [{ at: w.clock, kind: "report", text: "x" }] });
    lane({ key: "d", status: "ready", log: [{ at: w.clock, kind: "report", text: "x" }] });
    lane({ key: "e", status: "waiting", log: [{ at: w.clock, kind: "report", text: "y" }] });
    w.clock += 15 * MIN;
    expect(await progressTick(d)).toEqual([{ lane: "e", action: "posted", detail: "via messenger" }]);
  });

  test("an uncertain send counts as posted; a definite failure retries next tick", async () => {
    const { w, d, lane, reportNow } = setup({ progressEveryMin: 15 });
    lane();
    reportNow("one");
    w.clock += 15 * MIN;
    w.notifyFails.push(new Error("network down"));
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "post-failed", detail: "messenger: network down" }]);
    expect(d.store.lane("fix-a")!.posted).toBeUndefined();
    w.notifyFails.push(new SendUncertain("timed out after send"));
    expect(await progressTick(d)).toEqual([{ lane: "fix-a", action: "post-uncertain", detail: "via messenger (uncertain: timed out after send)" }]);
    expect(d.store.lane("fix-a")!.posted?.text).toBe("one");
    expect(await progressTick(d)).toEqual([]);
  });

  test("keeps a report the lane sent while the post was in flight", async () => {
    const { w, d, lane, reportNow } = setup({ progressEveryMin: 15 });
    lane();
    reportNow("one");
    w.clock += 15 * MIN;
    const base = d.notify;
    const racing = { ...d, notify: async (...a: Parameters<typeof base>) => { reportNow("two"); await base(...a); } };
    await progressTick(racing);
    expect(d.store.lane("fix-a")!.log.filter((e) => e.kind === "report").map((e) => e.text)).toEqual(["one", "two"]);
  });

  test("names a missing messenger and a malformed thread", async () => {
    const { w, d, lane } = setup({ progressEveryMin: 15 });
    lane({ key: "a", thread: "telegram:5:6", log: [{ at: w.clock, kind: "report", text: "x" }] });
    lane({ key: "b", thread: "bad", log: [{ at: w.clock, kind: "report", text: "x" }] });
    w.clock += 15 * MIN;
    expect(await progressTick(d)).toEqual([
      { lane: "a", action: "post-failed", detail: "messenger: no messenger configured for source telegram" },
      { lane: "b", action: "post-failed", detail: "messenger: thread bad is not <source>:<chat>:<message id>" },
    ]);
  });
});
