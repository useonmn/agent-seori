import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./runtime/index.ts";
import { MESSENGER_TOKEN_ENV } from "./runtime/hc/sessions.ts";
import { bootCutoff, pidAlive, type Lane } from "./store.ts";

// `seori restart`: down then up, from inside a pane whose own down closes it. The command that does the work cannot be
// the pane's process (down closes that pane, killing it mid-restart: the trap the hand-rolled /tmp/seori-restart.sh hit
// with `setsid nohup ... &`), so the caller starts a detached child and leaves the work to it.
//
// Nothing here sleeps: `seori down` waits for each process it stops (down.ts), and the up that follows starts from that
// settled state. A boot hook that restarted itself would be a loop, so this is a one-shot script, not a unit.

/** Where a restart says what it did: `$SEORI_HOME/restart.log`. The pane that asked is closed by the down, so the log is where the new lead and duty refs are read back. */
export const restartLogPath = (root: string): string => join(root, "restart.log");

/** The running worker's pid file, `$SEORI_HOME/run/restart.pid`: one restart of a home at a time. */
export const restartPidPath = (root: string): string => join(root, "run", "restart.pid");

/**
 * The pid of a restart worker of this home that is still running, or undefined (no pid file, a dead pid, or a file
 * written before this boot, whose pid may name someone else now). The worker removes its own file when it ends.
 */
export function runningRestart(root: string, alive: (pid: number) => boolean = pidAlive): number | undefined {
  const path = restartPidPath(root);
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) && statSync(path).mtimeMs >= bootCutoff() ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether closing this lane's pane ends work its agent still owes (it is working or waiting), so a restart without --force refuses it. */
export const endsWork = (lane: { readonly status: string }): boolean => lane.status === "working" || lane.status === "waiting";

/**
 * The lanes a restart closes, by recorded status: every lane that has a pane of its own (working, waiting, ready,
 * paused), since `down all` closes every terminal of the home's group, lane panes included; `seori restart` then leaves
 * out those whose pane is already gone. Each is named with the command that brings
 * it back, because the record stays but the pane does not. Of these, a working or waiting lane (endsWork) blocks the
 * restart unless --force: a waiting lane is live work blocked outside its pane, and the watches it armed for that end
 * once its lost pane makes it lost. A ready lane has sent its final answer and a paused one was told to stop, so
 * neither blocks.
 */
export function lanesARestartCloses<L extends { readonly status: string }>(lanes: readonly L[]): L[] {
  return lanes.filter((l) => endsWork(l) || l.status === "ready" || l.status === "paused");
}

/** What a lane's way back is read from: the record's launch settings. */
export type RestartableLane = Pick<Lane, "key" | "brief" | "cwd"> &
  Partial<Pick<Lane, "thread" | "done" | "ceilings" | "activityPaths" | "model" | "workflow">>;

/**
 * A closed lane's way back, from its record: the same key, brief and cwd, plus every launch setting `seori start` took
 * (thread, Done line, ceilings, activity paths, model, workflow), so the lane comes back as it was started and not on
 * today's config defaults. The workflow is always named: a record without one was started with none, and a bare start
 * would take the config's.
 */
export function startAgain(lane: RestartableLane, seoriCmd: string): string {
  const limit = (n: number | null): string => (n === null ? "none" : String(n));
  return [
    `${seoriCmd} start ${lane.key} --brief ${shq(lane.brief)} --cwd ${shq(lane.cwd)}`,
    ...(lane.thread !== undefined ? [`--thread ${shq(lane.thread)}`] : []),
    ...(lane.done !== undefined ? [`--done ${shq(lane.done)}`] : []),
    ...(lane.ceilings !== undefined
      ? [`--wall-minutes ${limit(lane.ceilings.wallMinutes)} --token-limit ${limit(lane.ceilings.tokens)} --cost-limit ${limit(lane.ceilings.costUsd)}`]
      : []),
    ...(lane.activityPaths ?? []).map((p) => `--activity-path ${shq(p)}`),
    ...(lane.model !== undefined ? [`--model ${shq(lane.model)}`] : []),
    `--workflow ${lane.workflow ?? "none"}`,
  ].join(" ");
}

/** What a closed pane meant for a lane of each status: said by the restart, the duty's [LOST] and boot's VANISHED. */
const CLOSED_MEANT: Readonly<Record<string, string>> = {
  working: "its work in progress stopped with the pane",
  waiting: "it was waiting on something outside its pane (CI, a review), and the watches it armed end once it is lost",
  ready: "it had sent READY: its final answer and evidence stay, and seori merge and seori done need no pane",
  paused: "it was paused, not failed",
};
const closedMeant = (status: string): string => CLOSED_MEANT[status] ?? `it was ${status}`;

