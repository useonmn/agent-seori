import { type ChildProcess, spawn } from "node:child_process";
import { shPath } from "../platform.ts";
import { lstatSync, readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { MAX_RESTARTS, WAKE_BUDGET, WAKE_WINDOW_MS, type Watch, type WatchSource, WatchStore } from "./store.ts";

// Runs the watches in $SEORI_HOME/watches/ inside `seori daemon`. The files are the truth: every tick re-reads them, so
// `seori watch stop|rearm` (another process) takes effect within a tick, and a daemon restart resumes every live watch.
// State changes are read-modify-written through store.update (a per-watch lock file shared with the CLI), so neither
// process clobbers what the other just wrote with a stale copy; a per-watch queue keeps one watch's deliveries in order.

export type PaneState = "idle" | "working" | "blocked" | "done" | "unknown" | "shell" | "gone";

/** Intervals; tests shrink them, the daemon uses DEFAULT_TIMING. */
export type WatchTiming = {
  /** Command output lines arriving within this window become one event. */
  readonly coalesceMs: number;
  /** stat polling rather than fs.watch: it works the same across editors' atomic renames and network filesystems. */
  readonly filePollMs: number;
  readonly fileCoalesceMs: number;
  readonly checksPollMs: number;
  readonly panePollMs: number;
  /** Wait before restart n (1-based) of a crashed command; the last value repeats. */
  readonly backoffMs: readonly number[];
  /** After SIGTERM to a command's process group, SIGKILL follows this much later. */
  readonly killGraceMs: number;
  /** While muted, events are only counted; the count reaches the watch file at most this often (and on status changes). */
  readonly mutedSaveMs: number;
};

export const DEFAULT_TIMING: WatchTiming = {
  coalesceMs: 500,
  filePollMs: 1_000,
  fileCoalesceMs: 1_000,
  checksPollMs: 60_000,
  panePollMs: 5_000,
  backoffMs: [5_000, 15_000, 45_000],
  killGraceMs: 2_000,
  mutedSaveMs: 30_000,
};

export type EngineDeps = {
  readonly now: () => number;
  readonly deliver: (w: Watch, text: string) => Promise<void>;
  readonly gh: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  readonly paneStatus: (pane: string) => Promise<PaneState>;
  readonly laneOpen: (key: string) => boolean;
  readonly tickMs?: number;
  readonly timing?: Partial<WatchTiming>;
};

/** One batch of command output is capped so a flood of lines cannot become one enormous wake. */
const MAX_BATCH_LINES = 40;
const MAX_BATCH_BYTES = 4_096;
/** Output lines kept for the final `exited 0` event. */
const TAIL_LINES = 5;
/** A line longer than this (a `\r` progress bar, binary output) is cut here and emitted, so the buffer stays bounded. */
export const MAX_LINE_BYTES = 65_536;
/**
 * Directory watches walk at most this many entries, this deep, without following symlinks: enough for a source or
 * build tree, and a bounded cost per poll for a huge one (changes past the limit go unnoticed).
 */
const DIR_MAX_ENTRIES = 10_000;
const DIR_MAX_DEPTH = 8;
/** ps ages have 1 s resolution; a process group member that started this long before the recorded spawn is not ours. */
const SPAWN_CLOCK_SLACK_MS = 2_000;

type Runner = { stop(): Promise<void> };
type Checkpoint = NonNullable<Watch["checkpoint"]>;

/** What a runner may do; every state change goes through the engine's per-watch queue. */
type RunnerCtx = {
  readonly timing: WatchTiming;
  readonly deps: EngineDeps;
  /** An event for the owner, subject to the wake budget (counted, not delivered, while muted). */
  event(text: string): Promise<void>;
  /** Ends the watch with one last delivery outside the wake budget, so the owner always learns it ended. */
  finish(status: "done" | "stopped", reason: string, text: string): Promise<void>;
  update(fn: (w: Watch) => Watch): Promise<Watch | undefined>;
  log(ev: Record<string, unknown>): void;
};

const live = (w: Watch): boolean => w.status === "active" || w.status === "muted";
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class WatchEngine {
  private readonly store: WatchStore;
  private readonly timing: WatchTiming;
  private readonly runners = new Map<string, Runner>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Muted events counted but not yet written to the watch file, and when the count was last written. */
  private readonly mutedCounts = new Map<string, { count: number; savedAt: number }>();
  private interval: Timer | undefined;
  private ticking: Promise<void> | undefined;
  private stopping = false;

  constructor(
    root: string,
    private readonly deps: EngineDeps,
  ) {
    this.store = new WatchStore(root);
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  start(): void {
    this.stopping = false;
    void this.tick();
    this.interval = setInterval(() => void this.tick(), this.deps.tickMs ?? 1_000);
  }

  /** Kills every runner and waits for them; watch statuses stay as they are so the next daemon resumes them. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.interval);
    this.interval = undefined;
    await this.ticking;
    const runners = [...this.runners.values()];
    this.runners.clear();
    await Promise.all(runners.map((r) => r.stop()));
    await Promise.all(this.queues.values());
    for (const [id, m] of this.mutedCounts) this.saveMutedCount(id, m.count);
    this.mutedCounts.clear();
  }

  private saveMutedCount(id: string, count: number): void {
    if (count === 0) return;
    try {
      this.store.update(id, (w) => (w.status === "muted" ? { ...w, mutedEvents: w.mutedEvents + count } : w));
    } catch (e) {
      console.error(`seori watch ${id}: cannot save muted count: ${errorText(e)}`);
    }
  }

  /** One pass over the watch files; concurrent calls share the pass in flight. */
  tick(): Promise<void> {
    this.ticking ??= this.sweep()
      .catch((e) => console.error(`seori watch engine: ${errorText(e)}`))
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }

  private async sweep(): Promise<void> {
    const now = this.deps.now();
    const seen = new Set<string>();
    for (const w of this.store.list()) {
      seen.add(w.id);
      if (!live(w)) {
        this.mutedCounts.delete(w.id);
        await this.drop(w.id);
      } else if (now >= w.expiresAt) {
        await this.drop(w.id);
        await this.finish(w.id, "expired", "timed out", "expired");
      } else if (w.owner.kind === "lane" && !this.deps.laneOpen(w.owner.key)) {
        await this.drop(w.id);
        await this.finish(w.id, "stopped", "owner lane closed", undefined);
      } else if (!this.runners.has(w.id) && !this.stopping) {
        this.runners.set(w.id, this.run(w));
      }
    }
    for (const id of [...this.runners.keys()]) if (!seen.has(id)) await this.drop(id);
  }

  private async drop(id: string): Promise<void> {
    const r = this.runners.get(id);
    if (!r) return;
    this.runners.delete(id);
    await r.stop();
  }

  private queue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(fn);
    const settled = next.catch(() => {});
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return next;
  }

  private log(id: string, ev: Record<string, unknown>): void {
    try {
      this.store.appendEvent(id, { at: this.deps.now(), ...ev });
    } catch (e) {
      console.error(`seori watch ${id}: cannot log event: ${errorText(e)}`);
    }
  }

  /**
   * Never resends: the wake was already counted before the attempt. A failed delivery is logged and dropped so one
   * unreachable owner cannot stop the engine; a `HELD:` error means the text may already be in the lane's pane, so it
   * is logged as delivered-but-uncertain rather than as a failure.
   */
  private async send(w: Watch, text: string): Promise<void> {
    try {
      await this.deps.deliver(w, `[watch ${w.name} ${w.id}] ${text}`);
      this.log(w.id, { ev: "delivered", text });
    } catch (e) {
      const detail = errorText(e);
      this.log(w.id, { ev: detail.startsWith("HELD:") ? "delivered-uncertain" : "deliver-error", text, detail });
    }
  }

  private prunedWakes(w: Watch): number[] {
    const since = this.deps.now() - WAKE_WINDOW_MS;
    return w.wakes.filter((t) => t > since);
  }

  /**
   * While muted only counts, in memory, writing the count at most every mutedSaveMs: a chatty muted watch would
   * otherwise rewrite its file and log its text twice a second for days. A rearm (status back to active on disk)
   * voids the unsaved count, which belonged to the mute that ended.
   */
  private event(id: string, text: string): Promise<void> {
    return this.queue(id, async () => {
      if (this.stopping) return;
      const now = this.deps.now();
      // Assigned inside the update callback, which TypeScript does not track; hence the cast.
      let outcome = "none" as "none" | "counted" | "muted" | "deliver";
      const w = this.store.update(id, (w) => {
        if (!live(w)) return w;
        if (w.status === "muted") {
          outcome = "counted";
          const m = this.mutedCounts.get(id) ?? { count: 0, savedAt: now };
          m.count++;
          this.mutedCounts.set(id, m);
          if (now - m.savedAt < this.timing.mutedSaveMs) return w;
          this.mutedCounts.set(id, { count: 0, savedAt: now });
          return { ...w, mutedEvents: w.mutedEvents + m.count };
        }
        this.mutedCounts.delete(id);
        const wakes = [...this.prunedWakes(w), now];
        if (wakes.length > WAKE_BUDGET) {
          outcome = "muted";
          this.mutedCounts.set(id, { count: 0, savedAt: now });
          return { ...w, status: "muted", reason: "wake budget", wakes, mutedEvents: w.mutedEvents + 1 };
        }
        outcome = "deliver";
        return { ...w, wakes };
      });
      if (!w || outcome === "none" || outcome === "counted") return;
      if (outcome === "muted") {
        this.log(id, { ev: "muted", text });
        const hours = WAKE_WINDOW_MS / 3_600_000;
        await this.send(w, `muted after ${WAKE_BUDGET} wakes in ${hours}h; seori watch rearm ${id} to resume`);
        return;
      }
      this.log(id, { ev: "seen", text });
      await this.send(w, text);
    });
  }

  /** Moves a live watch to a final status; `text` undefined ends it silently. A watch that already ended is left alone. */
  private finish(id: string, status: "done" | "stopped" | "expired", reason: string, text: string | undefined): Promise<void> {
    return this.queue(id, async () => {
      const pending = this.mutedCounts.get(id)?.count ?? 0;
      this.mutedCounts.delete(id);
      let changed = false;
      const next = this.store.update(id, (w) => {
        if (!live(w)) return w;
        changed = true;
        const mutedEvents = w.status === "muted" ? w.mutedEvents + pending : w.mutedEvents;
        return { ...w, status, reason, mutedEvents, wakes: text === undefined ? w.wakes : [...this.prunedWakes(w), this.deps.now()] };
      });
      if (!next || !changed) return;
      this.log(id, { ev: status, reason });
      if (text !== undefined) await this.send(next, text);
    });
  }

  private update(id: string, fn: (w: Watch) => Watch): Promise<Watch | undefined> {
    return this.queue(id, async () => this.store.update(id, fn));
  }

  private run(w: Watch): Runner {
    const ctx: RunnerCtx = {
      timing: this.timing,
      deps: this.deps,
      event: (text) => this.event(w.id, text),
      finish: (status, reason, text) => this.finish(w.id, status, reason, text),
      update: (fn) => this.update(w.id, fn),
      log: (ev) => this.log(w.id, ev),
    };
    const s = w.source;
    switch (s.kind) {
      case "command":
        return commandRunner(ctx, s, w);
      case "file":
        return fileRunner(ctx, s, w.checkpoint);
      case "checks":
        return checksRunner(ctx, s);
      case "pane":
        return paneRunner(ctx, s);
    }
  }
}

/** Calls `fn` now and then every `ms` after it settles, until it returns true or the runner stops. */
function poll(ctx: RunnerCtx, ms: number, fn: () => Promise<boolean>): Runner {
  let stopped = false;
  let timer: Timer | undefined;
  let current: Promise<void> = Promise.resolve();
  const step = (): void => {
    current = fn()
      .catch((e) => {
        ctx.log({ ev: "error", detail: errorText(e) });
        return false;
      })
      .then((finished) => {
        if (finished) stopped = true;
        if (!stopped) timer = setTimeout(step, ms);
      });
  };
  step();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}

/**
 * Splits a stream into lines (CR stripped); resolves once the stream has ended and the last partial line is out. Only
 * each new chunk is searched for newlines, and a line growing past MAX_LINE_BYTES is emitted cut and the rest of it
 * dropped, so a `\r`-only progress bar or binary output cannot grow the buffer or the CPU spent on it.
 */
export function readLines(stream: Readable, onLine: (line: string) => void): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let buf = "";
  let skipping = false;
  const emit = (line: string): void => onLine(line.replace(/\r$/, ""));
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    let start = 0;
    for (let nl = chunk.indexOf("\n"); nl >= 0; nl = chunk.indexOf("\n", start)) {
      if (!skipping) emit((buf + chunk.slice(start, nl)).slice(0, MAX_LINE_BYTES));
      buf = "";
      skipping = false;
      start = nl + 1;
    }
    if (skipping) return;
    buf += chunk.slice(start);
    if (buf.length > MAX_LINE_BYTES) {
      emit(buf.slice(0, MAX_LINE_BYTES));
      buf = "";
      skipping = true;
    }
  });
  const end = (): void => {
    if (buf !== "") emit(buf);
    buf = "";
    resolve();
  };
  stream.once("end", end);
  stream.once("close", end);
  stream.once("error", end);
  return promise;
}

