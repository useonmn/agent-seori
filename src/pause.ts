import { type Deps, Refusal } from "./harness.ts";
import { DeliveryUncertain, deliverOrThrow, ToolError, type SessionRef } from "./runtime/index.ts";
import type { Lane, LaneStatus } from "./store.ts";
import { refText } from "./refs.ts";

// `seori pause` / `seori resume`: one state for "wait". A paused lane's omp goal is paused and duty leaves the lane
// alone (no nudge, no stall or ceiling report), so neither a nudge nor omp's goal continuation wakes it until the owner
// says resume. The lane is marked paused only once its pane shows the goal paused: a silenced lane whose goal still
// runs would be the very bug a pause exists to prevent.

/** A pause or resume that was sent but could not be confirmed on the pane: the lane is left as it was (exit 3). */
export class Unverified extends Error {}

export type PauseOptions = {
  /** Waits between screen read-backs; tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
};

/** The lane after the change and the lines the CLI prints. */
export type PauseOutcome = { readonly lane: Lane; readonly lines: readonly string[] };

const PAUSABLE: ReadonlySet<LaneStatus> = new Set(["working", "waiting", "ready"]);

// What omp 18.17 prints for `/goal pause` and `/goal resume` (pi-coding-agent src/modes/interactive-mode.ts):
// - `#pauseGoalAction` pauses the goal, then `#exitGoalMode({ paused: true, reason: "paused" })` calls
//   `this.showStatus("Goal mode paused.")`. With no active goal (none at all, or already paused) it calls
//   `this.showWarning("No active goal to pause.")` instead: either way nothing can auto-continue.
// - `#resumeGoalAction` calls `#enterGoalMode({ resume: true, silent: true })`, then `this.showStatus("Goal mode resumed.")`.
//   With no paused goal (none at all, or the goal already active) it calls `this.showWarning("No paused goal to resume.")`:
//   either way the goal is not paused any more.
// showStatus renders the message as its own line (pi-tui StatusNotice: a blank row, then the text padded by one column);
// showWarning renders `Warning: <message>` (pi-tui TranscriptNotice.line, LABELS.warning). Whole lines only, so lane
// output that merely mentions these words does not count.
export const PAUSED_SHOWN = /^\s*(?:Goal mode paused\.|Warning: No active goal to pause\.)\s*$/gm;
export const RESUMED_SHOWN = /^\s*(?:Goal mode resumed\.|Warning: No paused goal to resume\.)\s*$/gm;

/** How many screen lines are compared before and after a goal command. */
export const READ_BACK_LINES = 200;
/** Read-backs after the command before it counts as unconfirmed, and the wait between them (about 5.6 s in all). */
export const READ_BACK_TRIES = 8;
export const READ_BACK_INTERVAL_MS = 700;

/** After the pause is saved, how long the lane is watched for a turn that starts late (one Escape if it does), and how often. */
export const ESCAPE_WATCH_MS = 3_000;
export const ESCAPE_WATCH_INTERVAL_MS = 500;

const count = (screen: string, shown: RegExp): number => screen.match(shown)?.length ?? 0;

/**
 * Sends a goal command to the lane's omp and confirms it from the pane: one more matching line than before it was sent
 * (omp may redraw an earlier status in place, so presence alone proves nothing). An uncertain delivery is read back
 * like a sure one: the screen decides.
 */
async function goalCommand(d: Deps, ref: SessionRef, text: string, shown: RegExp, sleep: (ms: number) => Promise<void>): Promise<"confirmed" | "unconfirmed" | "no agent"> {
  const rt = d.runtime;
  const before = count(await rt.read(ref, READ_BACK_LINES), shown);
  try {
    // A goal-mode lane reads working until its goal ends: the command goes in whatever the status, never into a dialog.
    if (!(await deliverOrThrow(rt, ref, text, { when: "any" }))) return "no agent";
  } catch (e) {
    if (!(e instanceof DeliveryUncertain)) throw e;
  }
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    if (count(await rt.read(ref, READ_BACK_LINES), shown) > before) return "confirmed";
    await sleep(READ_BACK_INTERVAL_MS);
  }
  return "unconfirmed";
}

function laneOrRefuse(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  return lane;
}

/**
 * Runs a goal command, refusing plainly when the lane's pane is gone before it or vanishes during it (a not_found
 * would otherwise surface as a stack trace).
 */
async function goalCommandOrRefuse(d: Deps, lane: Lane, text: string, shown: RegExp, sleep: (ms: number) => Promise<void>, gone: string): Promise<"confirmed" | "unconfirmed" | "no agent"> {
  if ((await d.runtime.status(lane.sessionRef)) === "gone") throw new Refusal(gone);
  try {
    return await goalCommand(d, lane.sessionRef, text, shown, sleep);
  } catch (e) {
    if (e instanceof ToolError && (await d.runtime.status(lane.sessionRef).catch(() => undefined)) === "gone") throw new Refusal(gone);
    throw e;
  }
}

/**
 * Whether a turn runs on the pane within ESCAPE_WATCH_MS: the status may still read idle in the first moment of a turn (a
 * pause sent during the kickoff turn's first second), so one idle reading does not prove no turn will run.
 */
