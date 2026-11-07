import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { constants, cpus, loadavg } from "node:os";
import { join } from "node:path";
import type { SeoriConfig } from "./config.ts";
import { lockFile } from "./store.ts";

// `seori heavy <label> -- <cmd...>`: full builds and test suites wait for a quiet host and one of config.heavy.slots
// slots, so parallel lanes do not all compile at once. A slot is `$SEORI_HOME/heavy/<n>.lock` (store.ts lockFile:
// created exclusively, holding pid, host and time); a slot whose holder died is taken over.

export const HEAVY_POLL_MS = 15_000;

/** The 1-minute load per core in percent, the figure config.heavy.maxLoadPct is compared with. */
export const loadPctNow = (): number => Math.round(((loadavg()[0] ?? 0) / Math.max(1, cpus().length)) * 100);

export type HeavyOpts = {
  readonly config: SeoriConfig;
  /** Load per core in percent; defaults to loadPctNow. */
  readonly load?: () => number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  /** Told each time the reason for waiting changes (see heavyWaitLine); defaults to a line on stderr. */
  readonly onWait?: (line: string) => void;
};

export const heavyDir = (root: string): string => join(root, "heavy");

/** What `seori heavy` prints on stderr while it waits. */
export const heavyWaitLine = (label: string, why: string): string => `HEAVY ${label} waiting: ${why}`;

/** Takes the first free slot (1..slots) and returns its number and release, or undefined while every slot is held. */
export function takeSlot(root: string, slots: number, now: number): { n: number; release: () => void } | undefined {
  mkdirSync(heavyDir(root), { recursive: true });
  for (let n = 1; n <= slots; n++) {
    const release = lockFile(join(heavyDir(root), `${n}.lock`), now);
    if (release) return { n, release };
  }
  return undefined;
}

/** Waits until load is under config.heavy.maxLoadPct and a slot is free, then holds that slot. */
export async function acquireHeavySlot(root: string, label: string, opts: HeavyOpts): Promise<{ n: number; release: () => void }> {
  const { slots, maxLoadPct } = opts.config.heavy;
  const load = opts.load ?? loadPctNow;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const onWait = opts.onWait ?? ((line: string) => process.stderr.write(`${line}\n`));
  let told: string | undefined;
  for (;;) {
    const pct = load();
    const slot = pct < maxLoadPct ? takeSlot(root, slots, now()) : undefined;
    if (slot) return slot;
    const why = pct < maxLoadPct ? `all ${slots} heavy slot(s) busy` : `load ${pct}% per core, not under ${maxLoadPct}%`;
    if (why !== told) onWait(heavyWaitLine(label, why));
    told = why;
    await sleep(opts.pollMs ?? HEAVY_POLL_MS);
  }
}

/** Exit status of a child: its code, or 128 + the signal number when a signal ended it (as a shell reports it). */
const exitStatus = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0);

/**
 * Runs `argv` (no shell, stdio inherited) once a heavy slot is free, frees the slot when it exits, and returns its
 * exit status. While it runs, SIGTERM and SIGHUP are passed on to it and an interrupt (Ctrl-C, which the terminal also
 * sends to the child) does not end seori first, so the slot is freed when the child is done. A command that cannot be
 * started is an error.
 */
export async function runHeavy(root: string, label: string, argv: readonly string[], opts: HeavyOpts): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("heavy needs a command after --");
  const slot = await acquireHeavySlot(root, label, opts);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const handlers: [NodeJS.Signals, () => void][] = [];
  try {
    const child = spawn(cmd, args, { stdio: "inherit" });
    handlers.push(["SIGTERM", () => child.kill("SIGTERM")], ["SIGHUP", () => child.kill("SIGHUP")], ["SIGINT", () => {}]);
    for (const [sig, h] of handlers) process.on(sig, h);
    child.once("error", (e) => reject(new Error(`cannot run ${cmd}: ${e.message}`)));
    child.once("exit", (code, signal) => resolve(exitStatus(code, signal)));
    return await promise;
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
    slot.release();
  }
}