/**
 * Signals the whole process group: the command runs under `sh -c`, and pipelines or background jobs must die with it.
 */
async function killGroup(p: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (p.pid !== undefined) await killPgid(p.pid, signal);
}

/** True when the group was there; signal 0 only checks. */
async function killPgid(pgid: number, signal: NodeJS.Signals | 0): Promise<boolean> {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Whether process group `pgid` still exists and is the one spawned at `spawnedAt`: every member must have started no
 * earlier than that (a reused pid would be older than our spawn record, or show `?`). Members are listed with ps, which
 * also finds a group whose leader (`sh`) died while its pipeline or background jobs live on. Ages come from `etime`
 * (time since start) rather than `lstart`: macOS ps is setuid and ignores TZ, so a printed wall time cannot be parsed
 * reliably.
 */
async function isOurGroup(pgid: number, spawnedAt: number): Promise<boolean> {
  const p = Bun.spawn(["ps", "-A", "-o", "pgid=", "-o", "etime="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const now = Date.now();
  const starts = out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\S+)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && Number(m[1]) === pgid)
    .map((m) => now - elapsedMs(m[2] as string));
  return starts.length > 0 && starts.every((t) => t >= spawnedAt - SPAWN_CLOCK_SLACK_MS);
}

/** ps `etime`, `[[dd-]hh:]mm:ss`, in ms; NaN for anything else (`?`), which then never counts as ours. */
function elapsedMs(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return Number.NaN;
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0)) as [number, number, number, number];
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function batchText(lines: readonly string[], dropped = 0): string {
  const out: string[] = [];
  let bytes = 0;
  for (const raw of lines) {
    const line = raw.length > MAX_BATCH_BYTES ? `${raw.slice(0, MAX_BATCH_BYTES)}…` : raw;
    if (out.length >= MAX_BATCH_LINES || (out.length > 0 && bytes + line.length > MAX_BATCH_BYTES)) break;
    out.push(line);
    bytes += line.length + 1;
  }
  const more = lines.length - out.length + dropped;
  return more > 0 ? `${out.join("\n")}\n(+${more} more lines)` : out.join("\n");
}

