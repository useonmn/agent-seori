import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec } from "../src/runtime/exec.ts";
import { blockedText, fileActivity, laneUsage, reachedCeilings, superviseTick } from "../src/supervision.ts";
import type { Lane, LaneStatus } from "../src/store.ts";
import { World, herdrRef } from "./fake.ts";

const MIN = 60_000;

/** One assistant message of an omp session jsonl with this usage. */
const assistant = (totalTokens: number, cost: number) =>
  JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 2, totalTokens, cost: { total: cost } } } });

function setup(status: LaneStatus = "working", extra: Partial<Lane> = {}) {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", herdrRef("w1:p1"));
  const pane = w.addPane("w1:p5", "working");
  pane.agent = "omp";
  // git in the lane's cwd: a clean tree at HEAD `git.head`.
  const git = { head: "aaa", status: "" };
  w.reviewer = (argv) => {
    if (argv.includes("status")) return { code: 0, stdout: git.status };
    if (argv.includes("--show-prefix")) return { code: 0, stdout: "\n" };
    if (argv.includes("rev-parse")) return { code: 0, stdout: `${git.head}\n` };
    return { code: 1, stdout: "" };
  };
  d.store.saveLane({
    key: "fix-a", sessionRef: { runtime: "herdr", id: "w1:p5", container: "w1:t5" }, paneId: "w1:p5", tabId: "w1:t5", brief: "/dev/null", cwd: "/repo", status,
    createdAt: 0, lastActivityAt: 0, nudges: 0, log: [], ...extra,
  });
  const config = (value: unknown) => writeFileSync(join(d.store.root, "config.json"), JSON.stringify(value));
  const session = (lines: string[]) => {
    const path = join(d.store.root, "session.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    pane.session = path;
  };
  return { w, d, lead, pane, git, config, session, lane: () => d.store.lane("fix-a")! };
}

describe("laneUsage", () => {
  test("sums totalTokens and cost.total over assistant messages; other entries and damaged lines are skipped", async () => {
    const { d, session, lane } = setup();
    session([
      JSON.stringify({ type: "session", id: "x" }),
      assistant(100, 0.5),
      JSON.stringify({ type: "message", message: { role: "user", usage: { totalTokens: 999, cost: { total: 9 } } } }),
      assistant(50, 0.25),
      '{"type":"message","message":{"role":"assis',
    ]);
    expect(await laneUsage(d, lane())).toEqual({ tokens: 150, costUsd: 0.75 });
  });

  test("unknown stays undefined, never 0: no session path, a missing file, or no usage on any assistant message", async () => {
    const { d, pane, session, lane } = setup();
    expect(await laneUsage(d, lane())).toEqual({});
    pane.session = "/nonexistent/session.jsonl";
    expect(await laneUsage(d, lane())).toEqual({});
    session([JSON.stringify({ type: "message", message: { role: "assistant" } })]);
    expect(await laneUsage(d, lane())).toEqual({});
    session([JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 7 } } })]);
    expect(await laneUsage(d, lane())).toEqual({ tokens: 7 });
  });
});

