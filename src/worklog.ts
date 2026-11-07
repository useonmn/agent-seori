import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./harness.ts";

// The lead's list of owner requests: `$SEORI_HOME/worklog.jsonl` is the record, one O_APPEND write per change, so
// concurrent writers never lose each other's lines. `$SEORI_HOME/worklog.md` is rendered from it after every change
// for the lead to read; a compacted or restarted lead resumes from the record (seori boot lists the open items).

export type WorklogItem = {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly openedAt: string;
  readonly next?: string;
  readonly notes: readonly { readonly at: string; readonly text: string }[];
  readonly closedAt?: string;
  readonly result?: string;
};

type Event =
  | { readonly op: "add"; readonly id: string; readonly at: string; readonly title: string; readonly source: string }
  | { readonly op: "next"; readonly id: string; readonly at: string; readonly text: string }
  | { readonly op: "note"; readonly id: string; readonly at: string; readonly text: string }
  | { readonly op: "close"; readonly id: string; readonly at: string; readonly result: string };

/** problems are damage (named, the line skipped); warnings are the normal results of racing writers, still worth naming. */
export type WorklogRead = { readonly items: WorklogItem[]; readonly problems: string[]; readonly warnings: string[] };

/** A refused worklog change (unknown or closed item, text that is not one line, a worklog.md seori did not write): exit 2. */
export class WorklogError extends Refusal {}

/** First line of a worklog.md seori wrote. A file without it is someone's notes and is never replaced. */
export const WORKLOG_MARKER = "<!-- written by seori worklog from worklog.jsonl; change it with the command -->";

export const worklogPath = (root: string): string => join(root, "worklog.jsonl");
export const worklogMarkdownPath = (root: string): string => join(root, "worklog.md");

const ID = /^[0-9a-f]{8}$/;
const LIMITS = { add: { title: 200, source: 400 }, next: { text: 1000 }, note: { text: 1000 }, close: { result: 1000 } } as const;

// C0 and C1 controls (C1 holds U+0085 NEL and the CSI \x9b), DEL, and the Unicode line and paragraph separators.
const singleLine = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
const isoTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const parseEvent = (value: unknown): Event => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorklogError("worklog record must be a JSON object");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !ID.test(record.id)) throw new WorklogError('worklog field "id" must be 8 lowercase hex digits');
  if (!isoTime(record.at)) throw new WorklogError('worklog field "at" must be an ISO time as toISOString writes it');
  const wanted: Record<string, number> | undefined =
    typeof record.op === "string" && Object.hasOwn(LIMITS, record.op) ? LIMITS[record.op as keyof typeof LIMITS] : undefined;
  if (!wanted) throw new WorklogError('worklog field "op" must be add, next, note or close');
  const unknown = Object.keys(record).find((name) => !["op", "id", "at", ...Object.keys(wanted)].includes(name));
  if (unknown !== undefined) throw new WorklogError(`unknown worklog field "${unknown}"`);
  for (const [name, max] of Object.entries(wanted)) {
    if (!singleLine(record[name], max)) throw new WorklogError(`worklog field "${name}" must be one nonempty line of at most ${max} characters`);
  }
  return record as Event;
};

// Every record is JSON.stringify of an event built op first, so it starts with this.
const RECORD_START = '{"op":"';
/** A line that does not parse but begins like a record is a write cut off halfway: harmless, and skipped quietly. */
const isTorn = (line: string): boolean => line.startsWith(RECORD_START) || RECORD_START.startsWith(line);

const ownedOrAbsent = (path: string): boolean => !existsSync(path) || readFileSync(path, "utf8").split("\n", 1)[0] === WORKLOG_MARKER;

/**
 * Writes a rendered worklog.md through a temp file and rename, so a reader never sees half a file. The marker is checked
 * again right before the rename: a file someone wrote meanwhile is kept and this publish is skipped (returns false).
 * `beforeCheck` runs between the temp write and that check (tests use it to stage the race).
 */