/** A lane whose pane closed, as the restart, duty and boot read it: its status and its way back. */
export type ClosedLane = RestartableLane & { readonly status: string };

/**
 * What closing the lane's pane meant, and how it comes back: `seori start` takes back the key of an open lane whose pane
 * is gone, so its command works as soon as the pane is closed, before duty marks it lost (duty never marks a ready lane
 * lost, since its claim stands for merge and done).
 */
export function closedNote(lane: ClosedLane, seoriCmd: string): string {
  const back = lane.status === "ready" ? "if it needs more work, resume it with: " : "resume it with: ";
  return `${closedMeant(lane.status)}; ${back}${startAgain(lane, seoriCmd)}`;
}

/**
 * The line a restart prints, and writes to its log, for each lane it closes: ENDED for one whose work it ends (only
 * with --force), CLOSED for the rest.
 */
export function closedLaneLine(lane: ClosedLane, seoriCmd: string): string {
  return `${endsWork(lane) ? "ENDED" : "CLOSED"} ${lane.key} status=${lane.status}: the down closes its pane (record and brief stay); ` +
    closedNote(lane, seoriCmd);
}

/** The duty's [LOST] message for a lane whose pane is gone, whatever its status was and whatever closed the pane. */
export function lostText(lane: ClosedLane, pane: string, seoriCmd: string): string {
  return `[LOST ${lane.key}] pane ${pane} closed without a final answer while the lane was ${lane.status}; ` +
    `${closedMeant(lane.status)}; its record and brief stay; to resume it: ${startAgain(lane, seoriCmd)}`;
}

/**
 * The refusal for a restart that would end lanes still owed work: those keys, both ways on (`--force`, or wait for
 * them), and the lanes it would also close, which do not block.
 */
export function lanesRefusal(closed: readonly { readonly key: string; readonly status: string }[]): string {
  const list = (ls: readonly { readonly key: string; readonly status: string }[]): string => ls.map((l) => `${l.key} (${l.status})`).join(", ");
  const ending = closed.filter(endsWork);
  const others = closed.filter((l) => !endsWork(l));
  return (
    `seori restart would end ${ending.length} lane(s) still owed work: ${list(ending)}. ` +
    `down closes every terminal of this home, lane panes included: their records stay, but their work stops, and a waiting ` +
    `lane's watches end once it is lost. Wait for them, or pass --force to end them; the restart names every lane it closes with ` +
    `the command that resumes it` +
    (others.length > 0 ? `. It would also close ${others.length} lane(s) that do not block: ${list(others)}` : "")
  );
}

export type ScriptOptions = {
  /** $SEORI_HOME. */
  readonly home: string;
  /** The agents' working directory for the up (`seori up --cwd`). */
  readonly cwd: string;
  /** How the child calls seori (d.seoriCmd: an env prefix plus bun and cli.ts). */
  readonly seoriCmd: string;
  /** The log the child writes to; restartLogPath(home) in use. */
  readonly log: string;
  /** Lines logged right after RESTART_BEGIN: the lanes this restart ends or closes (ENDED, CLOSED; see closedLaneLine). */
  readonly notes?: readonly string[];
};

/**
 * The detached child's `sh -c` body: check that hc answers, down, up, and say which step failed. A down that does not
 * finish leaves the up out (a half-stopped home must not be doubled up), and every failure ends the script non-zero with
 * one RESTART_FAILED line naming it. The up prints its own `UP lead=... duty=...` line into the log, which is where the
 * caller's pane, closed by the down, cannot.
 *
 * The down is `down all --keep-autostart`: a restart is not an uninstall, so the home's logon hook (if installed) stays.
 *
 * One worker per home: it creates restartPidPath(home) exclusively (`set -C`) before it touches anything, and a second
 * worker that finds a live pid there ends with RESTART_FAILED, stopping nothing. A file left by a worker that was killed
 * is taken over. `seori restart` refuses up front on the same file (runningRestart); this closes the race between two.
 *
 * The last line is always `RESTART_EXIT=<code>`: the caller's pane is closed by the down, so the log is the only place
 * the outcome of a detached restart can be read (`seori restart --follow` reads it there).
 *
 * SIGHUP is ignored for the whole run: closing a terminal sends it to everything that pane started, and a restart must
 * outlive precisely that. (`nohup` already ignores it for the worker it starts; this keeps the guarantee for a worker
 * launched some other way, and costs nothing.) SIGTERM is left alone, so an operator can still kill a worker that hangs.
 */
