import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import { Refusal } from "../src/harness.ts";
import {
  addLesson, formatLessonAdded, formatLessonMarked, formatLessons, LESSONS_HEADING, lessonsBlock, lessonsForRepo,
  lessonsPath, listLessons, markLesson,
} from "../src/lessons.ts";

let root: string;
let repo: string;
let other: string;
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "seori-lessons-")));
  root = join(base, "home");
  repo = join(base, "repo");
  other = join(base, "other");
  mkdirSync(repo, { recursive: true });
  mkdirSync(other, { recursive: true });
});
afterEach(() => rmSync(join(root, ".."), { recursive: true, force: true }));

describe("lessons", () => {
  test("add stores a pending lesson scoped to the realpath of cwd; list is newest first", () => {
    const link = join(root, "..", "link");
    symlinkSync(repo, link);
    const a = addLesson(root, { cwd: link, rule: "run bun test before ready", evidence: "/tmp/a.log", lane: "fix-a" }, T0);
    const b = addLesson(root, { cwd: repo, rule: "pin the fixture clock", evidence: "/tmp/b.log" }, T0 + 1000);
    expect(a).toMatchObject({ cwd: repo, lane: "fix-a", outcome: "pending", at: "2026-11-07T10:00:00.000Z" });
    expect(b.lane).toBe("lead");
    expect(listLessons(root).lessons.map((l) => l.id)).toEqual([b.id, a.id]);
    expect(listLessons(root, link).lessons).toHaveLength(2);
    expect(listLessons(root, other).lessons).toEqual([]);
    expect(formatLessonAdded(a)).toBe(`LESSON ${a.id} pending fix-a ${repo}`);
  });

  test("add refuses multi-line or empty text and bad lane keys", () => {
    expect(() => addLesson(root, { cwd: repo, rule: "a\nb", evidence: "e" }, T0)).toThrow(Refusal);
    expect(() => addLesson(root, { cwd: repo, rule: "r", evidence: " " }, T0)).toThrow(/evidence must be one nonempty line/);
    expect(() => addLesson(root, { cwd: repo, rule: "x".repeat(401), evidence: "e" }, T0)).toThrow(Refusal);
    expect(() => addLesson(root, { cwd: repo, rule: "r", evidence: "e", lane: "Bad Key" }, T0)).toThrow(/lane must match/);
    expect(() => addLesson(root, { cwd: "", rule: "r", evidence: "e" }, T0)).toThrow(Refusal);
  });

  test("mark appends a new record; the latest wins and history stays", () => {
    const a = addLesson(root, { cwd: repo, rule: "r", evidence: "e", lane: "fix-a" }, T0);
    const marked = markLesson(root, a.id, "harmful", T0 + 5000);
    expect(marked).toMatchObject({ id: a.id, outcome: "harmful", marked: "2026-11-07T10:00:05.000Z", at: a.at });
    expect(listLessons(root).lessons).toEqual([marked]);
    expect(readFileSync(lessonsPath(root), "utf8").trim().split("\n")).toHaveLength(2);
    expect(formatLessonMarked(marked)).toBe(`MARKED ${a.id} harmful`);
    expect(() => markLesson(root, "nope", "helped", T0)).toThrow(/no lesson "nope"/);
    expect(() => markLesson(root, a.id, "pending" as never, T0)).toThrow(/outcome must be one of/);
  });

  test("block holds up to 8 newest pending or helped lessons for the repo, '' when none", () => {
    expect(lessonsBlock(root, repo)).toBe("");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(addLesson(root, { cwd: repo, rule: `rule ${i}`, evidence: "e", lane: "fix-a" }, T0 + i).id);
    markLesson(root, ids[9]!, "harmful", T0 + 100);
    markLesson(root, ids[7]!, "helped", T0 + 100);
    addLesson(root, { cwd: other, rule: "elsewhere", evidence: "e" }, T0 + 50);
    // Nine qualify (0-8); the oldest falls off the cap of eight.
    const block = lessonsBlock(root, repo);
    const line = (i: number) => `- [${i === 7 ? "helped" : "pending"}; fix-a] rule ${i}`;
    expect(block).toBe(`${LESSONS_HEADING}\n${[8, 7, 6, 5, 4, 3, 2, 1].map(line).join("\n")}\n\n`);
    expect(lessonsForRepo(root, repo).lessons).toHaveLength(8);
    markLesson(root, ids[8]!, "encoded", T0 + 200);
    expect(lessonsBlock(root, repo)).toContain("rule 0");
    expect(lessonsBlock(root, repo)).not.toContain("rule 8");
  });

  test("damaged lines are skipped and named; a torn tail does not swallow the next record", () => {
    const a = addLesson(root, { cwd: repo, rule: "good", evidence: "e" }, T0);
    appendFileSync(lessonsPath(root), "not json\n");
    appendFileSync(lessonsPath(root), `${JSON.stringify({ ...a, extra: 1 })}\n`);
    appendFileSync(lessonsPath(root), `${JSON.stringify({ ...a, rule: "changed" })}\n`);
    appendFileSync(lessonsPath(root), `{"id":"torn`);
    const b = addLesson(root, { cwd: repo, rule: "after torn", evidence: "e" }, T0 + 1);
    const read = listLessons(root);
    expect(read.lessons.map((l) => l.rule)).toEqual(["after torn", "good"]);
    const path = lessonsPath(root);
    expect(read.problems).toEqual([
      `${path}:2: not valid JSON`,
      `${path}:3: unknown lesson field "extra"`,
      `${path}:4: lesson field "rule" changed for ${a.id}; it is fixed once recorded`,
      `${path}:5: not valid JSON`,
    ]);
    expect(lessonsBlock(root, repo)).toContain("after torn");
    const lines = formatLessons(read);
    expect(lines[0]).toBe(`LESSON_WARNING ${path}:2: not valid JSON`);
    expect(lines.slice(4)).toEqual([
      `${b.id} pending ${b.at} lead ${repo}`, "  rule: after torn", "  evidence: e",
      `${a.id} pending ${a.at} lead ${repo}`, "  rule: good", "  evidence: e",
    ]);
  });

  test("list formatter says EMPTY when there is no lesson; a missing file reads as empty", () => {
    expect(listLessons(root)).toEqual({ lessons: [], problems: [] });
    expect(formatLessons(listLessons(root))).toEqual(["EMPTY"]);
    mkdirSync(root, { recursive: true });
    writeFileSync(lessonsPath(root), "\n\n");
    expect(formatLessons(listLessons(root))).toEqual(["EMPTY"]);
  });

  test("a marked lesson shows its mark time in the list", () => {
    const a = addLesson(root, { cwd: repo, rule: "r", evidence: "e" }, T0);
    markLesson(root, a.id, "helped", T0 + 60_000);
    expect(formatLessons(listLessons(root))[0]).toBe(`${a.id} helped (marked 2026-11-07T10:01:00.000Z) ${a.at} lead ${repo}`);
  });
});