/** Kills the process group a previous daemon left running (it died without stopping its runners), then forgets it. */
async function reapOrphan(ctx: RunnerCtx, saved: Watch): Promise<void> {
  const { pgid, spawnedAt } = saved;
  if (pgid === undefined) return;
  if (spawnedAt !== undefined && (await isOurGroup(pgid, spawnedAt))) {
    await killPgid(pgid, "SIGTERM");
    const deadline = Date.now() + ctx.timing.killGraceMs;
    while ((await killPgid(pgid, 0)) && Date.now() < deadline) await Bun.sleep(20);
    await killPgid(pgid, "SIGKILL");
    ctx.log({ ev: "orphan-killed", pgid });
  }
  await ctx.update((w) => (w.pgid === pgid ? withoutGroup(w) : w));
}

const withoutGroup = (w: Watch): Watch => {
  const { pgid: _pgid, spawnedAt: _spawnedAt, ...rest } = w;
  return rest;
};

function commandRunner(ctx: RunnerCtx, src: Extract<WatchSource, { kind: "command" }>, saved: Watch): Runner {
  const filter = src.filter === undefined ? undefined : new RegExp(src.filter);
  let stopped = false;
  let child: ChildProcess | undefined;
  let finished: Promise<void> = Promise.resolve();
  /** At most MAX_BATCH_LINES matching lines wait for the next event; the rest are only counted. */
  let pending: string[] = [];
  let dropped = 0;
  let tail: string[] = [];
  let flushTimer: Timer | undefined;
  let backoffTimer: Timer | undefined;
  let startedAt = 0;

  const flush = async (): Promise<void> => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (pending.length === 0 || stopped) return;
    const text = batchText(pending, dropped);
    pending = [];
    dropped = 0;
    await ctx.event(text);
  };

  const onLine = (line: string): void => {
    tail.push(line.length > MAX_BATCH_BYTES ? `${line.slice(0, MAX_BATCH_BYTES)}…` : line);
    if (tail.length > TAIL_LINES) tail.shift();
    if (filter && !filter.test(line)) return;
    if (pending.length < MAX_BATCH_LINES) pending.push(line);
    else dropped++;
    flushTimer ??= setTimeout(() => void flush(), ctx.timing.coalesceMs);
  };

  const spawnOnce = (): void => {
    tail = [];
    startedAt = ctx.deps.now();
    // Wall clock, not deps.now: it is compared with process ages ps reports.
    const spawnedAt = Date.now();
    const p = spawn(shPath(), ["-c", src.command], { cwd: src.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child = p;
    ctx.log({ ev: "spawned", pid: p.pid });
    const pgid = p.pid;
    // detached: the command leads its own process group, so its pid is the group id.
    if (pgid !== undefined) void ctx.update((w) => ({ ...w, pgid, spawnedAt }));
    const outcome = Promise.withResolvers<{ code: number | null; signal: string | null; error?: string }>();
    p.once("exit", (code, signal) => outcome.resolve({ code, signal }));
    p.once("error", (e) => outcome.resolve({ code: null, signal: null, error: errorText(e) }));
    const drained = Promise.all([readLines(p.stdout as Readable, onLine), readLines(p.stderr as Readable, onLine)]);
    finished = (async () => {
      const r = await outcome.promise;
      // A background job of the command may still hold the pipes; give them a moment, then take the group down.
      await Promise.race([drained, Bun.sleep(200)]);
      await killGroup(p, "SIGKILL");
      child = undefined;
      if (pgid !== undefined) await ctx.update((w) => (w.pgid === pgid ? withoutGroup(w) : w));
      if (!stopped) await exited(r.code, r.signal, r.error);
    })();
  };

  const exited = async (code: number | null, signal: string | null, error?: string): Promise<void> => {
    await flush();
    if (code === 0) {
      await ctx.finish("done", "exited 0", tail.length > 0 ? `exited 0\n${tail.join("\n")}` : "exited 0");
      return;
    }
    const exit = error ?? signal ?? String(code);
    const delays = ctx.timing.backoffMs;
    // A run that outlasted the longest backoff was healthy: this crash starts a fresh count, so rare crashes over a
    // persistent watch's 7 days do not add up to "kept crashing".
    const healthy = ctx.deps.now() - startedAt > (delays.at(-1) ?? 0);
    const before = await ctx.update((w) => (healthy && w.restarts > 0 ? { ...w, restarts: 0 } : w));
    if (!before || stopped) return;
    if (before.restarts >= MAX_RESTARTS) {
      await ctx.finish("stopped", `kept crashing (exit ${exit})`, `kept crashing (exit ${exit}); stopped`);
      return;
    }
    const w = await ctx.update((w) => ({ ...w, restarts: w.restarts + 1 }));
    const n = w?.restarts ?? before.restarts + 1;
    const delay = delays[Math.min(n, delays.length) - 1] ?? 0;
    ctx.log({ ev: "restarted", exit, restart: n, delayMs: delay });
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined;
      if (!stopped) spawnOnce();
    }, delay);
  };

  finished = reapOrphan(ctx, saved)
    .catch((e) => ctx.log({ ev: "error", detail: `cannot check the previous process group: ${errorText(e)}` }))
    .then(() => {
      if (!stopped) spawnOnce();
    });
  return {
    async stop() {
      stopped = true;
      clearTimeout(flushTimer);
      clearTimeout(backoffTimer);
      // `stopped` is set, so nothing spawns from here on: the child (if any) is the last one; with none, `finished`
      // is the orphan check still in flight.
      const p = child;
      if (p) await killGroup(p, "SIGTERM");
      const hard = p ? setTimeout(() => void killGroup(p, "SIGKILL"), ctx.timing.killGraceMs) : undefined;
      await finished;
      clearTimeout(hard);
    },
  };
}

