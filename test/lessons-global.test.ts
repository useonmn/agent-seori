import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { main } from "../src/cli.ts";
import { Refusal, startLane, type Deps } from "../src/harness.ts";
import {
  addLesson, BRIEF_LESSONS, formatLessonAdded, formatLessons, GLOBAL_LESSONS, lessonsBlock, lessonsForRepo, lessonsPath,
  listLessons, markLesson,
} from "../src/lessons.ts";
import { World, herdrRef } from "./fake.ts";

const T0 = Date.parse("2026-11-07T10:00:00.000Z");

async function run(argv: string[], d: Deps): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { code: await main(argv, d), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

/** A lead pane and one open lane, `fix-login`, whose pane is w1:p2. */
async function setup() {
  const w = new World();
  const d = w.deps();
  w.addPane("w1:p1", "idle");
  d.store.setRole("lead", herdrRef("w1:p1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  const cwd = join(d.store.root, "work");
  mkdirSync(cwd);
  w.reviewer = (argv) => ({ code: 0, stdout: argv[2] === "rev-parse" ? "true\n" : "" });
  const lane = await startLane(d, "fix-login", brief, { workspace: "w1", cwd });
  return { w, d, brief, cwd, lane };
}

/** Runs fn as if inside the terminal of `ref` (herdr pane id), or of nothing when undefined. */
async function inside<T>(pane: string | undefined, fn: () => Promise<T>): Promise<T> {
  const keys = ["HC_TERMINAL_ID", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"] as const;
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) delete process.env[k];
  if (pane !== undefined) process.env["HERDR_PANE_ID"] = pane;
  try {
    return await fn();
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
}

describe("global lessons (lessons module)", () => {
  let d: Deps;
  let cwd: string;
  beforeEach(async () => ({ d, cwd } = await setup()));

  test("a global lesson has scope global and no cwd, and every repo lists it", () => {
    const root = d.store.root;
    const g = addLesson(root, { global: true, rule: "never force-push", evidence: "REF-1" }, T0);
    expect(g).toMatchObject({ scope: "global", lane: "lead", outcome: "pending" });
    expect("cwd" in g).toBe(false);
    expect(formatLessonAdded(g)).toBe(`LESSON ${g.id} pending lead global`);
    expect(listLessons(root, cwd).lessons.map((l) => l.id)).toEqual([g.id]);
    expect(listLessons(root, join(root, "elsewhere")).lessons.map((l) => l.id)).toEqual([g.id]);
    expect(formatLessons({ lessons: [g], problems: [] })[0]).toContain(" lead global");
  });

  test("marking keeps the scope; a record with both scope and cwd is damaged", () => {
    const root = d.store.root;
    const g = addLesson(root, { global: true, rule: "r", evidence: "e" }, T0);
    expect(markLesson(root, g.id, "helped", T0 + 1)).toMatchObject({ scope: "global", outcome: "helped" });
    writeFileSync(lessonsPath(root), `${readFileSync(lessonsPath(root), "utf8")}${JSON.stringify({ ...g, id: "00000000-0000-4000-8000-000000000001", cwd: "/x" })}\n`);
    const read = listLessons(root);
    expect(read.lessons).toHaveLength(1);
    expect(read.problems.join("\n")).toContain('a global lesson has no field "cwd"');
  });

  test("global lessons have their own cap and never push repo lessons out", () => {
    const root = d.store.root;
    for (let i = 0; i < GLOBAL_LESSONS + 2; i++) addLesson(root, { global: true, rule: `g${i}`, evidence: "e" }, T0 + i);
    for (let i = 0; i < BRIEF_LESSONS + 2; i++) addLesson(root, { cwd, rule: `r${i}`, evidence: "e" }, T0 + 100 + i);
    const { lessons } = lessonsForRepo(root, cwd);
    expect(lessons.filter((l) => l.scope === "global").map((l) => l.rule)).toEqual(["g5", "g4", "g3", "g2"]);
    expect(lessons.filter((l) => l.scope !== "global")).toHaveLength(BRIEF_LESSONS);
    expect(lessons).toHaveLength(GLOBAL_LESSONS + BRIEF_LESSONS);
  });

  test("the brief block puts global lessons first under their own heading; only repo ones under the repo heading", () => {
    const root = d.store.root;
    addLesson(root, { cwd, rule: "repo rule", evidence: "e" }, T0);
    expect(lessonsBlock(root, cwd)).toBe("## Lessons for this repo\n- [pending; lead] repo rule\n\n");
    addLesson(root, { global: true, rule: "global rule", evidence: "e" }, T0 + 1);
    expect(lessonsBlock(root, cwd)).toBe(
      "## Lessons for every lane\n- [pending; lead] global rule\n\n## Lessons for this repo\n- [pending; lead] repo rule\n\n",
    );
  });

  test("a harmful global lesson leaves the briefs", () => {
    const root = d.store.root;
    const g = addLesson(root, { global: true, rule: "r", evidence: "e" }, T0);
    markLesson(root, g.id, "harmful", T0 + 1);
    expect(lessonsBlock(root, cwd)).toBe("");
  });
});

describe("global lessons in a lane's brief", () => {
  test("every lane's brief gets them once, also on a retry with the written brief", async () => {
    const { d, brief, cwd, lane } = await setup();
    addLesson(d.store.root, { global: true, rule: "never force-push", evidence: "e" }, T0);
    addLesson(d.store.root, { cwd, rule: "run bun test twice", evidence: "e" }, T0 + 1);
    const other = join(d.store.root, "other");
    mkdirSync(other);
    const second = await startLane(d, "other-lane", brief, { workspace: "w1", cwd: other });
    expect(readFileSync(second.brief, "utf8")).toStartWith("## Lessons for every lane\n- [pending; lead] never force-push\n\nFix the flaky");
    d.store.saveLane({ ...d.store.lane("fix-login")!, status: "lost" });
    await startLane(d, "fix-login", brief, { workspace: "w1", cwd });
    const first = readFileSync(lane.brief, "utf8");
    expect(first).toStartWith(
      "## Lessons for every lane\n- [pending; lead] never force-push\n\n## Lessons for this repo\n- [pending; lead] run bun test twice\n\nFix the flaky login test.",
    );
    d.store.saveLane({ ...d.store.lane("fix-login")!, status: "lost" });
    await startLane(d, "fix-login", lane.brief, { workspace: "w1", cwd });
    expect(readFileSync(lane.brief, "utf8")).toBe(first);
  });
});

describe("seori lesson add --global (CLI)", () => {
  afterEach(() => undefined);

  test("the lead adds one; list shows it as global", async () => {
    const { d } = await setup();
    const added = await inside("w1:p1", () => run(["lesson", "add", "--global", "--rule", "never force-push", "--evidence", "REF-1"], d));
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/^LESSON [0-9a-f-]{36} pending lead global$/);
    const list = await run(["lesson", "list"], d);
    expect(list.out).toContain("never force-push");
    expect(list.out).toContain(" lead global");
  });

  test("a terminal outside every lane (no runtime env) may add one", async () => {
    const { d } = await setup();
    const r = await inside(undefined, () => run(["lesson", "add", "--global", "--rule", "r", "--evidence", "e"], d));
    expect(r.code).toBe(0);
  });

  test("it is refused from a lane's terminal and writes nothing", async () => {
    const { d, lane } = await setup();
    await expect(inside(lane.sessionRef.id, () => run(["lesson", "add", "--global", "--rule", "r", "--evidence", "e"], d)))
      .rejects.toThrow(/lead's; this terminal is lane fix-login/);
    expect(listLessons(d.store.root).lessons).toEqual([]);
  });

  test("it takes no lane key and no --cwd", async () => {
    const { d, cwd } = await setup();
    await expect(inside(undefined, () => run(["lesson", "add", "fix-login", "--global", "--rule", "r", "--evidence", "e"], d))).rejects.toThrow(Refusal);
    await expect(inside(undefined, () => run(["lesson", "add", "--global", "--cwd", cwd, "--rule", "r", "--evidence", "e"], d))).rejects.toThrow(/no --cwd/);
    expect(listLessons(d.store.root).lessons).toEqual([]);
  });

  test("a lane cannot mark a global lesson, but the lead can, and a lane can still mark a repo lesson", async () => {
    const { d, cwd, lane } = await setup();
    const g = addLesson(d.store.root, { global: true, rule: "r", evidence: "e" }, T0);
    const repo = addLesson(d.store.root, { cwd, rule: "r2", evidence: "e" }, T0 + 1);
    await expect(inside(lane.sessionRef.id, () => run(["lesson", "mark", g.id, "--outcome", "helped"], d)))
      .rejects.toThrow(/the lead's to mark; this terminal is lane fix-login/);
    expect(listLessons(d.store.root).lessons.find((l) => l.id === g.id)!.outcome).toBe("pending");
    expect((await inside(lane.sessionRef.id, () => run(["lesson", "mark", repo.id, "--outcome", "helped"], d))).out).toBe(`MARKED ${repo.id} helped`);
    expect((await inside("w1:p1", () => run(["lesson", "mark", g.id, "--outcome", "harmful"], d))).out).toBe(`MARKED ${g.id} harmful`);
  });

  test("a repo lesson add still needs a lane key or --cwd", async () => {
    const { d } = await setup();
    await expect(inside(undefined, () => run(["lesson", "add", "--rule", "r", "--evidence", "e"], d))).rejects.toThrow(/lane key or --cwd/);
  });
});