describe("ceilings", () => {
  test("reachedCeilings: reading >= limit; null limits and unknown readings reach nothing", () => {
    const lane = { createdAt: 0 } as Lane;
    expect(reachedCeilings(lane, { wallMinutes: 60, tokens: 10, costUsd: null }, { costUsd: 99 }, 60 * MIN))
      .toEqual([{ which: "wallMinutes", actual: 60, limit: 60 }]);
    expect(reachedCeilings(lane, { wallMinutes: 61, tokens: null, costUsd: 1 }, { costUsd: 1 }, 60 * MIN))
      .toEqual([{ which: "costUsd", actual: 1, limit: 1 }]);
  });

  test("blockedText names the ceiling, the reading and the limit", () => {
    expect(blockedText("k", { which: "wallMinutes", actual: 61.7, limit: 60 })).toBe("[BLOCKED k] wall-clock ceiling reached (61 min, limit 60 min); the lane keeps running until you decide");
    expect(blockedText("k", { which: "tokens", actual: 1200, limit: 1000 })).toBe("[BLOCKED k] token ceiling reached (1200 tokens, limit 1000); the lane keeps running until you decide");
    expect(blockedText("k", { which: "costUsd", actual: 2.5, limit: 2 })).toBe("[BLOCKED k] cost ceiling reached ($2.50, limit $2.00); the lane keeps running until you decide");
  });

  test("a lane's wall ceiling is told to the lead once and logged; the lane gets nothing", async () => {
    const { w, d, lead, pane, lane } = setup("working", { ceilings: { wallMinutes: 60, tokens: null, costUsd: null }, lastActivityAt: 61 * MIN });
    pane.status = "idle";
    w.clock = 59 * MIN;
    expect(await superviseTick(d)).toEqual([]);
    w.clock = 61 * MIN;
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "blocked", detail: "wallMinutes" }]);
    const text = "[BLOCKED fix-a] wall-clock ceiling reached (61 min, limit 60 min); the lane keeps running until you decide";
    expect(lead.received).toEqual([text]);
    expect(lane().log.at(-1)).toEqual({ at: 61 * MIN, kind: "blocked", text });
    expect(lane().status).toBe("working");
    w.clock = 90 * MIN;
    expect(await superviseTick(d)).toEqual([]);
    expect(lead.received).toHaveLength(1);
    expect(pane.received).toEqual([]);
    expect(w.calls.some((c) => c.argv[1] === "close")).toBe(false);
  });

  test("a limit the lead raised is reported again once reached", async () => {
    const { w, d, lead, pane, lane } = setup("waiting", { ceilings: { wallMinutes: 60, tokens: null, costUsd: null } });
    pane.status = "idle";
    w.clock = 61 * MIN;
    await superviseTick(d);
    d.store.saveLane({ ...lane(), ceilings: { wallMinutes: 120, tokens: null, costUsd: null } });
    w.clock = 100 * MIN;
    expect(await superviseTick(d)).toEqual([]);
    w.clock = 121 * MIN;
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "blocked", detail: "wallMinutes" }]);
    expect(lead.received).toHaveLength(2);
  });

  test("config defaults apply to a lane without its own ceilings; tokens and cost come from the omp session", async () => {
    const { w, d, lead, pane, config, session } = setup("working", { lastActivityAt: 0 });
    pane.status = "idle";
    config({ supervision: { defaults: { tokens: 1000, costUsd: 2 } } });
    session([assistant(600, 1), assistant(600, 0.5)]);
    w.clock = MIN;
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "blocked", detail: "tokens" }]);
    expect(lead.received).toEqual(["[BLOCKED fix-a] token ceiling reached (1200 tokens, limit 1000); the lane keeps running until you decide"]);
    session([assistant(600, 1), assistant(600, 0.5), assistant(1, 0.5)]);
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "blocked", detail: "costUsd" }]);
  });

  test("usage is not read without a token or cost ceiling", async () => {
    const { w, d, pane } = setup();
    pane.status = "idle";
    await superviseTick(d);
    const gets = w.calls.filter((c) => c.argv[1] === "get" && c.argv[2] === "w1:p5");
    expect(gets).toHaveLength(0);
  });

  test("an unknown usage reading is shown once as an event and never reaches a ceiling", async () => {
    const { d, lead, pane } = setup("working", { ceilings: { wallMinutes: null, tokens: 10, costUsd: null } });
    pane.status = "idle";
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "usage-unknown", detail: "tokens ceiling cannot be checked: the lane's omp session usage is unavailable" }]);
    expect(await superviseTick(d)).toEqual([]);
    expect(lead.received).toEqual([]);
  });

  test("an invalid config.json is one event, not a crash", async () => {
    const { d, config } = setup();
    config({ supervision: { toknes: 5 } });
    const events = await superviseTick(d);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("supervise-failed");
    expect(events[0]!.detail).toContain("unknown field \"toknes\"");
  });

  test("a gone lead pane: the alert is queued once, not again on every pass", async () => {
    const { w, d, pane } = setup("working", { ceilings: { wallMinutes: 60, tokens: null, costUsd: null }, lastActivityAt: 200 * MIN });
    pane.status = "idle";
    w.panes.delete("w1:p1");
    w.clock = 61 * MIN;
    const first = await superviseTick(d);
    expect(first).toContainEqual({ lane: "fix-a", action: "blocked", detail: "wallMinutes" });
    w.clock = 62 * MIN;
    await superviseTick(d);
    w.clock = 63 * MIN;
    await superviseTick(d);
    expect(d.store.queued(herdrRef("w1:p1")).map((m) => m.text)).toEqual([blockedText("fix-a", { which: "wallMinutes", actual: 61, limit: 60 })]);
    expect(d.store.lane("fix-a")!.log.filter((e) => e.kind === "blocked")).toHaveLength(1);
  });
});