/** A file's stat, or for a directory the newest mtime, total size and entry count beneath it (bounded walk). */
const snapshot = (path: string): Checkpoint => {
  let s: Stats;
  try {
    s = statSync(path);
  } catch {
    return { exists: false };
  }
  if (!s.isDirectory()) return { exists: true, mtimeMs: s.mtimeMs, size: s.size };
  let mtimeMs = s.mtimeMs;
  let size = 0;
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // unreadable or removed mid-walk
    }
    for (const name of names) {
      if (count >= DIR_MAX_ENTRIES) return;
      const p = join(dir, name);
      let e: Stats;
      try {
        e = lstatSync(p);
      } catch {
        continue;
      }
      count++;
      mtimeMs = Math.max(mtimeMs, e.mtimeMs);
      if (e.isDirectory()) {
        if (depth < DIR_MAX_DEPTH) walk(p, depth + 1);
      } else {
        size += e.size;
      }
    }
  };
  walk(path, 1);
  return { exists: true, mtimeMs, size, count };
};

/**
 * Compares against the saved checkpoint, so a change made while the daemon was down shows up on the first poll; the
 * checkpoint moves only when an event is emitted, so a change still coalescing at shutdown is reported after restart.
 */
function fileRunner(ctx: RunnerCtx, src: Extract<WatchSource, { kind: "file" }>, saved: Checkpoint | undefined): Runner {
  let last = saved;
  let kinds: string[] = [];
  let timer: Timer | undefined;
  let stopped = false;

  const flush = async (): Promise<void> => {
    timer = undefined;
    if (stopped) return;
    const text = `${kinds.join(", ")} ${src.path}`;
    kinds = [];
    const cp = last;
    await ctx.update((w) => ({ ...w, checkpoint: cp }));
    await ctx.event(text);
  };

  const poller = poll(ctx, ctx.timing.filePollMs, async () => {
    const cur = snapshot(src.path);
    if (last === undefined) {
      last = cur;
      await ctx.update((w) => ({ ...w, checkpoint: cur }));
      return false;
    }
    if (last.exists === cur.exists && last.mtimeMs === cur.mtimeMs && last.size === cur.size && last.count === cur.count) return false;
    const kind = !last.exists ? "created" : !cur.exists ? "deleted" : "modified";
    if (kinds.at(-1) !== kind) kinds.push(kind);
    last = cur;
    timer ??= setTimeout(() => void flush(), ctx.timing.fileCoalesceMs);
    return false;
  });

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await poller.stop();
    },
  };
}

