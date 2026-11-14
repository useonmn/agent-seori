// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { mkdirSync, readdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, rmSync, linkSync, statSync } from "node:fs";
import { homedir, hostname, uptime } from "node:os";
import { join } from "node:path";
import { HerdrRecord, refFromText, refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { Workflow } from "./workflow.ts";

/**
 * working/waiting: the lane runs. ready: it sent READY (a done claim). paused: the owner said wait (seori pause; its goal
 * is paused and duty leaves it alone until seori resume). done: closed. lost: its pane went away without READY.
 */
export type LaneStatus = "working" | "waiting" | "ready" | "paused" | "done" | "lost";

/** Per-lane ceilings; null switches one off. Reaching one blocks the lane (a report to the lead), it is never killed. */
export type Ceilings = { wallMinutes: number | null; tokens: number | null; costUsd: number | null };

export type LaneLogKind =
  | "start" | "report" | "ready" | "nudge" | "done" | "lost"
  | "object" | "pause" | "resume" | "blocked" | "stalled" | "posted";

/**
 * One lane record. `sessionRef` is the hc terminal it runs in; `paneId`/`tabId` are written beside it (the ref's id and
 * "") so an older binary still reads the file. Read `sessionRef`, never `paneId`.
 */
export type Lane = {
  key: string;
  sessionRef: SessionRef;
  paneId: string;
  tabId: string;
  brief: string;
  cwd: string;
  /**
   * The worktree seori gave the lane because its cwd was the checkout seori runs from (src/harness.ts laneWorktree):
   * its pane starts there, and the stall check and Done-line signals read it instead of cwd.
   */
  worktree?: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  nudges: number;
  final?: { text: string; evidence: string[]; at: number };
  /** The `Done =` line from `seori start --done`: signals seori reads back live before the lane may close (src/signals.ts). */
  done?: string;
  /** The lead channel id of the owner's message this lane works on (e.g. `telegram:42:5`); progress posts attach to it. */
  thread?: string;
  /** The lead's last objection to a READY claim; a new READY clears it. */
  objection?: { at: number; reasons: string[] };
  /** The status a paused lane returns to on resume. */
  pausedFrom?: LaneStatus;
  ceilings?: Ceilings;
  /** `seori start --activity-path`: files or directories (relative to cwd) whose change counts as progress (src/supervision.ts). */
  activityPaths?: string[];
  /** `seori start --model`: the model this lane's omp runs with instead of SEORI_MODEL. */
  model?: string;
  /** The workflow this lane's kickoff named (src/workflow.ts). */
  workflow?: Workflow;
  /** Once-per-change alert marks (ceiling reached, stalled, ...): key -> when it was raised. */
  alerts?: Record<string, number>;
  /** When duty first saw the lane's pane `blocked` (a dialog open) in the current spell; cleared once it is not. */
  blockedSince?: number;
  /** The last report posted to `thread`, and when. */
  posted?: { at: number; text: string };
  log: { at: number; kind: LaneLogKind; text: string }[];
};

export type Role = "lead" | "duty";

/**
 * A delivery that failed after the message may have reached the session (#89): it may or may not have arrived, so it
 * is held, never resent automatically.
 */
export type DeliveryAttempt = { at: number; state: "ambiguous"; detail?: string };

/** A flush lock from another host (or an unreadable one) older than this is taken over; on this host only a dead pid frees it (#108). */
export const INBOX_LOCK_STALE_MS = 60_000;
/** How long enqueue waits for an inbox's append lock (held for one file write or rename at a time). */
const APPEND_LOCK_WAIT_MS = 2_000;
const APPEND_LOCK_RETRY_MS = 10;

export type QueuedMessage = { at: number; from: string; text: string; attempt?: DeliveryAttempt };

export type ReviewReceipt = {
  pr: string;
  sha: string;
  verdict: "CLEAR" | "BLOCK";
  model: string;
  at: number;
  summary: string;
};

export type ItemStatus = "open" | "running" | "done" | "dropped";

/** One backlog entry. Its id is the lane key the hourly loop starts it under. */
export type Item = {
  id: string;
  title: string;
  brief: string;
  cwd: string;
  priority: number;
  status: ItemStatus;
  decision?: string;
  askedAt?: number;
  remindedAt?: number;
  attempts: number;
  startFailures?: number;
  source?: string;
  createdAt: number;
  updatedAt: number;
  log: { at: number; kind: "add" | "start" | "reopen" | "done" | "drop" | "ask" | "remind" | "decide"; text: string }[];
};

/** `load1`: the 1-minute load average, null when the host reports none. */
export type HostLoad = { load1: number | null; cores: number; memFreePct: number };

export type LoopRun = {
  at: number;
  skipped?: string;
  status?: {
    lanes: number;
    maxLanes: number;
    adhoc: string[];
    items: { open: number; decide: number; running: number };
    host: HostLoad;
  };
  synced: string[];
  findings: string[];
  started: string[];
  held: string[];
  asked: string[];
};

export const KEEP_RUNS = 168;
export const KEY_RE = /^[a-z][a-z0-9-]{1,40}$/;
/** Role names are send targets, and resolveTarget tries roles first, so a lane with one of these keys could never be reached. */
export const RESERVED_KEYS: readonly Role[] = ["lead", "duty"];
/** Refusal text for a reserved lane key, or undefined. Keys are lowercase-only (KEY_RE), so the exact match is the whole check. */
export const reservedKey = (key: string): string | undefined =>
  (RESERVED_KEYS as readonly string[]).includes(key) ? `lane key "${key}" is reserved for the ${key} role` : undefined;

/** A lane file as any binary wrote it: one from a herdr seori has no `sessionRef`, or a herdr one. */
export type StoredLane = Omit<Lane, "sessionRef"> & { sessionRef?: { runtime: string; id: string } };

/**
 * The lane of an hc record. A closed (done or lost) herdr record is history with nothing to address: undefined, so it
 * never blocks the hc lanes. An open one is refused (HerdrRecord) with the file it came from.
 */
export const checkedLane = (raw: StoredLane, file: string): Lane | undefined => {
  const ref = raw.sessionRef;
  if (ref?.runtime === "hc") return raw as Lane;
  if (raw.status === "done" || raw.status === "lost") return undefined;
  throw new HerdrRecord(file, ref?.id ?? raw.paneId);
};

// Inbox files: one JSONL queue per session, `hc--t7.jsonl`. A file without that prefix is a herdr pane's queue.
const HC_INBOX_PREFIX = "hc--";

const inboxName = (ref: SessionRef): string => `${HC_INBOX_PREFIX}${ref.id}`;

const readQueue = (path: string): QueuedMessage[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as QueuedMessage) : [];

const checkedId = (id: string): string => {
  if (!KEY_RE.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: must match ${KEY_RE}`);
  return id;
};

const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Whether a process with this pid exists on this host (EPERM: it exists but belongs to another user). */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Slack for the boot time: os.uptime() has whole-second precision and an NTP step right after boot shifts the wall clock,
 * so a lock is judged pre-boot only when it is clearly older than the boot.
 */
const BOOT_SLACK_MS = 60_000;

/** Wall-clock time this boot clearly started at: a lock or record file modified before it was written before this boot. */
export const bootCutoff = (): number => Date.now() - uptime() * 1000 - BOOT_SLACK_MS;

/** An unreadable lock (a holder that died between create and write) is judged by the file's age. */
function lockStale(path: string, content: string, now: number): boolean {
  let lock: { pid?: unknown; host?: unknown; at?: unknown } = {};
  try {
    lock = JSON.parse(content) as typeof lock;
  } catch {
    // fall through to the file's mtime
  }
  const mtime = (): number => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return now;
    }
  };
  // On this host the pid decides: a live holder keeps its lock however long an hc call takes, or a second flush
  // would deliver the same batch again. The age rule is only for locks from another host or locks that can't be read.
  // A lock written before this boot is stale whatever its pid says: after a reboot an unrelated process may own that
  // pid, and long-lived locks (daemon, lead consumer) would otherwise stay held forever. The file's mtime is the wall
  // clock it was written at; `at` is the caller's clock, which tests inject.
  if (lock.host === hostname() && typeof lock.pid === "number")
    return mtime() < bootCutoff() || !pidAlive(lock.pid);
  const at = typeof lock.at === "number" ? lock.at : mtime();
  return now - at > INBOX_LOCK_STALE_MS;
}

/**
 * Takes the lock at `path` (created O_EXCL, holding pid, host and time) and returns its release, or undefined while
 * another process holds it. A lock whose pid is dead on this host or that was written before this boot, or one from
 * another host (or unreadable) older than INBOX_LOCK_STALE_MS, is taken over: it is renamed aside first, and when what
 * was renamed is not the lock judged stale (another process took it over in between), it is put back and the lock
 * counts as held.
 */
export function lockFile(path: string, now: number): (() => void) | undefined {
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: now });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, mine, { flag: "wx" });
      return () => {
        if (readOrUndefined(path) === mine) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const seen = readOrUndefined(path);
    if (seen === undefined) continue;
    if (!lockStale(path, seen, now)) return undefined;
    const aside = `${path}.${process.pid}.stale`;
    try {
      renameSync(path, aside);
    } catch {
      continue;
    }
    if (readOrUndefined(aside) !== seen) {
      try {
        linkSync(aside, path);
      } catch {
        // a third process holds the lock now; either way it is not ours
      }
      rmSync(aside, { force: true });
      return undefined;
    }
    rmSync(aside, { force: true });
  }
  return undefined;
}

export class Store {
  /** Set on a view from skippingHerdr: a live herdr record is reported here and skipped instead of refused. */
  private onHerdr?: (e: HerdrRecord) => void;

  constructor(readonly root: string = process.env["SEORI_HOME"] ?? join(homedir(), ".seori")) {
    // The home holds secrets and the owner's messages: one seori creates is the owner's alone. An existing one keeps its mode.
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const d of ["lanes", "inbox", "briefs", "receipts", "backlog", "loop/runs", "duty"]) mkdirSync(join(root, d), { recursive: true });
  }

  private readJson<T>(path: string): T | undefined {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
  }

  /**
   * One lane by key. A closed (done or lost) herdr record reads back as the history it is, so `seori done` says it is
   * already closed; its ref keeps the herdr pane id and is never addressed (only open lanes are). lanes() skips it.
   */
  lane(key: string): Lane | undefined {
    const file = join(this.root, "lanes", `${key}.json`);
    const raw = this.readJson<StoredLane>(file);
    if (raw === undefined) return undefined;
    if (raw.sessionRef?.runtime !== "hc" && (raw.status === "done" || raw.status === "lost")) {
      return { ...raw, sessionRef: { runtime: "hc", id: raw.sessionRef?.id ?? raw.paneId } };
    }
    return checkedLane(raw, file);
  }

  /** Writes `paneId`/`tabId` beside `sessionRef`, so an older binary still reads the record. */
  saveLane(lane: Lane): void {
    this.writeJson(join(this.root, "lanes", `${lane.key}.json`), { ...lane, paneId: lane.sessionRef.id, tabId: "" });
  }

  /**
   * A view of this store whose lanes() and inboxPanes() skip a live herdr record, reporting it to `report`, instead of
   * refusing it: the duty pass names the file and still supervises every hc lane. The view inherits from this store, so
   * every Store method must keep its state on `this` (no `#private` fields or arrow-function properties): a test checks
   * that writes through the view reach the same files.
   */
  skippingHerdr(report: (e: HerdrRecord) => void): Store {
    return Object.assign(Object.create(this) as Store, { onHerdr: report });
  }

  /** `e` refused a record: rethrown, or reported and skipped on a skippingHerdr view. */
  private herdrRefused(e: unknown): [] {
    if (!(e instanceof HerdrRecord) || this.onHerdr === undefined) throw e;
    this.onHerdr(e);
    return [];
  }

  lanes(): Lane[] {
    return readdirSync(join(this.root, "lanes"))
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        const file = join(this.root, "lanes", f);
        const raw = this.readJson<StoredLane>(file);
        try {
          const lane = raw && checkedLane(raw, file);
          return lane === undefined ? [] : [lane];
        } catch (e) {
          return this.herdrRefused(e);
        }
      })
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  laneBySession(ref: SessionRef): Lane | undefined {
    return this.lanes().find((l) => sameSession(l.sessionRef, ref) && l.status !== "done");
  }

  /** roles.json holds ref strings (refText); a value that is not an hc ref (a herdr pane) is refused. */
  roles(): Partial<Record<Role, SessionRef>> {
    const file = join(this.root, "roles.json");
    const raw = this.readJson<Partial<Record<Role, string>>>(file) ?? {};
    return Object.fromEntries(Object.entries(raw).map(([role, text]) => [role, refFromText(text, file)]));
  }

  setRole(role: Role, ref: SessionRef): void {
    const raw = this.readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    this.writeJson(join(this.root, "roles.json"), { ...raw, [role]: refText(ref) });
  }

  briefPath(key: string): string {
    return join(this.root, "briefs", `${key}.md`);
  }

  inboxPath(ref: SessionRef): string {
    return join(this.root, "inbox", `${inboxName(ref)}.jsonl`);
  }

  /** Appends under the session's append lock, so a rewrite of that inbox (rewriteInbox) never drops the entry. */
  enqueue(ref: SessionRef, msg: QueuedMessage): void {
    const release = this.waitAppend(ref);
    try {
      appendFileSync(this.inboxPath(ref), JSON.stringify(msg) + "\n");
    } finally {
      release();
    }
  }

  /**
   * Replaces the session's inbox with `edit` of its entries, read and written under its append lock, so an entry a
   * sender appends meanwhile is never overwritten: it waits and lands after the write.
   */
  rewriteInbox(ref: SessionRef, edit: (msgs: QueuedMessage[]) => readonly QueuedMessage[]): void {
    const release = this.waitAppend(ref);
    try {
      this.saveInbox(ref, edit(this.queued(ref)));
    } finally {
      release();
    }
  }

  private waitAppend(ref: SessionRef): () => void {
    const deadline = Date.now() + APPEND_LOCK_WAIT_MS;
    let release = this.lockAppend(ref, Date.now());
    while (!release) {
      if (Date.now() >= deadline) throw new Error(`the inbox of ${refText(ref)} stays locked (${this.inboxPath(ref)}.append.lock)`);
      Bun.sleepSync(APPEND_LOCK_RETRY_MS);
      release = this.lockAppend(ref, Date.now());
    }
    return release;
  }

  /**
   * The session's append lock (`<inbox>.append.lock`): enqueue holds it across the append, rewriteInbox across its
   * read and write. Never held across a delivery.
   */
  lockAppend(ref: SessionRef, now: number): (() => void) | undefined {
    return lockFile(`${this.inboxPath(ref)}.append.lock`, now);
  }

  queued(ref: SessionRef): QueuedMessage[] {
    return readQueue(this.inboxPath(ref));
  }

  saveInbox(ref: SessionRef, msgs: readonly QueuedMessage[]): void {
    writeFileSync(this.inboxPath(ref), msgs.map((m) => JSON.stringify(m) + "\n").join(""));
  }

  /** The session's inbox lock (`<inbox>.lock`): one flush per session at a time, across processes. See lockFile. */
  lockInbox(ref: SessionRef, now: number): (() => void) | undefined {
    return lockFile(`${this.inboxPath(ref)}.lock`, now);
  }

  /**
   * Sessions with queued messages. A herdr pane's inbox (no `hc--` prefix) that is empty is skipped; one that still
   * holds entries is refused (HerdrRecord, or reported and skipped on a skippingHerdr view), since nothing on hc can
   * deliver them.
   */
  inboxPanes(): SessionRef[] {
    const dir = join(this.root, "inbox");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f): SessionRef[] => {
        const stem = f.slice(0, -".jsonl".length);
        if (stem.startsWith(HC_INBOX_PREFIX)) return [{ runtime: "hc", id: stem.slice(HC_INBOX_PREFIX.length) }];
        const left = readQueue(join(dir, f)).length;
        if (left === 0) return [];
        const fix = `read its ${left} queued message(s), then remove ${join(dir, f)} (they are dropped with it)`;
        return this.herdrRefused(new HerdrRecord(join(dir, f), stem.replaceAll("_", ":"), fix));
      })
      .filter((r) => this.queued(r).length > 0);
  }


  private receiptPath(pr: string, sha: string): string {
    return join(this.root, "receipts", `${pr.replaceAll("/", "__").replace("#", "_")}@${sha}.json`);
  }

  saveReceipt(r: ReviewReceipt): void {
    this.writeJson(this.receiptPath(r.pr, r.sha), r);
  }

  receipt(pr: string, sha: string): ReviewReceipt | undefined {
    return this.readJson(this.receiptPath(pr, sha));
  }

  // ---------- backlog ----------

  itemBrief(id: string): string {
    return join(this.root, "backlog", `${checkedId(id)}.md`);
  }

  item(id: string): Item | undefined {
    return this.readJson<Item>(join(this.root, "backlog", `${checkedId(id)}.json`));
  }

  saveItem(item: Item): void {
    this.writeJson(join(this.root, "backlog", `${checkedId(item.id)}.json`), item);
  }

  items(): Item[] {
    return readdirSync(join(this.root, "backlog"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<Item>(join(this.root, "backlog", f)))
      .filter((i): i is Item => i !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  // ---------- hourly loop ----------

  loopPath(name: string): string {
    return join(this.root, "loop", name);
  }

  /** The kill switch of the hourly loop (`loop/stop`) or of the duty loop (`duty/stop`). */
  stop(of: "loop" | "duty" = "loop"): { at: number; reason: string } | undefined {
    return this.readJson(join(this.root, of, "stop"));
  }

  setStop(at: number, reason: string, of: "loop" | "duty" = "loop"): void {
    this.writeJson(join(this.root, of, "stop"), { at, reason });
  }

  clearStop(of: "loop" | "duty" = "loop"): void {
    rmSync(join(this.root, of, "stop"), { force: true });
  }

  lastRun(): LoopRun | undefined {
    return this.readJson(this.loopPath("last-run.json"));
  }

  /** Writes the run record and the last-run stamp, keeping the newest KEEP_RUNS records. Pass `name` to rewrite a record. */
  saveRun(run: LoopRun, name?: string): string {
    const dir = this.loopPath("runs");
    if (name === undefined) {
      const stem = new Date(run.at).toISOString().replaceAll(":", "-");
      name = `${stem}.json`;
      for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}.json`;
    }
    this.writeJson(join(dir, name), run);
    this.writeJson(this.loopPath("last-run.json"), run);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) rmSync(join(dir, f), { force: true });
    return name;
  }

  runs(): string[] {
    return readdirSync(this.loopPath("runs")).filter((f) => f.endsWith(".json")).sort();
  }
}
