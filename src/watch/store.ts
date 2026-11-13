import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockFile } from "../store.ts";

// Watches: something `seori daemon` keeps an eye on for an agent (the lead or a lane), waking it when it fires. One
// JSON file per watch under $SEORI_HOME/watches/, so a watch outlives the agent's session (/new, restarts) and the
// daemon (crash, config reload). The daemon's engine (src/watch/engine.ts) runs them; `seori watch` manages them.

/** What a watch looks at. */
export type WatchSource =
  /** A long-running shell command; each output line matching `filter` (all lines when absent) is an event. */
  | { readonly kind: "command"; readonly command: string; readonly cwd: string; readonly filter?: string }
  /** A file or directory; every change (created, modified, deleted) is an event. */
  | { readonly kind: "file"; readonly path: string }
  /** A GitHub PR's checks; one event when every check has finished (pass or fail), then the watch is done. */
  | { readonly kind: "checks"; readonly repo: string; readonly number: number }
  /** A herdr pane's agent state; one event when it reaches `status`, then the watch is done. */
  | { readonly kind: "pane"; readonly pane: string; readonly status: "idle" | "working" | "blocked" | "gone" };

/** Who gets woken: the lead, or a lane by key. */
export type WatchOwner = { readonly kind: "lead" } | { readonly kind: "lane"; readonly key: string };

export type WatchStatus =
  | "active"
  /** Woke its owner WAKE_BUDGET times within WAKE_WINDOW_MS; events are counted, not delivered, until `seori watch rearm`. */
  | "muted"
  /** Finished on its own: a command exited 0, checks completed, the pane reached its status. */
  | "done"
  /** Ended by `seori watch stop`, by its owner lane closing, or by a command that kept crashing. */
  | "stopped"
  | "expired";

export type Watch = {
  readonly id: string;
  readonly name: string;
  readonly source: WatchSource;
  readonly owner: WatchOwner;
  readonly persistent: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: WatchStatus;
  /** Why it left `active` (stopped by whom, exit code, last error). */
  readonly reason?: string;
  /** Deliveries to the owner, for the wake budget. */
  readonly wakes: readonly number[];
  /** Events seen while muted (reported on rearm). */
  readonly mutedEvents: number;
  /** Command restarts after a crash (non-zero exit or signal). */
  readonly restarts: number;
  /**
   * Command watches: the running command's process group and when it was spawned (wall clock ms), so a daemon that
   * died without killing it can take the orphan down before spawning a second copy. Cleared once the group is killed.
   */
  readonly pgid?: number;
  readonly spawnedAt?: number;
  /**
   * File watches: what the path looked like at the last event, so a change while the daemon was down is reported once.
   * For a directory, mtimeMs is the newest mtime, size the total size and count the number of entries beneath it.
   */
  readonly checkpoint?: { readonly exists: boolean; readonly mtimeMs?: number; readonly size?: number; readonly count?: number };
};

/** A non-persistent watch lives 2 hours unless --timeout says otherwise (at most 24 hours). */
export const DEFAULT_TIMEOUT_MS = 2 * 3_600_000;
export const MAX_TIMEOUT_MS = 24 * 3_600_000;
/** Two base-36 characters after the creation time make a watch id unique within its millisecond. */
const ID_SUFFIXES = 36 * 36;

/** Persistent watches live 7 days, at most 5 per owner. */
export const PERSISTENT_TTL_MS = 7 * 24 * 3_600_000;
export const MAX_PERSISTENT_PER_OWNER = 5;
/** Wake budget: this many deliveries in this window, then the watch is muted until rearmed. */
export const WAKE_BUDGET = 6;
export const WAKE_WINDOW_MS = 3_600_000;
/** A crashing command is restarted this many times (with backoff) before the watch is stopped. */
export const MAX_RESTARTS = 3;
/** `<id>.events.jsonl` is rotated to `<id>.events.jsonl.1` (one generation) once it passes this size. */
export const EVENTS_MAX_BYTES = 1_048_576;
/** How long store.update waits for another process's per-watch lock before giving up. */
const UPDATE_LOCK_WAIT_MS = 2_000;

export class WatchRefusal extends Error {}

const ownerKey = (o: WatchOwner): string => (o.kind === "lead" ? "lead" : `lane:${o.key}`);
export const sameOwner = (a: WatchOwner, b: WatchOwner): boolean => ownerKey(a) === ownerKey(b);

export type NewWatch = {
  readonly name?: string;
  readonly source: WatchSource;
  readonly owner: WatchOwner;
  readonly persistent?: boolean;
  /** Non-persistent only; default DEFAULT_TIMEOUT_MS, at most MAX_TIMEOUT_MS. */
  readonly timeoutMs?: number;
};