describe("stalls", () => {
  const STALL = "[STALLED fix-a] herdr reads it working, but it has sent no report and changed no file for 21 min; the lane keeps running until you decide";

  test("herdr working, no report and no file change for hungAfterMin: told once per stall and logged", async () => {
    const { w, d, lead, pane, lane } = setup();
    w.clock = 19 * MIN;
    expect(await superviseTick(d)).toEqual([]);
    w.clock = 21 * MIN;
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "stalled" }]);
    expect(lead.received).toEqual([STALL]);
    expect(lane().log.at(-1)).toEqual({ at: 21 * MIN, kind: "stalled", text: STALL });
    w.clock = 40 * MIN;
    expect(await superviseTick(d)).toEqual([]);
    expect(pane.received).toEqual([]);
    // A report starts a new stretch; a new stall after it is told again.
    d.store.saveLane({ ...lane(), lastActivityAt: 41 * MIN });
    w.clock = 62 * MIN;
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "stalled" }]);
    expect(lead.received).toEqual([STALL, STALL]);
    expect(Object.keys(lane().alerts!).filter((k) => k.startsWith("stalled:"))).toHaveLength(1);
  });

  test("a git change in the lane's cwd counts as progress", async () => {
    const { w, d, lead, git } = setup();
    w.clock = 10 * MIN;
    await superviseTick(d);
    git.head = "bbb";
    w.clock = 15 * MIN;
    await superviseTick(d);
    w.clock = 34 * MIN;
    expect(await superviseTick(d)).toEqual([]);
    git.status = " M src/a.ts\0";
    w.clock = 35 * MIN;
    expect(await superviseTick(d)).toEqual([]);
    w.clock = 56 * MIN;
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "stalled" }]);
    expect(lead.received).toEqual(["[STALLED fix-a] herdr reads it working, but it has sent no report and changed no file for 21 min; the lane keeps running until you decide"]);
  });

  test("not working in herdr, or a waiting lane: no stall", async () => {
    const idle = setup();
    idle.pane.status = "idle";
    idle.w.clock = 60 * MIN;
    expect(await superviseTick(idle.d)).toEqual([]);
    const waiting = setup("waiting");
    waiting.w.clock = 60 * MIN;
    expect(await superviseTick(waiting.d)).toEqual([]);
    expect(waiting.lead.received).toEqual([]);
  });

  test("hungAfterMin comes from config.json", async () => {
    const { w, d, config } = setup();
    config({ supervision: { hungAfterMin: 5 } });
    w.clock = 6 * MIN;
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "stalled" }]);
  });
});