export function restartScript(o: ScriptOptions): string {
  const seori = o.seoriCmd;
  const take = `(set -C; echo "$$" > "$lock") 2>/dev/null`;
  return [
    `exec >>${shq(o.log)} 2>&1`,
    `lock=${shq(restartPidPath(o.home))}`,
    // One exit path, so the code is logged whatever happened; the pid file goes only when it is this worker's.
    `finish() { if [ "$(cat "$lock" 2>/dev/null)" = "$$" ]; then rm -f "$lock"; fi; echo "RESTART_EXIT=$1"; exit "$1"; }`,
    `trap '' HUP`,
    // The worker's own pid, so an operator can watch or kill it: a detached worker has no other handle.
    `echo "RESTART_PID $$"`,
    // Quoted like any other argument: a home or cwd with `$VAR`, backticks or `$(cmd)` in it is printed, not expanded.
    `echo ${shq(`RESTART_BEGIN home=${o.home} cwd=${o.cwd}`)}`,
    `mkdir -p ${shq(join(o.home, "run"))}`,
    `if ! ${take}; then`,
    `  other=$(cat "$lock" 2>/dev/null)`,
    `  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then`,
    `    echo "RESTART_FAILED another restart of this home is running (pid $other); nothing stopped, nothing opened"; finish 1`,
    `  fi`,
    `  rm -f "$lock"`,
    `  if ! ${take}; then`,
    `    echo "RESTART_FAILED another restart of this home took over; nothing stopped, nothing opened"; finish 1`,
    `  fi`,
    `fi`,
    // hc may be down after a crash or a core restart: no up could open a pane, so nothing is stopped either.
    `if ! hc --json server status >/dev/null 2>&1; then`,
    `  echo "RESTART_FAILED hc (herdr-core) does not answer; nothing stopped, nothing opened"; finish 1`,
    `fi`,
    // Logged only once the down is about to run: the pane that asked is closed by it, so this is where the lanes it ends
    // or closes are read back.
    ...(o.notes ?? []).map((n) => `echo ${shq(n)}`),
    `if ! ${seori} down all --keep-autostart; then`,
    `  echo "RESTART_FAILED seori down did not finish; nothing opened"; finish 1`,
    `fi`,
    `if ${seori} up --cwd ${shq(o.cwd)}; then`,
    `  echo "RESTART_DONE"; finish 0`,
    `fi`,
    `echo "RESTART_FAILED seori up failed; see its lines above"; finish 1`,
  ].join("\n");
}

/**
 * The ways a restart can detach, best first; `seori restart` tries them in order and takes the first that starts:
 * - `setsid --fork`: a new session; the intermediate process exits at once, so the worker is reparented to init. A
 *   setsid without --fork (busybox) exits non-zero having started nothing, and the next way is tried.
 * - `systemd-run --user`: a transient unit of the user manager. That unit gets the manager's environment, not this
 *   one, so PATH (where hc and bun are) and the caller's SEORI_* and HC_* variables are passed on with --setenv; the
 *   messenger tokens are not (an argv is readable in /proc and a unit's environment in `systemctl show`, and no unit
 *   ever gets a token). The manager expands `$` in a transient unit's command, so the script's `$` is written `$$`.
 * - `nohup ... &`: portable (macOS has no setsid); the worker stays in this session and process group but ignores
 *   SIGHUP, the signal a closed pane sends. It always exits 0, so it is last.
 * Empty only when none of them is on PATH. Every way reports through the log, not its exit code: 0 means started.
 */
export type Detach = { readonly via: string; readonly argv: readonly string[] };

const TOKENS: ReadonlySet<string> = new Set(MESSENGER_TOKEN_ENV);

export function detachWays(
  script: string, has: (bin: string) => boolean, unit: string, env: Readonly<Record<string, string | undefined>>,
): Detach[] {
  const passed = Object.entries(env)
    .filter((e): e is [string, string] => e[1] !== undefined && (e[0] === "PATH" || e[0].startsWith("SEORI_") || e[0].startsWith("HC_")))
    .filter(([k]) => !TOKENS.has(k))
    .map(([k, v]) => `--setenv=${k}=${v}`);
  return [
    ...(has("setsid") ? [{ via: "setsid", argv: ["setsid", "--fork", "/bin/sh", "-c", script] }] : []),
    ...(has("systemd-run")
      ? [{
          via: "systemd-run",
          argv: ["systemd-run", "--user", "--collect", "--quiet", `--unit=${unit}`, ...passed, "/bin/sh", "-c", script.split("$").join("$$")],
        }]
      : []),
    ...(has("nohup") ? [{ via: "nohup", argv: ["/bin/sh", "-c", `nohup /bin/sh -c ${shq(script)} >/dev/null 2>&1 &`] }] : []),
  ];
}

/** The refusal text for a host that cannot detach a restart: said before anything is stopped. */
export const noDetachRefusal = (): string =>
  "seori restart needs a way to detach the relaunch from this pane (setsid, systemd-run or nohup on PATH) and none is there: " +
  "run it from a shell outside the group instead";
