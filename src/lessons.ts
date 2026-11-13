/**
 * Lessons: one-line rules a closed lane leaves for the next lane in the same repo. They live in
 * `$SEORI_HOME/lessons.jsonl`, append-only: adding writes a record, marking writes the same record again with a new
 * outcome, and the last record for an id wins. History is never rewritten. A damaged line is skipped and named, so one
 * bad line never hides the rest. A lane's brief gets the newest pending or helped lessons for its exact repo directory.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { Refusal } from "./harness.ts";
import { KEY_RE } from "./store.ts";

export type LessonOutcome = "pending" | "helped" | "no-effect" | "harmful" | "encoded";
/** The outcomes a mark may set: a lesson starts pending and is never marked back to it. */
export type LessonMark = Exclude<LessonOutcome, "pending">;
export type Lesson = {
  readonly id: string;
  /** ISO time the lesson was added. */
  readonly at: string;
  /** The lane that learned it, or "lead" for a lesson the lead added by directory. */
  readonly lane: string;
  /** Canonical (realpath) directory the lesson applies to; a global lesson has none and reaches every lane. */
  readonly cwd?: string;
  /** "global": the lead's standing rule for every lane, whatever its repo. Absent on a repo lesson. */
  readonly scope?: "global";
  readonly rule: string;
  readonly evidence: string;
  readonly outcome: LessonOutcome;
  /** ISO time of the last mark; absent while the lesson was never marked. */
  readonly marked?: string;
};
export type LessonInput =
  | { readonly cwd: string; readonly global?: undefined; readonly rule: string; readonly evidence: string; readonly lane?: string }
  | { readonly global: true; readonly cwd?: undefined; readonly rule: string; readonly evidence: string; readonly lane?: string };
/** Valid lessons, newest first, and one `<path>:<line>: <reason>` problem per damaged line. */
export type LessonRead = { readonly lessons: Lesson[]; readonly problems: string[] };

/** A record in lessons.jsonl that cannot be used; reported as a problem line, never thrown out of a read. */
class DamagedLesson extends Error {}

const OUTCOMES: readonly LessonOutcome[] = ["pending", "helped", "no-effect", "harmful", "encoded"];
const MARKS: readonly LessonMark[] = ["helped", "no-effect", "harmful", "encoded"];
export const isLessonOutcome = (value: unknown): value is LessonOutcome => (OUTCOMES as readonly unknown[]).includes(value);
export const isLessonMark = (value: unknown): value is LessonMark => (MARKS as readonly unknown[]).includes(value);

/** At most this many lessons go into a brief, so old lessons cannot crowd out the task. */
export const BRIEF_LESSONS = 8;
/** Global lessons have their own cap, so they never push a repo's lessons out of a brief. */
export const GLOBAL_LESSONS = 4;
export const LESSONS_HEADING = "## Lessons for this repo";
export const GLOBAL_LESSONS_HEADING = "## Lessons for every lane";
/** Lane recorded for a lesson added by directory rather than from a lane. */
export const LEAD_LANE = "lead";

const singleLine = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
// Only the form toISOString writes: Date.parse also takes "0" or an RFC 2822 date, which must not reach a brief.
const isoTime = (v: unknown): boolean => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

const FIELDS = ["id", "at", "lane", "cwd", "scope", "rule", "evidence", "outcome", "marked"] as const;
const IMMUTABLE = ["at", "lane", "cwd", "scope", "rule", "evidence"] as const;
const checks: Record<(typeof FIELDS)[number], [(value: unknown) => boolean, string]> = {
  id: [(v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v), "must be a lowercase UUID"],
  at: [isoTime, "must be an ISO time as toISOString writes it"],
  lane: [(v) => typeof v === "string" && KEY_RE.test(v), `must match ${KEY_RE}`],
  cwd: [(v) => singleLine(v, 4096) && isAbsolute(v), "must be an absolute single-line path"],
  scope: [(v) => v === "global", 'must be "global" or absent'],
  rule: [(v) => singleLine(v, 400), "must be one nonempty line of at most 400 characters"],
  evidence: [(v) => singleLine(v, 2000), "must be one nonempty line of at most 2000 characters"],
  outcome: [isLessonOutcome, `must be one of ${OUTCOMES.join(", ")}`],
  marked: [(v) => v === undefined || isoTime(v), "must be an ISO time as toISOString writes it"],
};

/** The first rule a record breaks, or undefined when it is a valid lesson. */
const problemOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "lesson record must be a JSON object";
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((name) => !(FIELDS as readonly string[]).includes(name));
  if (unknown !== undefined) return `unknown lesson field "${unknown}"`;
  // A repo lesson has a cwd and no scope; a global lesson has scope "global" and no cwd.
  const global = record["scope"] === "global";
  if (global && "cwd" in record) return 'a global lesson has no field "cwd"';
  const absent = global ? "cwd" : "scope";
  for (const name of FIELDS) {
    if (name === absent && !(name in record)) continue;
    const [ok, rule] = checks[name];
    if (!ok(record[name])) return `lesson field "${name}" ${rule}`;
  }
  return undefined;
};

// Exact canonical cwd scopes lessons without running git or matching unrelated repos.
const scope = (cwd: string): string => {
  if (!singleLine(cwd, 4096)) throw new Refusal("cwd must be a nonempty single-line path");
  const path = resolve(cwd);
  return existsSync(path) ? realpathSync(path) : path;
};

export const lessonsPath = (root: string): string => join(root, "lessons.jsonl");