type Check = { readonly name: string; readonly bucket: string };

function checksRunner(ctx: RunnerCtx, src: Extract<WatchSource, { kind: "checks" }>): Runner {
  return poll(ctx, ctx.timing.checksPollMs, async () => {
    // gh exits non-zero while checks are pending (8) or failed (1), so the JSON on stdout decides, not the exit code.
    const r = await ctx.deps.gh(["pr", "checks", String(src.number), "--repo", src.repo, "--json", "name,bucket"]);
    let checks: Check[] | undefined;
    try {
      const v: unknown = JSON.parse(r.stdout);
      if (Array.isArray(v)) checks = v as Check[];
    } catch {
      // not JSON: an error below
    }
    if (!checks) {
      ctx.log({ ev: "error", detail: (r.stderr || r.stdout).trim() || `gh exited ${r.code}` });
      return false;
    }
    if (checks.length === 0 || checks.some((c) => c.bucket === "pending")) {
      ctx.log({ ev: "pending", checks: checks.length });
      return false;
    }
    const failing = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    const pass = checks.filter((c) => c.bucket === "pass").length;
    const skipped = checks.filter((c) => c.bucket === "skipping").length;
    const names = failing.length > 0 ? ` (failing: ${failing.map((c) => c.name).join(", ")})` : "";
    await ctx.finish("done", "checks finished", `checks finished: pass ${pass}, fail ${failing.length}, skipped ${skipped}${names}`);
    return true;
  });
}

/** hc reports a lane that finished its turn unwatched as `done`; like the harness, that counts as idle. */
function paneRunner(ctx: RunnerCtx, src: Extract<WatchSource, { kind: "pane" }>): Runner {
  return poll(ctx, ctx.timing.panePollMs, async () => {
    const status = await ctx.deps.paneStatus(src.pane);
    const hit = src.status === "idle" ? status === "idle" || status === "done" : status === src.status;
    if (!hit && status !== "gone") return false;
    await ctx.finish("done", `pane ${status}`, `pane ${src.pane} is ${status}`);
    return true;
  });
}
