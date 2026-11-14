import { join } from "node:path";
import { shq } from "./runtime/index.ts";

// `seori restart`: down then up, from inside a pane whose own down closes it. The command that does the work cannot be
// the pane's process (down closes that pane, killing it mid-restart: the trap the hand-rolled /tmp/seori-restart.sh hit
// with `setsid nohup ... &`), so the caller starts a detached child and leaves the work to it.
//
// Nothing here sleeps: `seori down` waits for each process it stops (down.ts), and the up that follows starts from that
// settled state. A boot hook that restarted itself would be a loop, so this is a one-shot script, not a unit.

/** Where a restart says what it did: `$SEORI_HOME/restart.log`. The pane that asked is closed by the down, so the log is where the new lead and duty refs are read back. */
export const restartLogPath = (root: string): string => join(root, "restart.log");

export type LaneBlock = { readonly key: string };

/**
 * The lanes a restart would end. `down all` closes every terminal of the home's group, lane panes included, so a restart
 * quietly kills running work: only a lane that is working is counted (ready, paused, done and lost lanes have no agent
 * still producing), and only that blocks. The record stays either way, so the key can be started again.
 */
export function lanesARestartEnds(lanes: readonly { readonly key: string; readonly status: string }[]): LaneBlock[] {
  return lanes.filter((l) => l.status === "working").map((l) => ({ key: l.key }));
}

/** The refusal for a restart that would end running lanes: the keys, and both ways on (`--force`, or wait for them). */
export function lanesRefusal(blocks: readonly LaneBlock[], seoriCmd: string): string {
  const keys = blocks.map((b) => b.key).join(", ");
  return (
    `seori restart would end ${blocks.length} working lane(s): ${keys}. ` +
    `down closes every terminal of this home, lane panes included, and their records stay but their work stops. ` +
    `Wait for them, or pass --force to end them (the restart names each key it ended); a closed lane starts again with: ` +
    `${seoriCmd} start <key> --brief <SEORI_HOME>/briefs/<key>.md --cwd <its cwd>`
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
};

/**
 * The detached child's `sh -c` body: check that hc answers, down, up, and say which step failed. A down that does not
 * finish leaves the up out (a half-stopped home must not be doubled up), and every failure ends the script non-zero with
 * one RESTART_FAILED line naming it. The up prints its own `UP lead=... duty=...` line into the log, which is where the
 * caller's pane, closed by the down, cannot.
 *
 * The last line is always `RESTART_EXIT=<code>`: the caller's pane is closed by the down, so the log is the only place
 * the outcome of a detached restart can be read (`seori restart --follow` reads it there).
 *
 * SIGHUP is ignored for the whole run: closing a terminal sends it to everything that pane started, and a restart must
 * outlive precisely that. SIGTERM is left alone, so an operator can still kill a worker that hangs.
 */
export function restartScript(o: ScriptOptions): string {
  const seori = o.seoriCmd;
  return [
    `exec >>${shq(o.log)} 2>&1`,
    // One exit path, so the code is logged whatever happened.
    `finish() { echo "RESTART_EXIT=$1"; exit "$1"; }`,
    `trap '' HUP`,
    `echo "RESTART_BEGIN home=${o.home} cwd=${o.cwd}"`,
    // hc may be down after a crash or a core restart: no up could open a pane, so nothing is stopped either.
    `if ! hc --json server status >/dev/null 2>&1; then`,
    `  echo "RESTART_FAILED hc (herdr-core) does not answer; nothing stopped, nothing opened"; finish 1`,
    `fi`,
    `if ! ${seori} down all; then`,
    `  echo "RESTART_FAILED seori down did not finish; nothing opened"; finish 1`,
    `fi`,
    `if ${seori} up --cwd ${shq(o.cwd)}; then`,
    `  echo "RESTART_DONE"; finish 0`,
    `fi`,
    `echo "RESTART_FAILED seori up failed; see its lines above"; finish 1`,
  ].join("\n");
}

/**
 * How a restart detaches, best first: `setsid --fork` (a new session; the intermediate process exits at once, so the
 * worker is reparented to init), `systemd-run --user` (a transient unit of the user manager), else `nohup` (portable:
 * the worker keeps this session but ignores SIGHUP, the signal a closed pane sends, which is what the hand-rolled
 * script this command replaces did). Undefined only when none of them is on PATH.
 *
 * `background`: the worker is started detached from this process's lifetime (`nohup ... &` inside a bare `sh -c`), so
 * there is no child exit code to read; the log's RESTART_EXIT line is the only outcome either way.
 */
export type Detach = { readonly argv: readonly string[]; readonly background: boolean };

export function detachArgv(script: string, has: (bin: string) => boolean, unit: string): Detach | undefined {
  if (has("setsid")) return { argv: ["setsid", "--fork", "/bin/sh", "-c", script], background: false };
  if (has("systemd-run")) {
    return { argv: ["systemd-run", "--user", "--collect", "--quiet", `--unit=${unit}`, "/bin/sh", "-c", script], background: false };
  }
  if (has("nohup")) return { argv: ["/bin/sh", "-c", `nohup /bin/sh -c ${shq(script)} >/dev/null 2>&1 &`], background: true };
  return undefined;
}

/** The refusal text for a host that cannot detach a restart: said before anything is stopped. */
export const noDetachRefusal = (): string =>
  "seori restart needs a way to detach the relaunch from this pane (setsid, systemd-run or nohup on PATH) and none is there: " +
  "run it from a shell outside the group instead";