export const publishWorklog = (path: string, markdown: string, beforeCheck: () => void = () => {}): boolean => {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, markdown, { encoding: "utf8", mode: 0o600 });
    beforeCheck();
    if (!ownedOrAbsent(path)) return false;
    renameSync(tmp, path);
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
};

/**
 * Publishes a view of an append-only record until the record stopped growing during the publish. Another writer that
 * appended meanwhile may have published before us, leaving our older view last, so we publish again: the last publish
 * to finish always holds every record, without a lock. Sizes are compared in bytes as read (a line cut inside a
 * multi-byte character decodes to a different length, and the sizes would then never match).
 */
export const renderUntilStable = (read: () => Buffer, publish: (record: string) => void, size: () => number): string => {
  for (;;) {
    const bytes = read();
    const record = bytes.toString("utf8");
    publish(record);
    if (size() === bytes.length) return record;
  }
};

/** Folds the record's text into items. Damaged lines are named in problems and skipped; a torn line is skipped quietly. */
const fold = (path: string, text: string): WorklogRead => {
  const items = new Map<string, WorklogItem>();
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (!isTorn(line)) problems.push(`${path}:${index + 1}: ${error.message}`);
      continue;
    }
    try {
      const event = parseEvent(value);
      const item = items.get(event.id);
      if (event.op === "add") {
        if (item) throw new WorklogError(`worklog item ${event.id} was already added`);
        items.set(event.id, { id: event.id, title: event.title, source: event.source, openedAt: event.at, notes: [] });
        continue;
      }
      if (!item) throw new WorklogError(`worklog item ${event.id} was never added`);
      // Two writers can both see the item open and append. The first close wins; a second close is that race's normal
      // result and a no-op, and a next or note after the close is ignored and named as a warning.
      if (item.closedAt !== undefined && event.op === "close") continue;
      if (item.closedAt !== undefined) {
        warnings.push(`${path}:${index + 1}: worklog item ${event.id} was already closed; ${event.op} ignored`);
        continue;
      }
      if (event.op === "next") items.set(event.id, { ...item, next: event.text });
      else if (event.op === "note") items.set(event.id, { ...item, notes: [...item.notes, { at: event.at, text: event.text }] });
      else items.set(event.id, { ...item, closedAt: event.at, result: event.result });
    } catch (error) {
      if (!(error instanceof WorklogError)) throw error;
      problems.push(`${path}:${index + 1}: ${error.message}`);
    }
  }
  return { items: [...items.values()], problems, warnings };
};

/** Reads and folds the whole record; a missing file is an empty worklog. Never writes. */
export function worklogRead(root: string): WorklogRead {
  const path = worklogPath(root);
  return fold(path, existsSync(path) ? readFileSync(path, "utf8") : "");
}

/** `seori worklog list [--open]`: every item (oldest first), or only the open ones, with the record's problems and warnings. */
export function worklogList(root: string, opts: { open?: boolean } = {}): WorklogRead {
  const read = worklogRead(root);
  return opts.open ? { ...read, items: read.items.filter((item) => item.closedAt === undefined) } : read;
}

/** Records an owner request when it arrives. Title and source are each one line; the id is 8 random hex digits. */
export function worklogAdd(root: string, title: string, source: string, now: number): WorklogItem {
  const known = new Set(worklogRead(root).items.map((item) => item.id));
  let id = randomBytes(4).toString("hex");
  while (known.has(id)) id = randomBytes(4).toString("hex");
  return write(root, { op: "add", id, at: new Date(now).toISOString(), title: title.trim(), source: source.trim() });
}

/** Sets the open item's next step (replaces the previous one). */
export function worklogNext(root: string, id: string, text: string, now: number): WorklogItem {
  openItem(root, id);
  return write(root, { op: "next", id, at: new Date(now).toISOString(), text: text.trim() });
}

/** Adds a note to the open item (a decision, an owner, a lane started for it). */
export function worklogNote(root: string, id: string, text: string, now: number): WorklogItem {
  openItem(root, id);
  return write(root, { op: "note", id, at: new Date(now).toISOString(), text: text.trim() });
}