export class WatchStore {
  readonly dir: string;
  constructor(readonly root: string) {
    this.dir = join(root, "watches");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Append-only log of what each watch saw and delivered, for `seori watch log` and debugging. */
  eventsPath(id: string): string {
    return join(this.dir, `${id}.events.jsonl`);
  }

  list(): Watch[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Watch];
        } catch {
          return []; // a torn write is skipped; the next save of that watch repairs it
        }
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Watch | undefined {
    const p = this.path(id);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Watch) : undefined;
  }

  /** By id or by name among watches that are still active or muted. */
  find(idOrName: string): Watch | undefined {
    return this.get(idOrName) ?? this.list().find((w) => w.name === idOrName && (w.status === "active" || w.status === "muted"));
  }

  save(w: Watch): void {
    const tmp = `${this.path(w.id)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(w, null, 2)}\n`);
    renameSync(tmp, this.path(w.id));
  }

  /**
   * Read-modify-write under the watch's lock file (`<id>.json.lock`), so the daemon's engine and `seori watch` (another
   * process) never overwrite each other's change with a stale copy. Waits briefly for a held lock, then throws. `fn`
   * returning the very object it was given means "no change" and skips the write. Returns the watch as saved, or
   * undefined when the watch file is gone.
   */
  update(id: string, fn: (w: Watch) => Watch): Watch | undefined {
    const lockPath = `${this.path(id)}.lock`;
    const deadline = Date.now() + UPDATE_LOCK_WAIT_MS;
    let release = lockFile(lockPath, Date.now());
    while (!release) {
      if (Date.now() > deadline) throw new Error(`watch ${id} is locked by another process (${lockPath})`);
      Bun.sleepSync(5);
      release = lockFile(lockPath, Date.now());
    }
    try {
      const w = this.get(id);
      if (!w) return undefined;
      const next = fn(w);
      if (next !== w) this.save(next);
      return next;
    } finally {
      release();
    }
  }

  /** Validates limits and stores an active watch. Refuses a 6th persistent watch for the same owner. */
  add(input: NewWatch, now: number): Watch {
    const persistent = input.persistent === true;
    if (persistent && input.timeoutMs !== undefined) throw new WatchRefusal("a persistent watch lives 7 days; --timeout is for non-persistent watches");
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!persistent && (!(timeout > 0) || timeout > MAX_TIMEOUT_MS)) throw new WatchRefusal(`--timeout must be between 1 s and 24 h`);
    if (input.source.kind === "command" && input.source.filter !== undefined) {
      try {
        new RegExp(input.source.filter);
      } catch (e) {
        throw new WatchRefusal(`invalid --filter regex: ${(e as Error).message}`);
      }
    }
    const live = this.list().filter((w) => (w.status === "active" || w.status === "muted") && sameOwner(w.owner, input.owner));
    if (persistent && live.filter((w) => w.persistent).length >= MAX_PERSISTENT_PER_OWNER) {
      throw new WatchRefusal(`at most ${MAX_PERSISTENT_PER_OWNER} persistent watches per owner; stop one first (seori watch list)`);
    }
    const name = input.name ?? input.source.kind;
    if (input.name !== undefined && live.some((w) => w.name === name)) throw new WatchRefusal(`a live watch is already named ${name}`);
    // Two adds (even in two processes) may draw the same suffix: each candidate is claimed with link(2), which fails
    // with EEXIST instead of replacing an existing watch, and the next suffix is tried. The file is never half-written.
    const first = Math.floor(Math.random() * ID_SUFFIXES);
    for (let i = 0; i < ID_SUFFIXES; i++) {
      const id = `w${now.toString(36)}${((first + i) % ID_SUFFIXES).toString(36).padStart(2, "0")}`;
      const w: Watch = {
        id,
        name,
        source: input.source,
        owner: input.owner,
        persistent,
        createdAt: now,
        expiresAt: now + (persistent ? PERSISTENT_TTL_MS : timeout),
        status: "active",
        wakes: [],
        mutedEvents: 0,
        restarts: 0,
      };
      const tmp = `${this.path(id)}.${process.pid}.claim`;
      writeFileSync(tmp, `${JSON.stringify(w, null, 2)}\n`);
      try {
        linkSync(tmp, this.path(id));
        return w;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    throw new WatchRefusal(`no free watch id left for this millisecond; try again`);
  }

  /** Appends one event; past EVENTS_MAX_BYTES the log is rotated first, so a chatty watch cannot fill the disk. */
  appendEvent(id: string, event: Record<string, unknown>): void {
    const path = this.eventsPath(id);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // no log yet
    }
    if (size >= EVENTS_MAX_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  }
}
