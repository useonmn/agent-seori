// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// `seori start`'s startup verdict: after the kickoff, the new lane's screen and status are read until the start can be
// classified, so a lane whose omp hit "No API key", a 429 or a spent quota is not reported as started.
import { loadConfig } from "./config.ts";
import { openLaneSession, type Deps, type StartOptions } from "./harness.ts";
import { refText } from "./refs.ts";
import { statusOf, type AgentStatus } from "./runtime/index.ts";
import { startupFailure } from "./startup-screen.ts";
import type { Lane } from "./store.ts";

// The first check is 20 s after the kickoff, then the screen and status are re-read every 10 s until startupWaitSeconds.
export const FIRST_CHECK_MS = 20_000;
export const RECHECK_MS = 10_000;
const SCREEN_LINES = 40;

/** omp is running: idle, working, or done (herdr: a finished turn not looked at yet). */
const ready = (s: AgentStatus | undefined): boolean => s === "idle" || s === "working" || s === "done";
const unreported = (s: AgentStatus | undefined): boolean => s === undefined || s === "unknown";
/** omp ran a turn on the kickoff: the `/goal` it carries put omp in goal mode. */
const startedOn = (s: AgentStatus | undefined): boolean => s === "working" || s === "done";
/** The lane sent READY (or was closed) during the wait. */
const finished = (d: Deps, key: string): boolean => {
  const status = d.store.lane(key)?.status;
  return status === "ready" || status === "done";
};

type Look = { readonly screen: string; readonly status?: AgentStatus; readonly error?: string };

/** One read of the lane's screen (unwrapped) and status; "finished" when the lane sent READY meanwhile. */
async function look(d: Deps, lane: Lane): Promise<Look | "finished"> {
  if (finished(d, lane.key)) return "finished";
  const ref = lane.sessionRef;
  let screen: string;
  try {
    screen = await d.runtimes.for(ref).read(ref, SCREEN_LINES, { unwrapped: true });
  } catch (e) {
    return finished(d, lane.key) ? "finished" : { screen: "", error: `screen read failed: ${message(e)}` };
  }
  let status: AgentStatus;
  try {
    status = await statusOf(d.runtimes, ref);
  } catch (e) {
    return finished(d, lane.key) ? "finished" : { screen, error: `status lookup failed: ${message(e)}` };
  }
  return finished(d, lane.key) ? "finished" : { screen, status };
}

/**
 * Classifies a lane `seori start` just opened, as one line:
 * - `STARTUP_ERROR <key> <ref>: <phrase>`: a known failure phrase is on the screen (src/startup-screen.ts).
 * - `STARTUP_UNCONFIRMED <key> <ref>: <why>; last lines: ...`: no ready status, a status lookup or screen read that
 *   failed, an agent behind a dialog or gone, or omp never seen starting on the kickoff by startupWaitSeconds.
 * - `STARTUP_DONE <key>`: the lane sent READY during the wait.
 * - `STARTUP_OK <key> <ref>`: omp started on the kickoff and is idle, working or done, with no failure shown.
 * `kickedAt` is when the kickoff went in; `took` whether omp was already seen starting on it.
 */
export async function startupVerdict(d: Deps, lane: Lane, kickedAt: number, took: boolean): Promise<string> {
  const { key } = lane;
  const pane = refText(lane.sessionRef);
  const unconfirmed = (why: string, screen: string): string => `STARTUP_UNCONFIRMED ${key} ${pane}: ${why}; last lines: ${lastLines(screen)}`;
  const firstAt = kickedAt + FIRST_CHECK_MS;
  if (d.now() < firstAt) await d.sleep(firstAt - d.now());
  const first = await look(d, lane);
  if (first === "finished") return `STARTUP_DONE ${key}`;
  const bad = startupFailure(first.screen);
  if (bad) return `STARTUP_ERROR ${key} ${pane}: ${bad}`;
  if (first.error) return unconfirmed(first.error, first.screen);
  // No status yet is an agent still starting (a slow host can take minutes): it is waited for below. A `shell`, a
  // dialog (`blocked`) or a gone pane ends the start at once.
  if (!(ready(first.status) || unreported(first.status))) return unconfirmed(`no ready agent status (${first.status ?? "none"})`, first.screen);
  const waitMs = loadConfig(d.store.root).startupWaitSeconds * 1000;
  const rechecks = Math.max(0, Math.ceil((waitMs - (d.now() - kickedAt)) / RECHECK_MS));
  let shown = first.screen;
  let current = first.status;
  let seen = took || startedOn(current);
  for (let check = 0; !(ready(current) && seen); check++) {
    if (check >= rechecks) {
      const waited = Math.round((d.now() - kickedAt) / 1000);
      return unconfirmed(
        ready(current) ? `${d.agent.kind} has not started on the kickoff after ${waited} s` : `no ready agent status (${current ?? "none"}) after ${waited} s`,
        shown,
      );
    }
    await d.sleep(RECHECK_MS);
    const again = await look(d, lane);
    if (again === "finished") return `STARTUP_DONE ${key}`;
    shown = again.screen;
    current = again.status;
    seen ||= startedOn(current);
    if (again.error || !(ready(current) || unreported(current))) {
      return unconfirmed(`${again.error ?? `agent status became ${current ?? "none"}`} while waiting for it to start`, shown);
    }
    // A late failure stops the agent. A working agent's own output may quote these phrases (a file or log it reads),
    // so only an agent that is not working is checked for one.
    const failed = current !== "working" ? startupFailure(shown) : null;
    if (failed) return `STARTUP_ERROR ${key} ${pane}: ${failed}`;
  }
  return `STARTUP_OK ${key} ${pane}`;
}

/** Opens a lane (src/harness.ts openLaneSession) and classifies its start. */
export async function launchLane(d: Deps, key: string, briefFile: string, opts: StartOptions = {}): Promise<{ lane: Lane; startup: string }> {
  const started = await openLaneSession(d, key, briefFile, opts);
  return { lane: started.lane, startup: await startupVerdict(d, started.lane, started.kickedAt, started.took) };
}

/** A verdict that keeps the lane is exit 3; OK and DONE are 0. */
export const startupExit = (startup: string): number => (startup.startsWith("STARTUP_OK") || startup.startsWith("STARTUP_DONE") ? 0 : 3);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const lastLines = (screen: string): string =>
  screen
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" / ")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .slice(0, 240) || "(blank)";