async function turnRunning(d: Deps, to: SessionRef, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let waited = 0; ; waited += ESCAPE_WATCH_INTERVAL_MS) {
    const st = await d.runtime.status(to);
    if (st === "working") return true;
    if (st === "gone" || waited >= ESCAPE_WATCH_MS) return false;
    await sleep(ESCAPE_WATCH_INTERVAL_MS);
  }
}

/** Drops the marks of the WORKING-WHILE-PAUSED check (see superviseTick): each pause starts a fresh watch. */
export const PAUSED_WORKING_MARKS = ["paused-seen-working", "working-while-paused"] as const;

function clearPausedMarks(lane: Lane): void {
  if (!lane.alerts) return;
  for (const k of PAUSED_WORKING_MARKS) delete lane.alerts[k];
}

/**
 * Pauses a working, waiting or ready lane: delivers `/goal pause` to its omp and waits for the pane to show the goal
 * paused, then records status paused (with the status it returns to on resume) and logs it. A turn running after the
 * goal is paused, or starting within ESCAPE_WATCH_MS of it, is interrupted with one Escape; the goal goes first, so the
 * stopped turn cannot hand off to a goal continuation. An already paused lane is reported as such. Throws Refusal for
 * a closed lane, a gone pane, or a lane that closed while the command was read back; Unverified when the pane never
 * showed the goal paused (the lane is left unchanged).
 */
export async function pauseLane(d: Deps, key: string, note?: string, opts: PauseOptions = {}): Promise<PauseOutcome> {
  const lane = laneOrRefuse(d, key);
  if (lane.status === "paused") return { lane, lines: [`PAUSED ${key} already`] };
  if (!PAUSABLE.has(lane.status)) throw new Refusal(`lane ${key} is ${lane.status}; only a working, waiting or ready lane can be paused`);
  const sleep = opts.sleep ?? Bun.sleep;
  const goal = await goalCommandOrRefuse(d, lane, "/goal pause", PAUSED_SHOWN, sleep, `lane ${key}'s pane ${refText(lane.sessionRef)} is gone; nothing to pause`);
  if (goal !== "confirmed") throw new Unverified(`PAUSE_UNVERIFIED ${key} /goal pause ${goal}; lane left ${lane.status}`);
  // Re-read: the lane may have reported, or been closed, while the command was read back.
  const fresh = laneOrRefuse(d, key);
  if (fresh.status === "paused") return { lane: fresh, lines: [`PAUSED ${key} already`] };
  if (!PAUSABLE.has(fresh.status)) throw new Refusal(`lane ${key} is now ${fresh.status}; it was not marked paused`);
  const now = d.now();
  fresh.pausedFrom = fresh.status;
  fresh.status = "paused";
  clearPausedMarks(fresh);
  fresh.log.push({ at: now, kind: "pause", text: note?.trim() || "paused" });
  d.store.saveLane(fresh);
  // A goal-mode omp reads as working until its goal ends; with the goal paused, working means a turn still runs.
  if (!(await turnRunning(d, fresh.sessionRef, sleep))) return { lane: fresh, lines: [`PAUSED ${key} goal paused`] };
  try {
    await d.runtime.keys(fresh.sessionRef, ["escape"]);
  } catch (e) {
    const reason = e instanceof ToolError ? (e.result.stderr || e.result.stdout).trim() : String(e);
    return { lane: fresh, lines: [`PAUSED ${key} goal paused; the running turn could not be interrupted (${reason})`] };
  }
  return { lane: fresh, lines: [`PAUSED ${key} goal paused, running turn interrupted`] };
}

/**
 * Resumes a paused lane: delivers `/goal resume` and waits for the pane to confirm it, then restores the status it had
 * before the pause and restarts its quiet time (lastActivityAt now, nudges 0), so a long pause does not turn into an
 * instant nudge or stall report. Throws Refusal for a lane that is not paused or whose pane is gone (duty marks that
 * lane lost) and Unverified when the pane never confirmed the resume (the lane stays paused).
 */
export async function resumeLane(d: Deps, key: string, note?: string, opts: PauseOptions = {}): Promise<PauseOutcome> {
  const lane = laneOrRefuse(d, key);
  if (lane.status !== "paused") throw new Refusal(`lane ${key} is ${lane.status}, not paused`);
  const goal = await goalCommandOrRefuse(d, lane, "/goal resume", RESUMED_SHOWN, opts.sleep ?? Bun.sleep, `lane ${key}'s pane ${refText(lane.sessionRef)} is gone; nothing to resume (duty marks the lane lost)`);
  if (goal !== "confirmed") throw new Unverified(`RESUME_UNVERIFIED ${key} /goal resume ${goal}; lane left paused`);
  const fresh = laneOrRefuse(d, key);
  const now = d.now();
  fresh.status = fresh.pausedFrom && PAUSABLE.has(fresh.pausedFrom) ? fresh.pausedFrom : "working";
  delete fresh.pausedFrom;
  fresh.lastActivityAt = now;
  fresh.nudges = 0;
  clearPausedMarks(fresh);
  fresh.log.push({ at: now, kind: "resume", text: note?.trim() || "resumed" });
  d.store.saveLane(fresh);
  return { lane: fresh, lines: [`RESUMED ${key} as ${fresh.status}, goal resumed`] };
}
