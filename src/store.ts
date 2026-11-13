// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { mkdirSync, readdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, rmSync, linkSync, statSync } from "node:fs";
import { homedir, hostname, uptime } from "node:os";
import { join } from "node:path";
import { refFromText, refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";

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
 * One lane record. `sessionRef` is the session it runs in, on whichever runtime opened it; `paneId`/`tabId` are written
 * beside it (the ref's id and container) so an older binary still reads the file. Read `sessionRef`, never `paneId`.
 */
export type Lane = {
  key: string;
  sessionRef: SessionRef;
  paneId: string;
  tabId: string;
  brief: string;
  cwd: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  nudges: number;
  final?: { text: string; evidence: string[]; at: number };
  /** The `Done =` line from `seori start --done`: signals seori reads back live before the lane may close (src/signals.ts). */
  done?: string;
  /** The lead channel id of the owner's message this lane works on (e.g. `telegram:42:5`); progress posts thread under it. */
  thread?: string;
  /** The lead's last objection to a READY claim; a new READY clears it. */
  objection?: { at: number; reasons: string[] };
  /** The status a paused lane returns to on resume. */
  pausedFrom?: LaneStatus;
  ceilings?: Ceilings;
  /** `seori start --activity-path`: files or directories (relative to cwd) whose change counts as progress (src/supervision.ts). */
  activityPaths?: string[];
  /** Once-per-change alert marks (ceiling reached, stalled, ...): key -> when it was raised. */
  alerts?: Record<string, number>;
  /** When duty first saw the lane's pane `blocked` (a dialog open) in the current spell; cleared once it is not. */
  blockedSince?: number;
  /** The last report posted to `thread`, and when. */
  posted?: { at: number; text: string };
  /** The sessions the lane ran in before a `seori migrate`, oldest first. */
  migratedFrom?: SessionRef[];
  /** A `seori migrate` handover is in progress: the duty loop leaves the record alone (no nudge, no lost). */
  migration?: true;
  log: { at: number; kind: LaneLogKind; text: string }[];
};

export type Role = "lead" | "duty";

/**
 * A delivery that failed after the message may have reached the pane (#89). `typed`: the text is in the pane's input
 * and only Enter is retried; `agent` and `pgid` record which agent it was typed into (#108, see AgentIdentity).
 * `ambiguous`: it may or may not have arrived; it is held, never resent automatically.
 */
export type DeliveryAttempt = { at: number; state: "typed" | "ambiguous"; detail?: string; agent?: string; pgid?: number };

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

/** A lane file as any binary wrote it: one from before runtimes existed has no `sessionRef`. */
export type StoredLane = Omit<Lane, "sessionRef"> & { sessionRef?: SessionRef };

/** Reads a record without `sessionRef` as the herdr pane it names; the same input always gives the same lane. */
export const upgradeLane = (raw: StoredLane): Lane =>
  raw.sessionRef !== undefined
    ? (raw as Lane)
    : { ...raw, sessionRef: { runtime: "herdr", id: raw.paneId, ...(raw.tabId ? { container: raw.tabId } : {}) } };

// Inbox files: one JSONL queue per session. A herdr pane keeps the name it had before runtimes existed (`w1_p3.jsonl`),
// so queues written by an older binary drain; every other runtime is prefixed (`hc--t7.jsonl`).
const HC_INBOX_PREFIX = "hc--";

const inboxName = (ref: SessionRef): string =>
  ref.runtime === "herdr" ? ref.id.replaceAll(":", "_") : `${HC_INBOX_PREFIX}${ref.id}`;

const inboxRef = (stem: string): SessionRef =>
  stem.startsWith(HC_INBOX_PREFIX)
    ? { runtime: "hc", id: stem.slice(HC_INBOX_PREFIX.length) }
    : { runtime: "herdr", id: stem.replaceAll("_", ":") };

const readQueue = (path: string): QueuedMessage[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as QueuedMessage) : [];

const queueKey = (m: QueuedMessage): string => `${m.at}\u0000${m.from}\u0000${m.text}`;

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
  // On this host the pid decides: a live holder keeps its lock however long a herdr call takes, or a second flush
  // would deliver the same batch again. The age rule is only for locks from another host or locks that can't be read.
  // A lock written before this boot is stale whatever its pid says: after a reboot an unrelated process may own that
  // pid, and long-lived locks (daemon, lead consumer) would otherwise stay held forever. The file's mtime is the wall
  // clock it was written at; `at` is the caller's clock, which tests inject.
  if (lock.host === hostname() && typeof lock.pid === "number")
    return mtime() < Date.now() - uptime() * 1000 - BOOT_SLACK_MS || !pidAlive(lock.pid);
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
  constructor(readonly root: string = process.env["SEORI_HOME"] ?? join(homedir(), ".seori")) {
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

  lane(key: string): Lane | undefined {
    const raw = this.readJson<StoredLane>(join(this.root, "lanes", `${key}.json`));
    return raw && upgradeLane(raw);
  }

  /** Writes `paneId`/`tabId` from `sessionRef` beside it, so an older binary still reads the record. */
  saveLane(lane: Lane): void {
    const { id, container } = lane.sessionRef;
    this.writeJson(join(this.root, "lanes", `${lane.key}.json`), { ...lane, paneId: id, tabId: container ?? "" });
  }

  lanes(): Lane[] {
    return readdirSync(join(this.root, "lanes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<StoredLane>(join(this.root, "lanes", f)))
      .filter((l): l is StoredLane => l !== undefined)
      .map(upgradeLane)
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  laneBySession(ref: SessionRef): Lane | undefined {
    return this.lanes().find((l) => sameSession(l.sessionRef, ref) && l.status !== "done");
  }

  /** roles.json holds ref strings (refText), so an older binary still parses it; a bare value is a herdr pane. */
  roles(): Partial<Record<Role, SessionRef>> {
    const raw = this.readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    return Object.fromEntries(Object.entries(raw).map(([role, text]) => [role, refFromText(text)]));
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

  /**
   * Appends to the inbox of the session `ref` was forwarded to by a migration, if it was. Under ref's append lock, so
   * seori migrate never writes the forward marker or moves the file aside between the lookup and the append.
   */
  enqueue(ref: SessionRef, msg: QueuedMessage): void {
    const deadline = Date.now() + APPEND_LOCK_WAIT_MS;
    let release = this.lockAppend(ref, Date.now());
    while (!release) {
      if (Date.now() >= deadline) throw new Error(`the inbox of ${refText(ref)} stays locked (${this.inboxPath(ref)}.append.lock)`);
      Bun.sleepSync(APPEND_LOCK_RETRY_MS);
      release = this.lockAppend(ref, Date.now());
    }
    try {
      appendFileSync(this.inboxPath(this.forwardOf(ref) ?? ref), JSON.stringify(msg) + "\n");
    } finally {
      release();
    }
  }

  /**
   * The session's append lock (`<inbox>.append.lock`): enqueue holds it across the forward lookup and the append, seori
   * migrate across writing or removing the forward marker and moving the inbox aside. Never held across a delivery.
   */
  lockAppend(ref: SessionRef, now: number): (() => void) | undefined {
    return lockFile(`${this.inboxPath(ref)}.append.lock`, now);
  }

  queued(ref: SessionRef): QueuedMessage[] {
    return readQueue(this.inboxPath(ref));
  }

  // A `.forward` file beside an inbox (`w1_p3.jsonl.forward`, holding a ref) says that session moved (seori migrate):
  // new messages go to the ref's inbox, and entries a sender still appended to the old file are merged by the next flush.

  /** The session this one's inbox was forwarded to by a migration (its `.forward` marker), or undefined. */
  forwardOf(ref: SessionRef): SessionRef | undefined {
    const marker = `${this.inboxPath(ref)}.forward`;
    const text = readOrUndefined(marker)?.trim();
    return text ? refFromText(text) : undefined;
  }

  /** The old inbox files whose `.forward` marker names `ref`. */
  private forwardedInto(ref: SessionRef): string[] {
    const dir = join(this.root, "inbox");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl.forward"))
      .map((f) => join(dir, f.slice(0, -".forward".length)))
      .filter((old) => {
        const to = readOrUndefined(`${old}.forward`)?.trim();
        return Boolean(to) && sameSession(refFromText(to!), ref);
      });
  }

  /** True when an old inbox forwarded into `ref` still holds entries. */
  forwardPending(ref: SessionRef): boolean {
    return this.forwardedInto(ref).some((old) => readQueue(old).length > 0 || readQueue(`${old}.merging`).length > 0);
  }

  /**
   * Moves the entries of every old inbox forwarded into `ref` to the end of ref's inbox; call it under ref's inbox lock.
   * The old file is renamed aside first, so an append racing the merge lands in a fresh old file for the next one; an
   * entry ref's inbox already holds (a merge cut short after its append) is not added again.
   */
  mergeForwarded(ref: SessionRef): void {
    const into = this.inboxPath(ref);
    for (const old of this.forwardedInto(ref)) {
      const aside = `${old}.merging`;
      for (let pass = 0; pass < 2; pass++) {
        if (!existsSync(aside)) {
          try {
            renameSync(old, aside);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
            throw e;
          }
        }
        const seen = new Set(readQueue(into).map(queueKey));
        for (const m of readQueue(aside)) {
          if (seen.has(queueKey(m))) continue;
          seen.add(queueKey(m));
          appendFileSync(into, JSON.stringify(m) + "\n");
        }
        rmSync(aside, { force: true });
      }
    }
  }

  saveInbox(ref: SessionRef, msgs: readonly QueuedMessage[]): void {
    writeFileSync(this.inboxPath(ref), msgs.map((m) => JSON.stringify(m) + "\n").join(""));
  }

  /** The session's inbox lock (`<inbox>.lock`): one flush per session at a time, across processes. See lockFile. */
  lockInbox(ref: SessionRef, now: number): (() => void) | undefined {
    return lockFile(`${this.inboxPath(ref)}.lock`, now);
  }

  /** Sessions with queued messages. */
  inboxPanes(): SessionRef[] {
    return readdirSync(join(this.root, "inbox"))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => inboxRef(f.slice(0, -".jsonl".length)))
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