function append(root: string, lesson: Lesson): void {
  mkdirSync(root, { recursive: true });
  // One O_APPEND write per full record. A writer that stopped mid-record left no newline: start on a fresh line, so
  // the torn line stays one damaged line and this record stays whole.
  const fd = openSync(lessonsPath(root), "a+", 0o600);
  try {
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(lesson)}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Every valid lesson (the last record per id), newest first, optionally only those for realpath(cwd), and a problem
 * line for each damaged record: bad JSON, a broken field, or a later record that changed a field fixed at add time.
 */
export function listLessons(root: string, cwd?: string): LessonRead {
  const path = lessonsPath(root);
  if (!existsSync(path)) return { lessons: [], problems: [] };
  const latest = new Map<string, Lesson>();
  const problems: string[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new DamagedLesson("not valid JSON");
      }
      const problem = problemOf(value);
      if (problem) throw new DamagedLesson(problem);
      const lesson = value as Lesson;
      const previous = latest.get(lesson.id);
      const changed = previous && IMMUTABLE.find((name) => previous[name] !== lesson[name]);
      if (changed) throw new DamagedLesson(`lesson field "${changed}" changed for ${lesson.id}; it is fixed once recorded`);
      latest.set(lesson.id, lesson);
    } catch (e) {
      if (!(e instanceof DamagedLesson)) throw e;
      problems.push(`${path}:${index + 1}: ${e.message}`);
    }
  }
  const target = cwd === undefined ? undefined : scope(cwd);
  // Reverse first so that among lessons added in the same millisecond the later one still sorts first.
  const lessons = [...latest.values()].reverse()
    .filter((l) => target === undefined || l.scope === "global" || l.cwd === target)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { lessons, problems };
}

/** Appends a new pending lesson for realpath(cwd), or a global one (`global: true`, no cwd). Refuses a rule or evidence that is not one short line, or a bad lane key. */
export function addLesson(root: string, input: LessonInput, now: number): Lesson {
  const where = input.global ? { scope: "global" as const } : { cwd: scope(input.cwd) };
  const lesson = {
    id: randomUUID(), at: new Date(now).toISOString(), lane: input.lane ?? LEAD_LANE, ...where,
    rule: input.rule, evidence: input.evidence, outcome: "pending" as const,
  };
  const problem = problemOf(lesson);
  if (problem) throw new Refusal(problem.replace(/^lesson field "(\w+)"/, "$1"));
  append(root, lesson);
  return lesson;
}

/** Records an outcome for a lesson by appending it again with the new outcome and mark time. Refuses an unknown id. */
export function markLesson(root: string, id: string, outcome: LessonMark, now: number): Lesson {
  if (!isLessonMark(outcome)) throw new Refusal(`outcome must be one of ${MARKS.join(", ")}`);
  const previous = listLessons(root).lessons.find((l) => l.id === id);
  if (!previous) throw new Refusal(`no lesson ${JSON.stringify(id)}`);
  const updated: Lesson = { ...previous, outcome, marked: new Date(now).toISOString() };
  append(root, updated);
  return updated;
}

/**
 * The lessons a new lane in cwd gets, newest first: up to GLOBAL_LESSONS global ones, then up to BRIEF_LESSONS pending
 * or helped ones for the repo, and the read's problems.
 */
export function lessonsForRepo(root: string, cwd: string): LessonRead {
  const { lessons, problems } = listLessons(root, cwd);
  const current = lessons.filter((l) => l.outcome === "pending" || l.outcome === "helped");
  const global = current.filter((l) => l.scope === "global").slice(0, GLOBAL_LESSONS);
  const repo = current.filter((l) => l.scope !== "global").slice(0, BRIEF_LESSONS);
  return { lessons: [...global, ...repo], problems };
}

/** Markdown for the brief: global lessons under GLOBAL_LESSONS_HEADING, then the repo's under LESSONS_HEADING; "" when none. */
export function lessonsBlock(root: string, cwd: string): string {
  return renderLessons(lessonsForRepo(root, cwd).lessons);
}

/** The markdown lessonsBlock writes for a given list. */
const section = (heading: string, lessons: readonly Lesson[]): string => lessons.length
  ? `${heading}\n${lessons.map((l) => `- [${l.outcome}; ${l.lane}] ${l.rule}`).join("\n")}\n\n`
  : "";

export const renderLessons = (lessons: readonly Lesson[]): string =>
  section(GLOBAL_LESSONS_HEADING, lessons.filter((l) => l.scope === "global")) +
  section(LESSONS_HEADING, lessons.filter((l) => l.scope !== "global"));

/** `LESSON_WARNING <path>:<line>: <reason>` for each damaged record. */
export const lessonWarnings = (problems: readonly string[]): string[] => problems.map((p) => `LESSON_WARNING ${p}`);

/** The line `lesson add` prints. */
export const formatLessonAdded = (l: Lesson): string => `LESSON ${l.id} pending ${l.lane} ${l.cwd ?? "global"}`;

/** The line `lesson mark` prints. */
export const formatLessonMarked = (l: Lesson): string => `MARKED ${l.id} ${l.outcome}`;

/**
 * The lines `lesson list` prints: warnings first, then per lesson a header line
 * `<id> <outcome> <added> <lane> <cwd>` and indented rule and evidence lines; `EMPTY` when there is no lesson.
 */
export function formatLessons(read: LessonRead): string[] {
  const lines = lessonWarnings(read.problems);
  if (read.lessons.length === 0) return [...lines, "EMPTY"];
  for (const l of read.lessons) {
    lines.push(`${l.id} ${l.outcome}${l.marked ? ` (marked ${l.marked})` : ""} ${l.at} ${l.lane} ${l.cwd ?? "global"}`);
    lines.push(`  rule: ${l.rule}`, `  evidence: ${l.evidence}`);
  }
  return lines;
}