/** Closes the open item with what came of it. */
export function worklogClose(root: string, id: string, result: string, now: number): WorklogItem {
  openItem(root, id);
  return write(root, { op: "close", id, at: new Date(now).toISOString(), result: result.trim() });
}

function openItem(root: string, id: string): WorklogItem {
  const item = worklogRead(root).items.find((candidate) => candidate.id === id);
  if (!item) throw new WorklogError(`worklog item not found: ${id}`);
  if (item.closedAt !== undefined) throw new WorklogError(`worklog item ${id} is closed: ${item.result ?? ""}`);
  return item;
}

function write(root: string, event: Event): WorklogItem {
  parseEvent(event);
  const path = worklogPath(root);
  const markdownPath = worklogMarkdownPath(root);
  mkdirSync(root, { recursive: true });
  // Checked before the append, so a refused render leaves the record unchanged too.
  if (!ownedOrAbsent(markdownPath)) throw new WorklogError(`${markdownPath} was not written by seori worklog; move it aside before using the command`);
  const fd = openSync(path, "a+", 0o600);
  try {
    // A writer that stopped mid-record left no newline: start on a fresh line so only the torn line is damaged.
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(event)}\n`);
  } finally {
    closeSync(fd);
  }
  const text = renderUntilStable(
    () => readFileSync(path),
    (record) => {
      publishWorklog(markdownPath, renderWorklog(fold(path, record).items));
    },
    () => statSync(path).size,
  );
  const item = fold(path, text).items.find((candidate) => candidate.id === event.id);
  if (!item) throw new Error(`worklog item ${event.id} did not read back from ${path}`);
  return item;
}

const itemBlock = (item: WorklogItem): string =>
  [
    `### ${item.id} ${item.title}`,
    `- Source: ${item.source}`,
    `- Opened: ${item.openedAt}`,
    `- Next: ${item.next ?? "(none yet)"}`,
    ...(item.notes.length ? ["- Notes:", ...item.notes.map((note) => `  - ${note.at} ${note.text}`)] : []),
    ...(item.closedAt !== undefined ? [`- Closed: ${item.closedAt}`, `- Result: ${item.result ?? ""}`] : []),
  ].join("\n");

/** worklog.md: the marker, open items oldest first, then closed items newest first. */
export const renderWorklog = (items: readonly WorklogItem[]): string => {
  const open = items.filter((item) => item.closedAt === undefined);
  const closed = items.filter((item) => item.closedAt !== undefined).reverse();
  const section = (title: string, list: readonly WorklogItem[]) => `## ${title}\n\n${list.length ? list.map(itemBlock).join("\n\n") : "(none)"}\n`;
  return `${WORKLOG_MARKER}\n# Worklog\n\n${section("Open", open)}\n${section("Closed", closed)}`;
};

/** What `seori worklog add|next|note|close` prints: the item as saved, one JSON line. */
export const worklogItemLine = (item: WorklogItem): string => JSON.stringify(item);

/**
 * What `seori worklog list` prints: `stdout` is the items as indented JSON, `stderr` one `WORKLOG_WARNING <text>` line
 * per damaged line or ignored race (the command still exits 0; the record stays usable).
 */
export const worklogListOutput = (read: WorklogRead): { stdout: string; stderr: string[] } => ({
  stdout: JSON.stringify(read.items, null, 2),
  stderr: [...read.problems, ...read.warnings].map((problem) => `WORKLOG_WARNING ${problem}`),
});

/** The open items as seori boot shows them: a count, then `OPEN <id> "<title>" source="<source>" next="<next>"` each. */
export const worklogLines = (items: readonly WorklogItem[]): string[] => {
  const open = items.filter((item) => item.closedAt === undefined);
  return [
    `WORKLOG open=${open.length}`,
    ...open.map((item) => `OPEN ${item.id} ${JSON.stringify(item.title)} source=${JSON.stringify(item.source)} next=${JSON.stringify(item.next ?? "")}`),
  ];
};