describe("fileActivity on a real git repo", () => {
  function repo() {
    const root = mkdtempSync(join(tmpdir(), "seori-fileactivity-"));
    const git = (...args: string[]) => spawnExec("git", ["-C", root, ...args]);
    const d = { ...new World().deps(), exec: spawnExec };
    return { root, git, d, done: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("a lane whose cwd is a subdirectory sees its edits (porcelain paths are repo-relative)", async () => {
    const { root, git, d, done } = repo();
    try {
      await git("init", "-q");
      mkdirSync(join(root, "pkg"));
      writeFileSync(join(root, "pkg", "a.ts"), "one\n");
      await git("add", ".");
      await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
      writeFileSync(join(root, "pkg", "a.ts"), "two\n");
      const cwd = join(root, "pkg");
      const before = await fileActivity(d, cwd);
      expect(before.newestMtime).toBeNumber();
      expect(before.fingerprint).toContain(" M a.ts");
      writeFileSync(join(root, "pkg", "a.ts"), "three, longer\n");
      expect((await fileActivity(d, cwd)).fingerprint).not.toBe(before.fingerprint);
    } finally {
      done();
    }
  });

  test("a rewrite inside a new untracked directory is a change", async () => {
    const { root, git, d, done } = repo();
    try {
      await git("init", "-q");
      mkdirSync(join(root, "src", "feature"), { recursive: true });
      writeFileSync(join(root, "src", "feature", "a.ts"), "one\n");
      const before = await fileActivity(d, root);
      writeFileSync(join(root, "src", "feature", "a.ts"), "two, longer\n");
      expect((await fileActivity(d, root)).fingerprint).not.toBe(before.fingerprint);
    } finally {
      done();
    }
  });
});

describe("paused lanes", () => {
  test("no ceiling or stall report; working on two passes in a row is told once per working stretch", async () => {
    const { w, d, lead, pane, lane } = setup("paused", { ceilings: { wallMinutes: 1, tokens: null, costUsd: null } });
    w.clock = 60 * MIN;
    expect(await superviseTick(d)).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "working-while-paused" }]);
    const text = "[WORKING-WHILE-PAUSED fix-a] pane w1:p5 reads working on two duty passes in a row while the lane is paused; it stays paused until seori resume fix-a";
    expect(lead.received).toEqual([text]);
    expect(await superviseTick(d)).toEqual([]);
    expect(lane().status).toBe("paused");
    pane.status = "idle";
    expect(await superviseTick(d)).toEqual([]);
    expect(lane().alerts).toEqual({});
    pane.status = "working";
    await superviseTick(d);
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "working-while-paused" }]);
    expect(lead.received).toEqual([text, text]);
    expect(pane.received).toEqual([]);
  });

  test("one idle pass between working passes resets the count", async () => {
    const { d, lead, pane } = setup("paused");
    await superviseTick(d);
    pane.status = "idle";
    await superviseTick(d);
    pane.status = "working";
    expect(await superviseTick(d)).toEqual([]);
    expect(lead.received).toEqual([]);
  });

  test("a gone pane marks the paused lane lost and tells the lead, so the key can be started again", async () => {
    const { w, d, lead, lane } = setup("paused", { pausedFrom: "working" });
    w.panes.delete("w1:p5");
    w.clock = 5 * MIN;
    expect(await superviseTick(d)).toEqual([{ lane: "fix-a", action: "lost" }]);
    expect(lane().status).toBe("lost");
    expect(lane().pausedFrom).toBeUndefined();
    expect(lane().log.at(-1)).toEqual({ at: 5 * MIN, kind: "lost", text: "pane disappeared while paused" });
    expect(lead.received).toEqual(["[LOST fix-a] pane w1:p5 closed while the lane was paused"]);
    expect(await superviseTick(d)).toEqual([]);
  });
});

test("a stopped duty loop supervises nothing", async () => {
  const { w, d, lead } = setup();
  d.store.setStop(0, "maintenance", "duty");
  w.clock = 60 * MIN;
  expect(await superviseTick(d)).toEqual([]);
  expect(lead.received).toEqual([]);
});

test("one lane's failure is an event and the others are still supervised", async () => {
  const { w, d, lead } = setup();
  d.store.saveLane({ key: "broken-b", sessionRef: { runtime: "herdr", id: "w1:p9", container: "w1:t9" }, paneId: "w1:p9", tabId: "w1:t9", brief: "/dev/null", cwd: "/x", status: "paused", createdAt: 0, lastActivityAt: 0, nudges: 0, log: [] });
  w.addPane("w1:p9", "working");
  w.getHook.set("w1:p9", () => { throw new Error("herdr crashed"); });
  w.clock = 21 * MIN;
  const events = await superviseTick(d);
  expect(events).toContainEqual({ lane: "broken-b", action: "supervise-failed", detail: "herdr crashed" });
  expect(events).toContainEqual({ lane: "fix-a", action: "stalled" });
  expect(lead.received).toHaveLength(1);
});
