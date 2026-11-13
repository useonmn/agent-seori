import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./store.ts";

// `seori down`: a stop for every long-running seori process that works in every pane shell.
// Ctrl-C needs a terminal that turns the key into a console signal, so each loop (`seori duty`, `seori loop`, `seori daemon-loop`, `seori daemon`) records its pid in $SEORI_HOME/run/ and
// checks for a stop request addressed to that pid; it then ends the way Ctrl-C ends it (the daemon cleans up its
// watches and lock first). A request names the pid it is for, so a stale one never stops a process started later.

/** The long-running seori processes, in the order `seori down` stops them (daemon-loop before its daemon). */
export const RUNNERS = ["duty", "loop", "daemon-loop", "daemon"] as const;
export type Runner = (typeof RUNNERS)[number];

/** What `seori down <name>` covers: `daemon` is the restart loop and the daemon it runs. */
export const DOWN_GROUPS: Readonly<Record<string, readonly Runner[]>> = {
  duty: ["duty"], loop: ["loop"], daemon: ["daemon-loop", "daemon"], all: RUNNERS,
};

/** How often a running process looks for a stop request. */
export const STOP_POLL_MS = 1000;
/** How long `seori down` waits for each process to end before it says it is still running. */
export const DOWN_WAIT_MS = 30_000;

const runDir = (root: string): string => join(root, "run");
export const recordPath = (root: string, name: Runner): string => join(runDir(root), `${name}.json`);
export const stopPath = (root: string, name: Runner): string => join(runDir(root), `${name}.stop`);

const readPid = (path: string): number | undefined => {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
};

export type Running = {
  /** Aborts when `seori down` asks this process to stop. */
  readonly stopped: AbortSignal;
  /** Stops looking and removes this process's record and stop request. */
  release(): void;
};

/**
 * Records this process as the running `name` and polls for a stop request addressed to its pid. A request left for
 * an earlier process is removed on start, so it can never stop this one. `every` runs the check every `ms` until the
 * returned stop is called (an unref'd setInterval by default; tests check by hand).
 */
export function running(
  root: string,
  name: Runner,
  pid: number = process.pid,
  now: () => number = Date.now,
  pollMs = STOP_POLL_MS,
  every: (tick: () => void, ms: number) => () => void = unrefInterval,
): Running {
  mkdirSync(runDir(root), { recursive: true });
  if (existsSync(stopPath(root, name)) && readPid(stopPath(root, name)) !== pid) rmSync(stopPath(root, name), { force: true });
  writeFileSync(recordPath(root, name), JSON.stringify({ pid, startedAt: now() }));
  const ctl = new AbortController();
  const check = (): void => {
    if (!ctl.signal.aborted && readPid(stopPath(root, name)) === pid) ctl.abort();
  };
  const stopChecking = every(check, pollMs);
  return {
    stopped: ctl.signal,
    release() {
      stopChecking();
      if (readPid(recordPath(root, name)) === pid) rmSync(recordPath(root, name), { force: true });
      if (readPid(stopPath(root, name)) === pid) rmSync(stopPath(root, name), { force: true });
    },
  };
}

function unrefInterval(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The runners whose record names a live pid: what `seori up` finds already running in a home. */
export function liveRunners(root: string, alive: (pid: number) => boolean = pidAlive): Runner[] {
  return RUNNERS.filter((name) => {
    const pid = readPid(recordPath(root, name));
    return pid !== undefined && alive(pid);
  });
}

/** Waits `ms`, or less when `signal` aborts first. */
export function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

export type DownDeps = {
  readonly alive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitMs?: number;
};

/**
 * Asks each named process to stop and waits until it has ended (its record is gone or its pid is dead). One line per
 * process: STOPPED, NOT RUNNING (a record whose pid is dead is removed), or STILL RUNNING after the wait.
 */
export async function down(root: string, names: readonly Runner[], deps: DownDeps = {}): Promise<{ lines: string[]; ok: boolean }> {
  const alive = deps.alive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const waitMs = deps.waitMs ?? DOWN_WAIT_MS;
  const asked: { name: Runner; pid: number }[] = [];
  const lines: string[] = [];
  // Every request goes out before any wait, so the daemon-loop knows it is stopping before its daemon ends.
  for (const name of names) {
    const pid = readPid(recordPath(root, name));
    if (pid === undefined) {
      lines.push(`NOT RUNNING ${name}`);
      continue;
    }
    if (!alive(pid)) {
      rmSync(recordPath(root, name), { force: true });
      lines.push(`NOT RUNNING ${name} (removed the record of pid ${pid}, which has exited)`);
      continue;
    }
    mkdirSync(runDir(root), { recursive: true });
    writeFileSync(stopPath(root, name), JSON.stringify({ pid, at: now() }));
    asked.push({ name, pid });
  }
  let ok = true;
  for (const { name, pid } of asked) {
    const deadline = now() + waitMs;
    for (;;) {
      if (readPid(recordPath(root, name)) !== pid || !alive(pid)) {
        lines.push(`STOPPED ${name} pid=${pid}`);
        break;
      }
      if (now() >= deadline) {
        ok = false;
        lines.push(`STILL RUNNING ${name} pid=${pid} after ${Math.round(waitMs / 1000)} s; its stop request stays in ${stopPath(root, name)}`);
        break;
      }
      await sleep(200);
    }
  }
  return { lines, ok };
}
