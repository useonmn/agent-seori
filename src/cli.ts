#!/usr/bin/env bun
// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  defaultDeps, done, dutyTick, inboxList, mergeGate, paneEnv, ready, Refusal, releaseHeld, report, review, send, sendToShell,
  startAgent, ROLES, type Deps, type DutyEvent, type SendResult,
} from "./harness.ts";
import { DeliveryUncertain, deliverOrThrow } from "./runtime/delivery.ts";
import { heartbeatPath, runDaemon } from "./daemon.ts";
import { down, DOWN_GROUPS, liveRunners, running, sleepUnless, type Runner } from "./down.ts";
import { defaultSkillsDir, installSkill, SEORI_SRC, uninstall } from "./install.ts";
import { backlogAdd, backlogDecide, backlogDrop, backlogImport, loopTick, msUntilNext, summary, HOUR, IMPORT_LIMIT } from "./loop.ts";
import { loadMessengers } from "./messenger/adapter.ts";
import { adapterFor } from "./messenger/index.ts";
import { PresenceConfigError, realPresenceDeps, redact, runPresence } from "./messenger/presence.ts";
import { msgClose, msgDepsFor, msgEdit, msgEditReplyOf, msgList, msgSend, parseTo } from "./msg.ts";
import { isWorkflow, type Workflow, WORKFLOWS } from "./workflow.ts";
import type { SessionRef } from "./runtime/index.ts";
import { lockFile, pidAlive, type Lane, type LaneStatus, type Role } from "./store.ts";
import { parsePr, promptsDir } from "./harness.ts";
import { hooksSettled, loadHooks } from "./hooks.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import { candidateLine, DEFAULT_PAIR_MINUTES, pairedLine, pairOwner } from "./pair.ts";
import { canLaunch, canLaunchLine, guardLines } from "./guard.ts";
import { launchLane, startupExit } from "./startup-verdict.ts";
import { runHeavy } from "./heavy.ts";
import { objectDone } from "./done-flow.ts";
import { pauseLane, resumeLane, Unverified } from "./pause.ts";
import { bootReport } from "./boot.ts";
import { worklogAdd, worklogClose, worklogItemLine, worklogList, worklogListOutput, worklogNext, worklogNote } from "./worklog.ts";
import { ConfigError, configPath, loadConfig } from "./config.ts";
import { formatCheckpoints, formatCheckpointWrite, listCheckpoints, recordCheckpoint } from "./checkpoints.ts";
import { addLesson, formatLessonAdded, formatLessonMarked, formatLessons, isLessonMark, listLessons, markLesson } from "./lessons.ts";
import { verifyPr } from "./verify-pr.ts";
import { adoptLane, syncRegistry } from "./adopt-sync.ts";
import { ownerText, WATCH_USAGE, watchAdd, watchList, watchLog, watchRearm, watchStop } from "./watch/cli.ts";
import { WatchRefusal } from "./watch/store.ts";
import { HerdrRecord, refText } from "./refs.ts";
import { parseRef } from "./runtime/types.ts";
import {
  BOOT_KIND, bootUnitInstalled, homeTag, installBootUnit, removeUnits, systemctl, unitCwd, unitDir, unitName, writeUnits, type UnitKind,
  type UnitSpecKind,
} from "./systemd.ts";
import {
  closedLaneLine, detachWays, endsWork, lanesARestartCloses, lanesRefusal, noDetachRefusal, restartLogPath, restartScript,
  runningRestart,
} from "./restart.ts";
import { hcReason } from "./runtime/hc/exec.ts";

const USAGE = `seori - a proactive multi-session harness for omp on hc

  seori up [--cwd DIR] [--wait-hc]             start this home's lead, duty, duty loop, hourly loop and daemon (once per home):
                                              lead and duty terminals labelled seori.group=<name> (cwd default $SEORI_HOME);
                                              daemon, duty loop and hourly loop as systemd --user units
                                              seori-<name>-<hash>-<daemon|duty|hourly> on Linux, as hc terminals on macOS.
                                              ALREADY UP (nothing opened) while the lead and duty panes are live; when either
                                              is gone (a reboot, an hc restart) it reopens exactly the missing panes and leaves
                                              the running units alone; UP BUSY (exit 0, nothing opened) while another up of
                                              this home is opening it; --wait-hc waits for hc first (the logon hook)
  seori restart [--cwd DIR] [--force] [--follow]
                                              down then up for this home, safe from inside the lead or duty pane: the
                                              work runs in a detached child (setsid/systemd-run/nohup), because down closes the
                                              caller's pane. Refused while a lane is working or waiting unless --force,
                                              and while another restart of this home runs; every lane whose pane it
                                              closes (working, waiting, ready, paused) is named with the command that
                                              resumes it (ENDED, CLOSED); keeps the logon hook; DIR defaults to the cwd
                                              this home's units run in, else $SEORI_HOME; new refs go to
                                              $SEORI_HOME/restart.log, --follow prints them
  seori autostart install [--cwd DIR]          write and enable the logon hook (a systemd --user oneshot running
                                              seori up --wait-hc --cwd DIR), so the lead and duty panes come back after a
                                              reboot; DIR defaults to the cwd this home's units run in, else $SEORI_HOME
  seori autostart status                       whether that hook is installed
  seori role <lead|duty> [REF]                 register a session (hc:t7) as lead or duty (default: this one)
  seori start <key> --brief FILE [--cwd DIR]   open a lane: new terminal, agent session, lessons + brief + lane rules
              [--done "SIGNALS"] [--thread ID] [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--force]
              [--activity-path PATH ...] [--model M] [--workflow W|none]
                                              Done line read back live before close; ID = lead channel id for progress posts;
                                              ceilings block (report to lead); exits 4 with HOLD when the host is full;
                                              a written activity file (or an entry added to or removed from an
                                              activity directory) counts as progress in the stall check; M = this lane's
                                              omp model instead of SEORI_MODEL; --workflow W (ulw,
                                              mass-ulw, ulw-research, ulw-plan, ulw-loop, ulw-execute): the kickoff is
                                              /goal W <keyword> ... (needs the omp-ulw extension), none: plain goal mode
                                              whatever config workflow says;
                                              prints STARTED, then waits for the start (config startupWaitSeconds, 180 s):
                                              STARTUP_OK|STARTUP_DONE exit 0, STARTUP_ERROR|STARTUP_UNCONFIRMED exit 3 (lane kept)
  seori adopt <key> --ref <hc:tN> [--brief FILE] [--cwd DIR]
                                              register an already-running session as a lane (types nothing into it)
  seori sync [--write]                         lane registry vs live sessions in the seori.group group; with --write a
                                              vanished lane is marked lost (no session is ever closed)
  seori transcribe <audio-file>                run hooks.transcribe (config.json, argv template with {file}) and print the text
  seori report <key> --text T [--status working|waiting]
  seori ready <key> --text T --evidence LINK [--evidence LINK ...]
  seori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                  [--to-shell]                operator only: type this one message into a pane with no agent
  seori inbox list <pane|role|key>             queued entries: index, state (queued|held), sender, time, first 60 chars
  seori inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
  seori inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
  seori duty [--once] [--interval SECONDS]     flush inboxes, nudge silent lanes, escalate, detect lost lanes, close Done lanes,
                                              ceilings and stalls, host guard, progress posts to the owner's thread,
                                              dead agents and agent sessions nothing owns
  seori duty stop [--text WHY] | resume | status   kill switch
  seori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                              hourly: sync backlog, audit missed work, start the next item, ask decisions
  seori loop stop [--text WHY] | resume | status   kill switch and last run
  seori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  seori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
  seori backlog import <owner/repo> [--label seori] [--cwd DIR]   open labelled issues -> items
  seori review <owner/repo#N> [--model M]      fresh isolated agent reviewer at the exact head -> receipt
  seori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks + verify-pr -> squash merge
  seori verify-pr <owner/repo#N>               commit identities (config repoIdentities) + fix-needs-a-test rule; exit 2 on FAIL
  seori done <key> [--lesson T [--evidence P]] lead closes a READY lane (a Done line must read back live); optional lesson
  seori object <key> --reason T [--reason T]   the lead objects to a READY claim: back to working with the reasons
  seori pause <key> [--note T] | resume <key> [--note T]   pause/resume a lane's agent goal (exit 3 if unconfirmed)
  seori checkpoint <key> --step ID --result T --evidence P [--remote-effect R ...] | checkpoints <key>
  seori lesson add <key|--cwd DIR> --rule T --evidence P | lesson list [--cwd DIR] | lesson mark <id> --outcome O
                                              O = helped|no-effect|harmful|encoded; new lanes get a repo's pending/helped lessons
  seori lesson add --global --rule T --evidence P   the lead's rule for every lane (refused from a lane's terminal)
  seori worklog add <title> --source REF | next <id> <text> | note <id> <text> | close <id> --result T | list [--open]
  seori boot                                   read-only check after a restart or compaction (exit 1 if unreadable or drifted)
  seori can-launch | guard                     room for a lane? (exit 4 HOLD) | host reading and guard state
  seori heavy <label> -- <cmd...>              run a heavy command when load is low and a heavy slot is free
  seori status
  seori daemon                                 receive messengers into the lead channel and run watches (seori up runs it)
  seori daemon-loop                            run the daemon and restart it when it crashes (seori up's daemon unit or pane)
  seori down [duty|loop|daemon|all] [--keep-autostart]
                                              stop the duty loop, hourly loop and daemon (default all); all also disables
                                              the systemd units and the logon hook (kept with --keep-autostart, as seori
                                              restart does) and closes the seori.group terminals; exit 1 if a process
                                              still runs after 30 s
  seori install-skill [--skills-dir DIR]       link the seori-mode skill into the agent's skills dir; install.sh runs it
  seori uninstall [--skills-dir DIR] [--purge] remove the skill link and the seori command; --purge also deletes $SEORI_HOME
  seori msg send (--reply-to ID[,ID...] | --to SOURCE:CHAT[:THREAD]) --text T [--again]
                                              answer messenger messages (one reply per id) or send a notice; it goes out
                                              at once, so answer as soon as you have written it; --again sends another
                                              reply to an id already answered (a correction)
  seori msg close <id> --why T                 close a lead channel message (messenger message or watch event) that needs no reply
  seori msg list [--all]                       open lead channel messages (messenger messages and watch events; --all: every one)
                                              columns: id  state  age  kind  sender-or-watch-name  text
  seori msg edit (--reply-of ID | --to SOURCE:CHAT[:THREAD] --message MID) --text T
                                              replace the text of a message seori sent: --reply-of edits seori's first reply
                                              to that lead channel message; MID: the message= send printed
  seori msg check [SOURCE]                     verify messengers' tokens (prints who the bot is); SOURCE works before pairing
  seori msg pair <SOURCE> [--minutes N] [--write] [--all] [--force]
                                              setup: print the sender of the next DM to the bot; --write makes them the owner;
                                              --force re-pairs a configured Telegram owner (drops updates queued for the daemon)
  seori presence discord                       keep the Discord bot shown online until stopped (Ctrl-C); prints PRESENCE_READY;
                                              reconnects with backoff (PRESENCE_RECONNECT discord code=C retry_in=Ns)
${WATCH_USAGE}

--text may be omitted to read the message from stdin.
send, report and ready exit 3 and print HELD <target> when the delivery may or may not have reached the pane:
it is held and never resent, so do not send it again: check the pane, then seori inbox ack or seori inbox resend it.
QUEUED (exit 0) means it waits in the pane's inbox.
msg send exits 3 with HELD when the messenger may or may not have the reply: check the chat, then pass --again.
msg edit acts at once and is safe to repeat; a messenger error prints FAILED and exits 1.
A second reply to an id is refused (exit 2) unless --again is given: send the correction as its own message.
SEORI_MODEL=M passes --model M to every agent seori starts (lead, duty, lanes) and is the reviewer's default model.
seori runs omp only: SEORI_AGENT or "agent" in $SEORI_HOME/config.json naming anything else is refused (exit 2); SEORI_AGENT_CMD overrides the omp command and must name omp (its basename is omp).
watch add arms the watch for the lane in SEORI_LANE (set in every lane's pane), else for the lead; refusals exit 2.
watch stop, rearm and log take a name of that same owner's live watches (--for picks another owner) or any watch's id.
seori runs its sessions in hc (herdr-core) terminals; hc must be on PATH.`;

type Args = { pos: string[]; flags: Map<string, string[]>; /** Everything after a bare `--`, verbatim (seori heavy). */ rest: string[] };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "once", "force", "dry-run", "to-shell", "again", "all", "persistent", "write", "open", "purge", "help", "global",
  // up --wait-hc (the logon hook), restart --follow (watch the detached restart's log) and down --keep-autostart (what
  // the restart worker runs) never take a value.
  "wait-hc", "follow", "keep-autostart",
]);

function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") return { pos, flags, rest: argv.slice(i + 1) };
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    // A value flag at the very end (--text $MSG with MSG unset) has no value; reading it as "true" would send that word.
    const value = BOOLEAN_FLAGS.has(name) ? "true" : argv[++i];
    if (value === undefined) throw new Refusal(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags, rest: [] };
}

const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.at(-1);
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Refusal(`missing ${what}\n\n${USAGE}`);
  return v;
};

async function textOf(a: Args): Promise<string> {
  const given = one(a, "text");
  if (given === undefined && process.stdin.isTTY) throw new Refusal("give --text or pipe the message on stdin");
  const text = given ?? (await Bun.stdin.text()).trim();
  // An unset variable (--text "$MSG") or an empty pipe would type a blank message into the pane and print DELIVERED.
  if (!text.trim()) throw new Refusal("the message is empty: give --text or pipe the message on stdin");
  return text;
}

/** Prints the line for a delivery that did not land now and returns the exit code: HELD 3, everything else 0. */
function deliveryOutcome(result: SendResult | undefined, target: string): number {
  if (result === "HELD") {
    console.log(`HELD ${target}: delivery may or may not have reached the pane; do not resend`);
    return 3;
  }
  if (result === "QUEUED") console.log(`QUEUED ${target}`);
  return 0;
}

function renderPrompt(d: Deps, name: string): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(join(promptsDir(), name), "utf8").replaceAll("{{seori}}", d.seoriCmd);
  const out = join(dir, name);
  writeFileSync(out, src);
  return out;
}

/** The lead channel extension (extensions/lead-channel.ts): only the lead loads it, so only the lead gets messenger messages. */
export const LEAD_EXTENSION = join(import.meta.dir, "..", "extensions", "lead-channel.ts");

/**
 * The daemon pane's restart loop (`seori daemon-loop`), in bun. A daemon that crashed (SIGKILL, OOM, a panic), exited to load a changed messengers.json, or was sent SIGHUP
 * (129) is back within about a second. Only a deliberate stop ends the loop: the daemon ending on Ctrl-C (130),
 * kill/SIGTERM or `seori down` (143), or `stopping()` (the loop itself got Ctrl-C, SIGTERM or a `seori down` request). Closing the pane hangs up the loop too, so nothing
 * restarts then.
 */
export async function daemonLoop(
  start: () => Promise<number>,
  stopping: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<number> {
  for (;;) {
    const status = await start();
    if (status === 130 || status === 143 || stopping()) return status;
    await sleep(1000);
    if (stopping()) return status;
  }
}

async function runDaemonLoop(root: string): Promise<number> {
  let stopping = false;
  // `seori down` asks the loop and its daemon separately: the daemon cleans up and ends, the loop does not restart it.
  const me = running(root, "daemon-loop");
  me.stopped.addEventListener("abort", () => { stopping = true; });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  // Ctrl-C reaches the daemon too: wait for its cleanup. A SIGTERM to the loop is passed on.
  const onInt = (): void => { stopping = true; };
  const onTerm = (): void => { stopping = true; child?.kill("SIGTERM"); };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    return await daemonLoop(async () => {
      const p = Bun.spawn([process.execPath, import.meta.path, "daemon"], { env: process.env, stdio: ["inherit", "inherit", "inherit"] });
      child = p;
      await p.exited;
      const sig = p.signalCode;
      return p.exitCode ?? 128 + (typeof sig === "string" ? osConstants.signals[sig] : (sig ?? 0));
    }, () => stopping);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    me.release();
  }
}

/** A pane `seori up` opens for the home itself. */
type PaneRole = "lead" | "duty";

/**
 * What `seori up` has to do, from the facts of this home alone, so an autostart hook can call it every logon:
 * - healthy: the lead and duty panes are both live; nothing opens (a second up opens nothing, whatever else is running);
 * - panes: the lead or the duty pane is gone (a reboot, an hc core restart, a closed pane) while this home is still
 *   resident, here or in its units; only the panes listed in `missing` open, and the units are left exactly as they are;
 * - fresh: nothing of this home is running, so up opens the whole set.
 */
export type UpPlan =
  | { readonly kind: "healthy"; readonly lead: SessionRef; readonly runners: readonly Runner[] }
  | { readonly kind: "panes"; readonly runners: readonly Runner[]; readonly missing: readonly PaneRole[]; readonly live: Partial<Record<PaneRole, SessionRef>> }
  | { readonly kind: "fresh" };

/** The line a healthy home prints: nothing opened. */
export const alreadyUpLine = (name: string, root: string, lead: SessionRef, runners: readonly Runner[]): string =>
  `ALREADY UP name=${name} home=${root} lead=${refText(lead)} running=${runners.join(",") || "none"}; nothing opened`;

/**
 * The state of this home before `seori up` opens anything. A recorded role counts only while a live terminal carries its
 * id and this home's seori.group label: hc terminal ids start over after a core restart, so a remembered id may name a
 * stranger's terminal. A home that is resident but has lost a pane reopens exactly the panes that are gone (never a
 * second lead, and never a restart of a running unit); `fresh` is a home with nothing of its own running at all.
 * Terminals of this home's group that belong to no home of its own are refused: opening a second set under that label
 * would fight them.
 */
export async function upCheck(d: Deps, name: string, alive: (pid: number) => boolean = pidAlive): Promise<UpPlan> {
  const root = d.store.root;
  const runners = liveRunners(root, alive);
  const rt = d.runtime;
  const roles = d.store.roles();
  const live = new Set((await rt.list({ group: name })).map((s) => s.ref.id));
  const isLive = (ref: SessionRef | undefined): ref is SessionRef => ref !== undefined && live.has(ref.id);
  const lead = isLive(roles.lead) ? roles.lead : undefined;
  const duty = isLive(roles.duty) ? roles.duty : undefined;
  if (lead !== undefined && duty !== undefined) return { kind: "healthy", lead, runners };
  const mineLive = (await homeTerminals(d, name)).some((r) => live.has(r.id));
  if (runners.length > 0 || mineLive) {
    return {
      kind: "panes",
      runners,
      missing: [...(lead === undefined ? (["lead"] as const) : []), ...(duty === undefined ? (["duty"] as const) : [])],
      live: { ...(lead === undefined ? {} : { lead }), ...(duty === undefined ? {} : { duty }) },
    };
  }
  const named = (await rt.groups()).filter((w) => w.label === name);
  if (named.length > 0) {
    throw new Refusal(
      `hc terminals labelled seori.group="${name}" (${named.map((w) => w.id).join(", ")}) are open, but this home (${root}) has no live lead, ` +
        `loop or daemon in it. Close those terminals if they are a leftover of this home, or give this home its own name in ${configPath(root)}`,
    );
  }
  return { kind: "fresh" };
}

/** How long `seori up --wait-hc` waits for the hc core to answer before it says so and ends. */
export const HC_WAIT_MS = 10 * 60_000;
/** How often it asks. A core that starts while the hook waits is picked up within this. */
export const HC_POLL_MS = 2_000;

/** What became of the one `hc server start` a wait may attempt: not attempted (the core already answered), or its result. */
export type HcStartAttempt = { readonly tried: false } | { readonly tried: true; readonly ok: boolean; readonly why?: string };

/** The wait's outcome: whether the core answered, what starting it did, and the last status hc gave. */
export type HcWaitResult = {
  readonly up: boolean;
  readonly start: HcStartAttempt;
  /** The last `hc server status` exit code, or undefined when the call itself failed. */
  readonly statusCode?: number;
  /** hc's own words from that status (its JSON `error.message`), when it gave any. */
  readonly statusWhy?: string;
  /** How long it waited (ms by the injected clock). */
  readonly waitedMs: number;
};

/**
 * Starts the hc core once, for the logon path. Idempotent on a live core (hc answers with the same core), so this is
 * only ever called after a status showed no core. A failure is reported, never thrown: a slow core may still come up.
 */
async function hcStart(d: Deps): Promise<Extract<HcStartAttempt, { tried: true }>> {
  try {
    const r = await d.exec("hc", ["--json", "server", "start"]);
    if (r.code === 0) return { tried: true, ok: true };
    // hc's own sentence, not its JSON envelope: this line ends up in the journal for a human to read.
    return { tried: true, ok: false, why: hcReason(r) };
  } catch (e) {
    return { tried: true, ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The logon path's wait: polls the core (no fixed sleep, so a core that is already up costs one call) until it answers or
 * `waitMs` passes by the clock. hc 0.1.20 starts a core on demand even for `status`, so this poll usually brings one up by
 * itself; when a poll still finds none (an hc whose on-demand start is unavailable: no `server start`, or a state dir it
 * cannot write) the wait runs `hc server start` exactly once and keeps polling, because the hook's job is to bring seori
 * back and seori needs a core. It never starts a core that answers, and never twice. The outcome carries the last status
 * and the start attempt, so the caller can say what was tried rather than only that it failed.
 */
export async function waitForHcResult(
  d: Deps, waitMs: number = HC_WAIT_MS, log: (line: string) => void = console.error,
): Promise<HcWaitResult> {
  const began = d.now();
  let told = false;
  let start: HcStartAttempt = { tried: false };
  let statusCode: number | undefined;
  let statusWhy: string | undefined;
  for (;;) {
    try {
      const r = await d.exec("hc", ["--json", "server", "status"]);
      statusCode = r.code;
      if (r.code === 0) return { up: true, start, statusCode, waitedMs: d.now() - began };
      // "no output" is hcReason's placeholder for silence: not a reason, so leave the line to the exit code alone.
      const why = hcReason(r);
      statusWhy = why === "no output" ? undefined : why;
    } catch {
      statusCode = undefined;
      statusWhy = undefined;
    }
    const waited = d.now() - began;
    if (waited >= waitMs) {
      return {
        up: false,
        start,
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(statusWhy === undefined ? {} : { statusWhy }),
        waitedMs: waited,
      };
    }
    if (!start.tried) {
      // Still no core: run the explicit start once. hc may already have spawned one on demand, in which case this is a
      // no-op that answers with that same core.
      const attempted = await hcStart(d);
      start = attempted;
      log(attempted.ok
        ? "no hc core yet: started it with `hc server start`, waiting for it to answer..."
        : `no hc core yet, and \`hc server start\` failed (${attempted.why}); still waiting for a core to answer...`);
    } else if (!told) {
      told = true;
      log(`waiting for hc (herdr-core) to start; seori up opens nothing until the core answers...`);
    }
    await d.sleep(HC_POLL_MS);
  }
}

/** waitForHcResult's boolean form, for callers that only need whether the core came up. */
export async function waitForHc(d: Deps, waitMs: number = HC_WAIT_MS, log: (line: string) => void = console.error): Promise<boolean> {
  return (await waitForHcResult(d, waitMs, log)).up;
}

/**
 * The line a logon hook prints when no core answered: both things that were tried, so a user can tell a broken seori
 * from an hc that never started. Never names the unit of another home: the daemon and loops are this home's own.
 */
export function hcUnavailableLine(r: HcWaitResult): string {
  const mins = Math.round(r.waitedMs / 60_000);
  const waited = r.waitedMs >= 60_000 ? `${mins} min` : `${Math.round(r.waitedMs / 1000)} s`;
  // A code says how hc failed, not why: 5 is "no core" only when hc itself could run, and a mismatch or a core that
  // cannot start also exit 5. Quote hc's own words when it gave any, and never claim a reason hc did not give.
  const status = r.statusCode === undefined
    ? "`hc server status` could not run"
    : r.statusWhy === undefined
      ? `\`hc server status\` exited ${r.statusCode}`
      : `\`hc server status\` exited ${r.statusCode} (${r.statusWhy})`;
  // `tried: false` only reaches this line when the wait ended before its first start (a zero or tiny --wait-ms): saying
  // it "was not needed" would blame the core, so name the real reason.
  const start = !r.start.tried
    ? "`hc server start` was not attempted (the wait ended first)"
    : r.start.ok ? "`hc server start` succeeded" : `\`hc server start\` failed: ${r.start.why}`;
  return `HC UNAVAILABLE: waited ${waited} for the hc core to answer: ${status}, ${start}, still no answer; nothing opened. The daemon and loops are unaffected.`;
}

/** Held across a `seori up`'s check and open, so two ups of one home (the logon hook and a hand-typed one) never both open. */
export const upLockPath = (root: string): string => join(root, "run", "up.lock");

/**
 * `seori up`: healthy prints ALREADY UP, panes reopens what is missing, fresh opens everything. `waitHc` is the logon
 * path: it waits for hc to answer first, because after a reboot the core may still be starting or not yet started, and
 * says so instead of failing. While another up of this home holds the up lock, this one prints UP BUSY and opens
 * nothing: its check would see the other's half-opened set and add to it.
 */
export async function up(
  d: Deps, cwdFlag: string | undefined, opts: { waitHc?: boolean; waitMs?: number } = {}, out: (line: string) => void = console.log,
): Promise<void> {
  const name = loadConfig(d.store.root).name;
  const cwd = cwdFlag === undefined ? d.store.root : resolve(cwdFlag);
  if (opts.waitHc === true) {
    // The logon path: the hook runs this once, so a boot without a core is reported and exits 0, never retried in a loop.
    const waited = await waitForHcResult(d, opts.waitMs);
    if (!waited.up) {
      out(hcUnavailableLine(waited));
      return;
    }
  }
  const lock = upLockPath(d.store.root);
  mkdirSync(dirname(lock), { recursive: true });
  const release = lockFile(lock, d.now());
  if (release === undefined) {
    out(`UP BUSY name=${name} home=${d.store.root}: another seori up of this home is opening it (${lock}); nothing opened`);
    return;
  }
  try {
    const plan = await upCheck(d, name);
    if (plan.kind === "healthy") {
      out(alreadyUpLine(name, d.store.root, plan.lead, plan.runners));
      return;
    }
    await upHc(d, name, cwd, plan, out);
  } finally {
    release();
  }
}

const dutyLine = (e: DutyEvent): string => `DUTY ${[e.lane ?? e.pane, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`;

/**
 * One pass of the long-running duty loop. A live record left from herdr is skipped and named once per pass as a
 * `DUTY ERROR` line, so every hc lane is still supervised until that file is cleaned up (a herdr roles.json value
 * still refuses the parts that need the lead). Any other error still ends the loop.
 */
export async function dutyPass(d: Deps, out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<void> {
  const refused = new Set<string>();
  try {
    for (const e of await dutyTick({ ...d, store: d.store.skippingHerdr((r) => refused.add(r.message)) })) out(dutyLine(e));
  } catch (e) {
    if (!(e instanceof HerdrRecord)) throw e;
    refused.add(e.message);
  }
  for (const message of refused) err(`DUTY ERROR ${message}`);
}

/** This file, which the units' ExecStart runs with bun. */
const CLI_PATH = import.meta.path;

/** Whether the resident processes run as systemd --user units: Linux only; elsewhere (macOS) they run in terminals. */
export const usesSystemdUnits = (d: Deps): boolean => (d.platform ?? process.platform) === "linux";

/**
 * `seori up` on hc: the lead and duty agents in hc terminals labelled `seori.group=<name>`, recorded as roles; on Linux
 * the daemon, duty loop and hourly loop as systemd --user units (src/systemd.ts), enabled so they start after a boot; on
 * macOS, which has no systemd, they run in hc terminals of the same group (upHcTerminals). The agents start
 * in `cwd`, which defaults to $SEORI_HOME.
 *
 * `plan` decides how much of that happens: `fresh` does all of it, `panes` only reopens the panes it lists and touches
 * no unit (a home whose units are already running must not have them restarted, and must not print nothing opened
 * either: that left the owner with no lead until they ran down and up by hand).
 */
async function upHc(d: Deps, name: string, cwd: string, plan: UpPlan, out: (line: string) => void = console.log): Promise<void> {
  const rt = d.runtime;
  const env = paneEnv(d.store.root);
  const leadEnv = { SEORI_HOME: d.store.root, SEORI_CMD: d.seoriCmd, ...env, ...d.agent.leadEnv(d.store.root) };
  const panes = plan.kind === "fresh" ? (["lead", "duty"] as const) : plan.kind === "panes" ? plan.missing : [];
  const home = d.store.root;
  const ctl = systemctl();
  // The unit files are written first: one that cannot be written (a line break in a value, a unit of another home under
  // the same name) refuses the up before any terminal opens. They start only after lead and duty are up. A pane-only up
  // writes nothing: its units are running and are left exactly as they are.
  const units = plan.kind === "fresh" && usesSystemdUnits(d)
    ? writeUnits(unitDir(), { instance: name, home, cwd, bun: process.execPath, cli: CLI_PATH, env: process.env })
    : [];
  // Without a reachable user manager (WSL without systemd, a container, an SSH login without one) no unit could start:
  // refuse now, before the lead and duty open and are recorded, not after them.
  if (plan.kind === "fresh" && usesSystemdUnits(d)) {
    await ctl(["show-environment"]).catch((e: unknown) => {
      const why = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      throw new Refusal(
        `systemd --user is not reachable, and seori up on hc runs its daemon and loops as systemd --user units (${why}). ` +
          "On WSL set systemd=true under [boot] in /etc/wsl.conf and run wsl --shutdown; elsewhere start a user manager (loginctl enable-linger)",
      );
    });
  }
  const openLead = async (): Promise<SessionRef> => {
    const ref = await rt.create({ name, cwd, env: leadEnv, role: "lead", group: name, home });
    await startAgent(d, ref, ["-e", LEAD_EXTENSION, "--append-system-prompt", renderPrompt(d, "lead.md")]);
    d.store.setRole("lead", ref);
    return ref;
  };
  const openDuty = async (): Promise<SessionRef> => {
    const ref = await rt.create({ name: `${name}-duty`, cwd, env: { ...env, ...d.agent.agentEnv(d.store.root) }, role: "duty", group: name, home });
    await startAgent(d, ref, ["--append-system-prompt", renderPrompt(d, "duty.md")]);
    d.store.setRole("duty", ref);
    return ref;
  };
  // A pane the plan found live is kept as it is; only a missing one is opened (never a second lead).
  const livePanes = plan.kind === "panes" ? plan.live : {};
  const leadRef = panes.includes("lead") ? await openLead() : livePanes.lead;
  try {
    const dutyRef = panes.includes("duty") ? await openDuty() : livePanes.duty;
    if (plan.kind === "panes") {
      // Reopened panes only: the units and the other panes are running and were not touched.
      out(
        `REOPENED ${panes.join(",")} lead=${refText(leadRef!)} duty=${refText(dutyRef!)} ` +
          `running=${plan.runners.join(",") || "panes"} home=${home} name=${name}`,
      );
      return;
    }
    if (!usesSystemdUnits(d)) return await upHcTerminals(d, name, cwd, env, leadRef!, dutyRef!, out);
    const [daemonUnit, dutyUnit, hourlyUnit] = units;
    await ctl(["daemon-reload"]);
    const daemonStarted = d.now();
    await ctl(["enable", "--now", daemonUnit!]);
    // The duty loop reports a missing heartbeat as a daemon outage, so it starts once the daemon is up.
    const beat = await heartbeatSince(d.store.root, daemonStarted, {
      onSlow: () => console.error(`waiting for the messenger daemon (${daemonUnit}) to start (a first start can be slow)...`),
    });
    if (!beat) {
      console.error(`WARNING: the messenger daemon wrote no heartbeat within ${DAEMON_START_MS / 1000} s; check: systemctl --user status ${daemonUnit}`);
    }
    await ctl(["enable", "--now", dutyUnit!, hourlyUnit!]);
    out(
      `UP lead=${refText(leadRef!)} duty=${refText(dutyRef!)} units=${[daemonUnit, dutyUnit, hourlyUnit].join(",")} home=${home} name=${name}`,
    );
  } finally {
    // A fresh lead is the one the owner is waiting on: seed the boot-and-greet so it speaks first instead of sitting
    // silent until someone types "seori mode" (the boring option: the prompt says what to do, this makes it happen).
    // It goes out last, once duty is recorded and the daemon and loops run: a boot run any earlier reports the duty
    // pane as unregistered and the daemon as silent, and the lead tells the owner about a fault that is not there. An up
    // that fails after the lead opened still hands it the line, so its boot reports the faults that are there: the next
    // up finds the lead live and would never hand it over.
    if (panes.includes("lead")) {
      const warn = (why: string): void =>
        console.error(`seori: the new lead in ${refText(leadRef!)} did not take its start-up line (${why}); it still answers its messages`);
      try {
        if (!(await wakeNewLead(d, leadRef!))) warn("its agent was not ready for it");
      } catch (e) {
        // DeliveryUncertain: the line may be in the pane already, so it is not typed again.
        warn(e instanceof DeliveryUncertain ? `it may have arrived: ${e.message}` : e instanceof Error ? e.message : String(e));
      }
    }
  }
}
/**
 * The line a freshly opened lead gets, so it announces itself instead of waiting for the owner to find it: run the boot
 * check, then post one line to the owner (the open worklog item's thread, else the owner's direct message). The prompt
 * (prompts/lead.md, "When this pane is new") says the same; this is what makes it happen on a start nobody typed into.
 */
export const LEAD_START_LINE =
  "[START] This is a new lead pane: run `seori boot`, then post ONE short line to the owner (the thread of the oldest " +
  "open worklog item, else the owner's direct message with `seori msg send --to`): that seori is back, with the open " +
  "item count and the lanes still open. Nothing else until a message arrives.";

/**
 * Delivers LEAD_START_LINE to a new lead. True when it was delivered, false when the agent never took it (the caller
 * warns, never blocks the up). Only a delivery that typed nothing is tried again: a DeliveryUncertain (the line may be
 * in the pane already) is thrown, since a retry could hand the lead [START] twice.
 */
export async function wakeNewLead(d: Deps, ref: SessionRef, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await deliverOrThrow(d.runtime, ref, LEAD_START_LINE, { when: "idle" })) return true;
    if (i + 1 < attempts) await d.sleep(LEAD_START_WAIT_MS);
  }
  return false;
}

/** How long between tries to hand a new lead its start-up line (omp may still be painting its prompt). */
export const LEAD_START_WAIT_MS = 1_000;

/**
 * The resident processes in hc terminals of the home's group (macOS): `seori daemon-loop`, `seori duty --interval 60`
 * and `seori loop`, each recorded in $SEORI_HOME/run/ so `seori down` stops it; `seori down` (all) closes the terminals.
 */
async function upHcTerminals(
  d: Deps, name: string, cwd: string, env: Record<string, string>, leadRef: SessionRef, dutyRef: SessionRef, out: (line: string) => void = console.log,
): Promise<void> {
  const rt = d.runtime;
  const open = (role: "duty-loop" | "hourly-loop" | "daemon") => rt.create({ name: `${name}-${role}`, cwd, env, role, group: name, home: d.store.root });
  const loopRef = await open("duty-loop");
  const hourlyRef = await open("hourly-loop");
  const daemonRef = await open("daemon");
  const daemonStarted = d.now();
  await rt.start(daemonRef, `${d.seoriCmd} daemon-loop`);
  // The duty loop reports a missing heartbeat as a daemon outage, so it starts once the daemon is up.
  const beat = await heartbeatSince(d.store.root, daemonStarted, {
    onSlow: () => console.error(`waiting for the messenger daemon in ${refText(daemonRef)} to start (a first start can be slow)...`),
  });
  if (!beat) {
    console.error(`WARNING: the messenger daemon in ${refText(daemonRef)} wrote no heartbeat within ${DAEMON_START_MS / 1000} s; check that terminal`);
  }
  await rt.start(loopRef, `${d.seoriCmd} duty --interval 60`);
  await rt.start(hourlyRef, `${d.seoriCmd} loop`);
  out(
    `UP lead=${refText(leadRef)} duty=${refText(dutyRef)} loop=${refText(loopRef)} hourly=${refText(hourlyRef)} daemon=${refText(daemonRef)} home=${d.store.root} name=${name}`,
  );
}

/** Which units `seori down <group>` stops: `loop` is the hourly loop, `daemon` the daemon (its restart loop included). */
const DOWN_UNITS: Readonly<Record<string, readonly UnitSpecKind[]>> = {
  duty: ["duty"],
  loop: ["hourly"],
  daemon: ["daemon"],
  // The logon hook goes only with `all`: it is not one of the resident processes, so a partial down leaves it alone, and
  // `all --keep-autostart` (a restart's down) keeps it too.
  all: ["daemon", "duty", "hourly", BOOT_KIND],
};

/**
 * `seori down`: each process is asked to stop first (it ends cleanly, which its unit does not restart), then the
 * home's units of that group are stopped, disabled and removed. `all` on hc also closes this home's terminals
 * (homeTerminals: lead, duty and lanes), the caller's own terminal last, or, with keepSelf, not at all: it is left for
 * the owner to close. keepAutostart leaves the logon hook installed (`seori restart` is not an uninstall). ok is false
 * when a process outlived the wait.
 */
async function downHome(
  d: Deps, which: string, opts: { keepSelf?: boolean; keepAutostart?: boolean } = {},
): Promise<{ lines: string[]; ok: boolean }> {
  const r = await down(d.store.root, DOWN_GROUPS[which]!);
  const name = (() => {
    try {
      return loadConfig(d.store.root).name;
    } catch {
      return undefined; // a broken config.json must not stop a down
    }
  })();
  if (name === undefined) return r;
  // No systemd off Linux: there `seori up` wrote no units, and the processes stopped above are all there is.
  const kinds = DOWN_UNITS[which]!.filter((kind) => !(opts.keepAutostart && kind === BOOT_KIND));
  const lines = usesSystemdUnits(d) ? [...r.lines, ...(await removeUnits(unitDir(), name, d.store.root, kinds, systemctl()))] : [...r.lines];
  if (which === "all") {
    const rt = d.runtime;
    const self = process.env["HC_TERMINAL_ID"];
    const open = (await homeTerminals(d, name)).sort((a, b) => Number(a.id === self) - Number(b.id === self));
    for (const ref of open) {
      if (opts.keepSelf && ref.id === self) {
        lines.push(`LEFT ${refText(ref)} open: this command runs in it; close this terminal by hand`);
        continue;
      }
      lines.push(`CLOSED ${refText(ref)} (seori.group=${name})`);
      if (ref.id === self) {
        console.log(lines.splice(0).join("\n")); // closing this terminal ends this command: print what it did first
      }
      await rt.close(ref);
    }
  }
  return { lines, ok: r.ok };
}

/**
 * This home's live hc terminals in seori.group=<name>: those labelled with its seori.home, plus unlabelled ones (opened
 * before that label existed) that its store records as its lead, duty or a lane (a done lane's terminal may still be open). A terminal labelled for another
 * home is never closed, even when a stale record names its id (hc ids start over after a core restart).
 */
async function homeTerminals(d: Deps, name: string): Promise<SessionRef[]> {
  const mine = homeTag(d.store.root);
  const recorded = new Set(
    [...Object.values(d.store.roles()), ...d.store.lanes().map((l) => l.sessionRef)]
      .filter((r): r is SessionRef => r !== undefined && r.runtime === "hc")
      .map((r) => r.id),
  );
  return (await d.runtime.list({ group: name, homes: true }))
    .filter((s) => s.home === mine || (s.home === undefined && recorded.has(s.ref.id)))
    .map((s) => s.ref);
}
/**
 * `seori restart [--force]`: down then up, safe from inside the lead or duty pane. The work runs in a detached child
 * (src/restart.ts), because `down all` closes the caller's pane and would otherwise kill the restart itself. This
 * process only starts that child and prints where it reports; the new lead and duty refs land in the log.
 *
 * Every lane with a pane of its own is closed by it, and each is named with the command that brings it back, here and in
 * the log. A working or waiting lane still owed work refuses the restart unless `--force` is given, and is then named as
 * ENDED; a ready or paused lane never blocks it.
 * Without --cwd the agents come back where the home's units run (the cwd its last up or autostart install was given),
 * else in $SEORI_HOME, as `seori up` would open them.
 */
export type RestartDeps = {
  /** Starts one detach way and resolves with its immediate exit code (0: the worker started). */
  readonly spawn?: (argv: readonly string[], cwd: string) => Promise<number>;
  /** Whether a command is on PATH (setsid, systemd-run, nohup). */
  readonly has?: (bin: string) => boolean;
};

export async function restart(
  d: Deps, cwdFlag: string | undefined, force: boolean, out: (line: string) => void = console.log, deps: RestartDeps = {},
): Promise<number> {
  const home = d.store.root;
  const unitsCwd = usesSystemdUnits(d) ? unitCwd(unitDir(), loadConfig(home).name, home) : undefined;
  const cwd = cwdFlag === undefined ? (unitsCwd ?? home) : resolve(cwdFlag);
  const log = restartLogPath(home);
  const closed = lanesARestartCloses(d.store.lanes());
  if (!force && closed.some(endsWork)) throw new Refusal(lanesRefusal(closed));
  // One worker per home: a second would down the first's half-opened set (and the worker refuses itself as well).
  const worker = runningRestart(home);
  if (worker !== undefined) throw new Refusal(`a restart of this home is already running (pid ${worker}); its steps are in ${log}`);
  const notes = closed.map((lane) => closedLaneLine(lane, d.seoriCmd));
  const script = restartScript({ home, cwd, seoriCmd: d.seoriCmd, log, notes });
  const ways = detachWays(script, deps.has ?? ((bin) => Bun.which(bin) !== null), `seori-restart-${homeTag(home)}`, process.env);
  if (ways.length === 0) throw new Refusal(noDetachRefusal());
  const spawn = deps.spawn ?? (async (a: readonly string[], at: string) => {
    const child = Bun.spawn([...a], { env: process.env, stdio: ["ignore", "ignore", "ignore"], cwd: at });
    return child.exited;
  });
  // A detached worker reports through its own log, not this exit code: setsid --fork's intermediate and a `&` both exit
  // 0 the moment the work starts. A non-zero exit started nothing (a setsid without --fork, no user manager for
  // systemd-run), so the next way is tried.
  const failed: string[] = [];
  for (const way of ways) {
    const code = await spawn(way.argv, home);
    if (code === 0) break;
    failed.push(`${way.via} exit ${code}`);
  }
  if (failed.length === ways.length) {
    out(`RESTART_FAILED could not detach the relaunch (${failed.join(", ")}); nothing was stopped. See ${log}`);
    return 1;
  }
  for (const note of notes) out(note);
  out(
    `RESTARTING detached; this pane is closed by the down. ` +
      `The new refs and every step land in ${log} (seori restart --follow prints them as they come)`,
  );
  return 0;
}

/** `seori restart --follow`: the same detached restart, then the log until the child logs its exit code. */
export async function followRestartLog(
  log: string,
  from: number,
  out: (line: string) => void,
  sleep: (ms: number) => Promise<void>,
  waitMs = RESTART_FOLLOW_MS,
  // The clock the deadline is measured by, so a test can drive it with its own sleep (as heartbeatSince does).
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + waitMs;
  let seen = from;
  // A poll can land mid-line (a long UP line, or RESTART_EXIT itself half written): only complete lines are printed and
  // matched, and the remainder is kept for the next read. Without this, an exit line split across two polls is never
  // seen and a successful restart reports RESTART_UNFINISHED when the wait runs out.
  let partial = "";
  for (;;) {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    const chunk = partial + text.slice(seen);
    seen = text.length;
    const cut = chunk.lastIndexOf("\n");
    const complete = cut < 0 ? "" : chunk.slice(0, cut);
    partial = cut < 0 ? chunk : chunk.slice(cut + 1);
    for (const line of complete.split("\n").filter(Boolean)) out(line);
    const exit = /^RESTART_EXIT=(\d+)$/m.exec(complete);
    if (exit) return exit[1] === "0";
    if (now() >= deadline) {
      // A log that ends without a final newline still carries its verdict: read the tail before giving up on it.
      const tail = /^RESTART_EXIT=(\d+)$/m.exec(partial);
      if (tail) return tail[1] === "0";
      out(`RESTART_UNFINISHED nothing conclusive in ${log} after ${Math.round(waitMs / 1000)} s; check it there`);
      return false;
    }
    await sleep(RESTART_FOLLOW_POLL_MS);
  }
}


/** How long `seori restart --follow` watches the log before it gives up. */
export const RESTART_FOLLOW_MS = 180_000;
const RESTART_FOLLOW_POLL_MS = 500;

/**
 * `seori autostart install`: the logon hook's unit (Linux), enabled but not started. Returns its name. Without --cwd the
 * hook opens the agents where this home's units already run (as a restart does), else in $SEORI_HOME.
 */
async function autostartInstall(d: Deps, cwdFlag: string | undefined, out: (line: string) => void = console.log): Promise<string> {
  const name = loadConfig(d.store.root).name;
  if (!usesSystemdUnits(d)) {
    throw new Refusal(
      "seori autostart install writes a systemd --user unit, and this host has no systemd: on macOS add " +
        `\`${d.seoriCmd} up --wait-hc\` to a login item instead`,
    );
  }
  const cwd = cwdFlag === undefined ? (unitCwd(unitDir(), name, d.store.root) ?? d.store.root) : resolve(cwdFlag);
  const ctl = systemctl();
  await ctl(["show-environment"]).catch((e: unknown) => {
    const why = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    throw new Refusal(
      `systemd --user is not reachable, so the logon hook could not be enabled (${why}). ` +
        "On WSL set systemd=true under [boot] in /etc/wsl.conf and run wsl --shutdown; elsewhere start a user manager (loginctl enable-linger)",
    );
  });
  const unit = await installBootUnit(unitDir(), { instance: name, home: d.store.root, cwd, bun: process.execPath, cli: CLI_PATH, env: process.env }, ctl);
  out(
    `AUTOSTART ${unit} enabled in ${unitDir()}: it runs \`seori up --wait-hc\` once at logon, so the lead and duty panes ` +
      `come back by themselves. seori down all removes it; seori autostart status shows it`,
  );
  return unit;
}

/** `seori autostart status`: whether this home's logon hook is installed, and where. */
function autostartStatus(d: Deps, out: (line: string) => void = console.log): void {
  const name = loadConfig(d.store.root).name;
  if (!usesSystemdUnits(d)) {
    out(`AUTOSTART none on this host (no systemd): on macOS add \`${d.seoriCmd} up --wait-hc\` to a login item`);
    return;
  }
  const unit = bootUnitInstalled(unitDir(), name, d.store.root);
  out(unit === undefined
    ? `AUTOSTART not installed: run \`${d.seoriCmd} autostart install\` to have the lead and duty panes come back at logon`
    : `AUTOSTART ${unit} in ${unitDir()} (install: \`${d.seoriCmd} autostart install\`; remove: \`${d.seoriCmd} down all\`)`);
}

/**
 * How long `seori up` waits for the daemon's first heartbeat. Measured from `pane run` to the first
 * heartbeat: about 4 s idle and up to 8.5 s while the lead and duty omp start; a first start after a reboot took over
 * 15 s. A slow start is told once after DAEMON_SLOW_MS so `up` does not look hung.
 */
export const DAEMON_START_MS = 60_000;
export const DAEMON_SLOW_MS = 15_000;

export type HeartbeatWait = {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onSlow?: () => void;
};

/**
 * Polls the daemon heartbeat until one written at or after `since` appears. Gives up DAEMON_START_MS after it began by
 * the clock, not by counting sleeps, so slow reads on a loaded host do not stretch the wait.
 */
export async function heartbeatSince(root: string, since: number, w: HeartbeatWait = {}): Promise<boolean> {
  const now = w.now ?? Date.now;
  const sleep = w.sleep ?? ((ms: number) => Bun.sleep(ms));
  const start = now();
  let told = false;
  for (;;) {
    let beat: unknown;
    try {
      beat = JSON.parse(readFileSync(heartbeatPath(root), "utf8"));
    } catch {
      // not written yet
    }
    if (beat && typeof beat === "object" && "at" in beat && typeof beat.at === "number" && beat.at >= since) return true;
    const waited = now() - start;
    if (waited >= DAEMON_START_MS) return false;
    if (!told && waited >= DAEMON_SLOW_MS) {
      told = true;
      w.onSlow?.();
    }
    await sleep(200);
  }
}

/**
 * Runs the daemon until SIGINT, SIGTERM or SIGHUP, then stops it cleanly (watch commands killed, lock released,
 * heartbeat stopped) and re-raises the signal. The shell running `seori up`'s restart loop sees 130 (Ctrl-C) or 143
 * (kill) and stops the loop too, so a deliberate stop is not undone. SIGHUP (129) is handled for the closed-pane case,
 * where skipping the cleanup would leave each command watch's process group running (they run in their own session)
 * for the next daemon to duplicate; a SIGHUP sent while the loop lives restarts the daemon, like a crash. Returns 0
 * when messengers.json changed, which the loop restarts.
 */
async function daemon(root: string): Promise<number> {
  const stop = new AbortController();
  let caught: NodeJS.Signals | undefined;
  // A `seori down` request ends it like a SIGTERM (143), which its restart loop treats as a deliberate stop.
  const me = running(root, "daemon");
  me.stopped.addEventListener("abort", () => {
    caught ??= "SIGTERM";
    stop.abort();
  });
  const onSignal = (sig: NodeJS.Signals) => {
    caught = sig;
    stop.abort();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const s of signals) process.on(s, onSignal);
  try {
    await runDaemon(root, { signal: stop.signal });
  } finally {
    for (const s of signals) process.off(s, onSignal);
    me.release();
  }
  if (!caught) return 0;
  if (me.stopped.aborted) return 128 + osConstants.signals.SIGTERM;
  process.kill(process.pid, caught);
  // If the re-raised signal is not delivered before main exits, the shell convention still reports it: 128 + number.
  return 128 + osConstants.signals[caught];
}

/** `seori start --workflow`: a known workflow, or none for stock omp goal mode whatever config.json says. */
function workflowFlag(v: string): Workflow | null {
  if (v === "none") return null;
  if (!isWorkflow(v)) throw new Refusal(`--workflow must be ${WORKFLOWS.join(", ")} or none, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * Flags each `seori msg` subcommand accepts. The general parser reads every other `--name` as a value flag, which is
 * right for relayed values (`--text "$MSG"`) but would let a stale or mistyped flag swallow the argument after it:
 * `msg send --now --text 'hi'` used to take `--text` as the value of `--now` and then report an empty message. A flag
 * outside its subcommand's list is refused by name instead.
 */
const MSG_FLAGS: Readonly<Record<string, readonly string[]>> = {
  send: ["reply-to", "to", "text", "again"],
  close: ["why"],
  list: ["all"],
  check: [],
  pair: ["minutes", "write", "all", "force"],
  edit: ["reply-of", "to", "message", "text"],
};

/** Refuses flags a `seori msg` subcommand does not take, so no argument is silently read as their value. */
function checkMsgFlags(a: Args, sub: string | undefined): void {
  const allowed = MSG_FLAGS[sub ?? ""];
  if (allowed === undefined) return; // an unknown subcommand is refused below, with the usage text
  for (const name of a.flags.keys()) {
    if (!allowed.includes(name)) throw new Refusal(`unknown flag --${name} for seori msg ${sub}\n\n${USAGE}`);
  }
}

async function msg(d: Deps, a: Args, sub: string | undefined): Promise<number> {
  const root = d.store.root;
  checkMsgFlags(a, sub);
  if (sub === "send") {
    const replyTo = a.flags.get("reply-to")?.flatMap((v) => v.split(",")).map((id) => id.trim()).filter(Boolean);
    const to = one(a, "to");
    const r = await msgSend(root, {
      ...(replyTo ? { replyTo } : {}),
      ...(to !== undefined ? { to: parseTo(to) } : {}),
      text: await textOf(a),
      again: one(a, "again") === "true",
    }, msgDepsFor(root, d.now));
    const what = r.ids.length ? r.ids.join(",") : to!;
    if (r.status === "SENT") {
      console.log(`SENT ${what} message=${r.messageId}`);
      return 0;
    }
    console.log(r.ids.length
      ? `HELD ${what}: the messenger may or may not have the reply; check the chat, then resend with --again`
      : `HELD ${what}: the messenger may or may not have the notice; check the chat before sending it again`);
    return 3;
  }
  if (sub === "close") {
    const id = need(a.pos[2], "message id");
    msgClose(root, id, need(one(a, "why"), "--why"), d.now());
    console.log(`CLOSED ${id}`);
    return 0;
  }
  if (sub === "list") {
    const lines = msgList(root, { all: one(a, "all") === "true" }, d.now());
    console.log(lines.length ? lines.join("\n") : "EMPTY");
    return 0;
  }
  if (sub === "check") {
    // `msg check <source>` works before pairing too, when messengers.json has no entry for it yet: only the token matters.
    const only = a.pos[2];
    const configured = loadMessengers(root);
    const configs = only === undefined ? configured : [configured.find((c) => c.source === only) ?? { source: only, owner: "" }];
    if (configs.length === 0) throw new Refusal(`no messengers configured in ${root}/messengers.json (or name one: seori msg check telegram)`);
    let failed = 0;
    for (const c of configs) {
      try {
        console.log(`OK ${c.source}: ${await adapterFor(c, root).check()}`);
      } catch (e) {
        failed++;
        console.log(`FAIL ${c.source}: ${(e as Error).message}`);
      }
    }
    return failed ? 1 : 0;
  }
  if (sub === "pair") {
    const source = need(a.pos[2], "source (telegram, slack or discord)");
    const minutes = one(a, "minutes");
    const write = one(a, "write") === "true";
    const stop = new AbortController();
    const onInt = () => stop.abort();
    process.once("SIGINT", onInt);
    console.log(`PAIRING ${source}: send the bot any direct message now (waiting up to ${minutes ?? DEFAULT_PAIR_MINUTES} min)`);
    try {
      const found = await pairOwner(root, source, {
        ...(minutes !== undefined ? { minutes: Number(minutes) } : {}),
        write,
        all: one(a, "all") === "true",
        force: one(a, "force") === "true",
      }, { now: d.now, onCandidate: (c) => console.log(candidateLine(c)), signal: stop.signal });
      if (write && found[0]) console.log(pairedLine(root, source, found[0].id));
      return found.length ? 0 : 1;
    } finally {
      process.off("SIGINT", onInt);
    }
  }
  if (sub === "edit") return msgEditCommand(root, d, a);
  throw new Refusal(`unknown msg command ${sub}\n\n${USAGE}`);
}

/** `seori msg edit`: EDITED with the message id, or FAILED and exit 1. */
async function msgEditCommand(root: string, d: Deps, a: Args): Promise<number> {
  const deps = msgDepsFor(root, d.now);
  const replyOf = one(a, "reply-of");
  if ((replyOf === undefined) === (one(a, "to") === undefined)) throw new Refusal("give exactly one of --reply-of ID or --to SOURCE:CHAT[:THREAD] (with --message MID)");
  const text = await textOf(a);
  let what: string;
  let act: () => Promise<string>;
  if (replyOf !== undefined) {
    what = replyOf;
    act = () => msgEditReplyOf(root, replyOf, text, deps);
  } else {
    const to = parseTo(need(one(a, "to"), "--to"));
    const message = need(one(a, "message"), "--message");
    what = need(one(a, "to"), "--to");
    act = async () => {
      await msgEdit(to, message, text, deps);
      return message;
    };
  }
  let message: string;
  try {
    message = await act();
  } catch (e) {
    if (e instanceof Refusal) throw e;
    console.log(`FAILED edit ${what}: ${redact((e as Error)?.message ?? String(e))}`);
    return 1;
  }
  console.log(`EDITED ${what} message=${message}`);
  return 0;
}

async function watch(d: Deps, a: Args, sub: string | undefined): Promise<number> {
  const root = d.store.root;
  if (sub === "add") {
    const w = watchAdd(root, {
      command: one(a, "command"), filter: one(a, "filter"), cwd: one(a, "cwd"), file: one(a, "file"), checks: one(a, "checks"),
      pane: one(a, "pane"), status: one(a, "status"), name: one(a, "name"), persistent: one(a, "persistent") === "true",
      timeout: one(a, "timeout"), for: one(a, "for"),
    }, process.env, d.now());
    console.log(`WATCH ${w.id} ${w.name} for ${ownerText(w.owner)} until ${new Date(w.expiresAt).toISOString()}`);
    return 0;
  }
  if (sub === "list") {
    const lines = watchList(root, { all: one(a, "all") === "true" }, d.now());
    console.log(lines.length ? lines.join("\n") : "EMPTY");
    return 0;
  }
  // stop, rearm and log find a name among the caller's watches (owner as for add); an id works for any owner.
  const forFlag = one(a, "for");
  const caller = { ...(forFlag !== undefined ? { for: forFlag } : {}), env: process.env };
  if (sub === "stop") {
    const w = watchStop(root, need(a.pos[2], "watch id or name"), caller, d.now());
    console.log(`STOPPED ${w.id} ${w.name}`);
    return 0;
  }
  if (sub === "rearm") {
    const { watch: w, missed } = watchRearm(root, need(a.pos[2], "watch id or name"), caller, d.now());
    console.log(`REARMED ${w.id} ${w.name}: ${missed} event(s) missed while muted; wake budget reset`);
    return 0;
  }
  if (sub === "log") {
    // -n is the one short flag: parse() only knows --flags, so it arrives as a positional pair.
    const at = a.pos.indexOf("-n");
    const n = at >= 0 ? Number(a.pos[at + 1]) : 20;
    if (!(Number.isInteger(n) && n > 0)) throw new Refusal("-n takes a whole number > 0");
    const lines = watchLog(root, need(a.pos[2] === "-n" ? a.pos[4] : a.pos[2], "watch id or name"), caller, n);
    console.log(lines.length ? lines.join("\n") : "EMPTY");
    return 0;
  }
  throw new Refusal(`unknown watch command ${sub}\n\n${USAGE}`);
}

function status(d: Deps): void {
  const roles = d.store.roles();
  console.log(`lead=${roles.lead ? refText(roles.lead) : "-"} duty=${roles.duty ? refText(roles.duty) : "-"} home=${d.store.root}`);
  for (const l of d.store.lanes()) {
    const last = l.log.at(-1);
    const age = Math.round((d.now() - l.lastActivityAt) / 60_000);
    console.log(`${l.key.padEnd(24)} ${l.status.padEnd(8)} ${refText(l.sessionRef).padEnd(8)} active ${age}m ago  ${last ? `${last.kind}: ${last.text.slice(0, 60)}` : ""}`);
  }
}

/** A lane key that has a lane record (open or closed): checkpoints and lessons belong to a lane seori knows. */
function laneKey(d: Deps, key: string): string {
  if (!d.store.lane(key)) throw new Refusal(`no lane ${key}`);
  return key;
}

/**
 * The open lane whose session is the caller's (HC_TERMINAL_ID), if any. A global lesson reaches every
 * future brief, so it is the lead's: this stops a lane from adding or reviving one by accident or on routine
 * instruction. It is a convenience check, not a security boundary: it reads only the env, and a direct write to
 * lessons.jsonl skips the CLI.
 */
function callerLane(d: Deps): Lane | undefined {
  const self = d.runtime.self();
  return self === undefined ? undefined : d.store.laneBySession(self);
}

function lesson(d: Deps, a: Args, sub: string | undefined): number {
  const root = d.store.root;
  if (sub === "add" && one(a, "global") === "true") {
    if (a.pos[2] !== undefined) throw new Refusal("a --global lesson is the lead's: give no lane key");
    if (one(a, "cwd") !== undefined) throw new Refusal("a --global lesson has no --cwd");
    const caller = callerLane(d);
    if (caller) throw new Refusal(`a --global lesson is the lead's; this terminal is lane ${caller.key}`);
    console.log(formatLessonAdded(addLesson(root, {
      global: true, rule: need(one(a, "rule"), "--rule"), evidence: need(one(a, "evidence"), "--evidence"),
    }, d.now())));
    return 0;
  }
  if (sub === "add") {
    const key = a.pos[2];
    const cwd = one(a, "cwd");
    if ((key === undefined) === (cwd === undefined)) throw new Refusal("lesson add takes a lane key or --cwd DIR (one of them)");
    const lane = key === undefined ? undefined : d.store.lane(key);
    if (key !== undefined && !lane) throw new Refusal(`no lane ${key}`);
    const l = addLesson(root, {
      cwd: lane?.cwd ?? resolve(cwd!),
      rule: need(one(a, "rule"), "--rule"),
      evidence: need(one(a, "evidence"), "--evidence"),
      ...(key !== undefined ? { lane: key } : {}),
    }, d.now());
    console.log(formatLessonAdded(l));
    return 0;
  }
  if (sub === "list") {
    const cwd = one(a, "cwd");
    console.log(formatLessons(listLessons(root, cwd === undefined ? undefined : resolve(cwd))).join("\n"));
    return 0;
  }
  if (sub === "mark") {
    const outcome = need(one(a, "outcome"), "--outcome");
    if (!isLessonMark(outcome)) throw new Refusal("--outcome must be helped, no-effect, harmful or encoded");
    const id = need(a.pos[2], "lesson id");
    // Marking a global lesson helped would put it back into every brief, so a lane cannot mark one.
    if (listLessons(root).lessons.find((l) => l.id === id)?.scope === "global") {
      const caller = callerLane(d);
      if (caller) throw new Refusal(`a global lesson is the lead's to mark; this terminal is lane ${caller.key}`);
    }
    console.log(formatLessonMarked(markLesson(root, id, outcome, d.now())));
    return 0;
  }
  throw new Refusal(`unknown lesson command ${sub}\n\n${USAGE}`);
}

export async function main(argv: readonly string[], d: Deps = defaultDeps()): Promise<number> {
  const a = parse(argv);
  // --help is a boolean flag, so the word after it is the command: print the usage instead of running it.
  if (a.flags.has("help")) {
    console.log(USAGE);
    return 0;
  }
  // seori runs omp only: a SEORI_AGENT or config.json "agent" naming anything else, or a SEORI_AGENT_CMD that is not
  // omp, refuses every command (exit 2).
  void d.agent;
  void d.agentCmd;
  const [cmd, x] = a.pos;
  switch (cmd) {
    case "up": {
      const waitMs = one(a, "wait-ms") === undefined ? undefined : Number(one(a, "wait-ms"));
      if (waitMs !== undefined && !(Number.isFinite(waitMs) && waitMs >= 0)) throw new Refusal("--wait-ms takes a nonnegative number of milliseconds");
      await up(d, one(a, "cwd"), { waitHc: one(a, "wait-hc") === "true", ...(waitMs === undefined ? {} : { waitMs }) });
      return 0;
    }
    case "restart": {
      const log = restartLogPath(d.store.root);
      const from = existsSync(log) ? readFileSync(log, "utf8").length : 0;
      const code = await restart(d, one(a, "cwd"), one(a, "force") === "true");
      if (code !== 0 || one(a, "follow") !== "true") return code;
      // d.sleep and d.now are one clock: a test that drives one drives the other, so the deadline is never real time.
      return (await followRestartLog(log, from, console.log, d.sleep, RESTART_FOLLOW_MS, d.now)) ? 0 : 1;
    }
    case "autostart": {
      if (x === "install") {
        await autostartInstall(d, one(a, "cwd"));
        return 0;
      }
      if (x === undefined || x === "status") {
        autostartStatus(d);
        return 0;
      }
      throw new Refusal(`unknown autostart command ${x} (install, status)\n\n${USAGE}`);
    }
    case "role": {
      const role = need(x, "role") as Role;
      if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
      const given = a.pos[2];
      const ref = given === undefined ? d.runtime.self() : parseRef(given);
      if (given !== undefined && ref === undefined) throw new Refusal(`${given} is not a session ref (hc:t7)`);
      if (ref === undefined) throw new Refusal(`missing session ref (not inside an hc terminal?)\n\n${USAGE}`);
      d.store.setRole(role, ref);
      console.log(`ROLE ${role}=${refText(ref)}`);
      return 0;
    }
    case "start": {
      const key = need(x, "lane key");
      const config = loadConfig(d.store.root);
      if (one(a, "force") !== "true") {
        const room = await canLaunch(d, config);
        if (!room.ok) {
          console.log(`${canLaunchLine(room)}\nlane ${key} not started; queue it (seori backlog add) or pass --force`);
          return 4;
        }
      }
      const ceilingFlag = (flag: string, fallback: number | null): number | null => {
        const v = one(a, flag);
        if (v === undefined) return fallback;
        if (v === "none") return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new Refusal(`--${flag} takes a nonnegative number or none`);
        return n;
      };
      const defaults = config.supervision.defaults;
      const anyCeiling = ["wall-minutes", "token-limit", "cost-limit"].some((f) => one(a, f) !== undefined);
      const { startup } = await launchLane(d, key, need(one(a, "brief"), "--brief"), {
        cwd: one(a, "cwd"),
        ...(one(a, "done") !== undefined ? { done: one(a, "done")! } : {}),
        ...(one(a, "thread") !== undefined ? { thread: one(a, "thread")! } : {}),
        ...(a.flags.has("activity-path") ? { activityPaths: a.flags.get("activity-path")! } : {}),
        ...(one(a, "model") !== undefined ? { model: one(a, "model")! } : {}),
        ...(one(a, "workflow") !== undefined ? { workflow: workflowFlag(one(a, "workflow")!) } : {}),
        ...(anyCeiling ? {
          ceilings: {
            wallMinutes: ceilingFlag("wall-minutes", defaults.wallMinutes),
            tokens: ceilingFlag("token-limit", defaults.tokens),
            costUsd: ceilingFlag("cost-limit", defaults.costUsd),
          },
        } : {}),
      }, config.startupWaitSeconds, (lane) => console.log(`STARTED ${lane.key} pane=${refText(lane.sessionRef)} brief=${lane.brief}`));
      console.log(startup);
      return startupExit(startup);
    }
    case "adopt": {
      const lane = await adoptLane(d, need(x, "lane key"), need(one(a, "ref"), "--ref"), { brief: one(a, "brief"), cwd: one(a, "cwd") });
      console.log(`ADOPTED ${lane.key} pane=${refText(lane.sessionRef)} brief=${lane.brief}`);
      return 0;
    }
    case "sync": {
      console.log((await syncRegistry(d, one(a, "write") === "true")).lines.join("\n"));
      return 0;
    }
    case "transcribe": {
      const file = need(x, "audio file");
      if (!existsSync(file)) throw new Refusal(`audio file not found: ${file}`);
      try {
        console.log(await transcribe(d.exec, loadHooks(d.store.root).transcribe, file));
      } catch (e) {
        if (e instanceof TranscriptionError) throw new Refusal(e.message);
        throw e;
      }
      return 0;
    }
    case "report": {
      const st = one(a, "status");
      if (st && st !== "working" && st !== "waiting") throw new Refusal("--status must be working or waiting");
      const sent = await report(d, need(x, "lane key"), await textOf(a), st as "working" | "waiting" | undefined);
      console.log(`REPORTED ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "ready": {
      const sent = await ready(d, need(x, "lane key"), await textOf(a), a.flags.get("evidence") ?? []);
      console.log(`READY ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "send": {
      const target = need(x, "target");
      const deliver = one(a, "to-shell") === "true" ? sendToShell : send;
      const sent = await deliver(d, target, await textOf(a), one(a, "from") ?? process.env["SEORI_LANE"] ?? "cli");
      if (sent === "DELIVERED") console.log(`DELIVERED ${target}`);
      return deliveryOutcome(sent, target);
    }
    case "inbox": {
      const target = need(a.pos[2], "target");
      if (x === "list") {
        const { to, entries } = inboxList(d, target);
        if (entries.length === 0) console.log(`EMPTY ${refText(to)}`);
        for (const e of entries) console.log(`${e.index} ${e.state} from ${e.from} queued ${new Date(e.at).toISOString()} ${e.preview}`);
        return 0;
      }
      if (x === "ack" || x === "resend") {
        const index = Number(need(a.pos[3], "entry index (see seori inbox list)"));
        const paneId = releaseHeld(d, target, index, x);
        console.log(x === "ack" ? `ACKED ${paneId} ${index}` : `RELEASED ${paneId} ${index}: the next flush delivers it`);
        return 0;
      }
      throw new Refusal(`unknown inbox command ${x}\n\n${USAGE}`);
    }
    case "duty": {
      if (x === "stop") {
        d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand", "duty");
        console.log("DUTY STOPPED");
        return 0;
      }
      if (x === "resume") {
        d.store.clearStop("duty");
        console.log("DUTY RESUMED");
        return 0;
      }
      if (x === "status") {
        const stop = d.store.stop("duty");
        console.log(stop ? `stopped: ${stop.reason}` : "running (no stop file)");
        return 0;
      }
      if (x !== undefined) throw new Refusal(`unknown duty command ${x}\n\n${USAGE}`);
      const interval = Number(one(a, "interval") ?? "60") * 1000;
      // Bun.sleep(NaN) and any Bun.sleep under 1 ms return at once, so a bad value would run duty passes back to back.
      if (!(Number.isFinite(interval) && interval >= 1)) throw new Refusal("--interval must be a number of seconds, 0.001 or more");
      if (one(a, "once")) {
        await dutyPass(d);
        return 0;
      }
      const me = running(d.store.root, "duty");
      try {
        while (!me.stopped.aborted) {
          await dutyPass(d);
          await sleepUnless(interval, me.stopped);
        }
      } finally {
        me.release();
      }
      console.log("DUTY ended by seori down");
      return 0;
    }
    case "loop": {
      if (x === "stop") {
        d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand");
        console.log("LOOP STOPPED");
        return 0;
      }
      if (x === "resume") {
        d.store.clearStop();
        console.log("LOOP RESUMED");
        return 0;
      }
      if (x === "status") {
        const stop = d.store.stop();
        const last = d.store.lastRun();
        const age = last ? Math.round((d.now() - last.at) / 60_000) : undefined;
        console.log(
          stop
            ? `stopped: ${stop.reason}`
            : `armed (no stop file; ${age === undefined ? "no run recorded yet" : `last run ${age}m ago`})`,
        );
        console.log(last ? summary(last) : "no run yet");
        return 0;
      }
      if (x !== undefined) throw new Refusal(`unknown loop command ${x}\n\n${USAGE}`);
      const interval = Number(one(a, "interval") ?? String(HOUR / 1000)) * 1000;
      const opts = {
        interval,
        maxLanes: Number(one(a, "max-lanes") ?? process.env["SEORI_MAX_LANES"] ?? "3"),
        maxStarts: Number(one(a, "max-starts") ?? process.env["SEORI_MAX_STARTS"] ?? "2"),
        force: one(a, "force") === "true",
        ...(one(a, "max-load") ?? process.env["SEORI_MAX_LOAD"] ? { maxLoad: Number(one(a, "max-load") ?? process.env["SEORI_MAX_LOAD"]) } : {}),
      };
      const count = (n: number): boolean => Number.isInteger(n) && n >= 0;
      if (!(Number.isFinite(interval) && interval > 0) || !count(opts.maxLanes) || !count(opts.maxStarts) ||
        !(opts.maxLoad === undefined || (Number.isFinite(opts.maxLoad) && opts.maxLoad > 0))) {
        throw new Refusal("--interval and --max-load must be finite positive numbers; --max-lanes and --max-starts whole numbers >= 0");
      }
      const once = one(a, "once") === "true";
      const me = once ? undefined : running(d.store.root, "loop");
      try {
        do {
          try {
            const run = await loopTick(d, opts);
            console.log(run.skipped ? `LOOP skipped: ${run.skipped}` : `LOOP started=${run.started.length} findings=${run.findings.length} asked=${run.asked.length}`);
          } catch (e) {
            console.error(`LOOP ERROR ${e instanceof Error ? e.message : String(e)}`);
            if (once) return 1;
          }
          if (!me) break;
          opts.force = false;
          await sleepUnless(msUntilNext(d, interval), me.stopped);
        } while (!me.stopped.aborted);
      } finally {
        me?.release();
      }
      if (me) console.log("LOOP ended by seori down");
      return 0;
    }
    case "backlog": {
      if (x === "add") {
        const id = need(a.pos[2], "item id");
        const p = one(a, "priority");
        const item = backlogAdd(d, id, need(one(a, "brief"), "--brief"), {
          title: one(a, "title"), cwd: one(a, "cwd"), decision: one(a, "decision"),
          ...(p !== undefined ? { priority: Number(p) } : {}),
        });
        console.log(`ADDED ${item.id} p${item.priority}${item.decision ? " (needs decision)" : ""}`);
      } else if (x === "list" || x === undefined) {
        for (const i of d.store.items()) {
          console.log(`${i.id.padEnd(24)} ${i.status.padEnd(8)} p${i.priority}  ${i.decision ? `DECIDE: ${i.decision}` : i.title}`);
        }
      } else if (x === "decide") {
        const id = need(a.pos[2], "item id");
        backlogDecide(d, id, await textOf(a));
        console.log(`DECIDED ${id}`);
      } else if (x === "drop") {
        const id = need(a.pos[2], "item id");
        backlogDrop(d, id, one(a, "text"));
        console.log(`DROPPED ${id}`);
      } else if (x === "import") {
        const { added, capped } = await backlogImport(d, need(a.pos[2], "owner/repo"), one(a, "label") ?? "seori", one(a, "cwd"));
        console.log(`IMPORTED ${added.length}${added.length ? `: ${added.join(", ")}` : ""}`);
        if (capped) console.error(`WARNING: gh returned ${IMPORT_LIMIT} issues, the import limit; some labelled issues may be missing`);
      } else {
        throw new Refusal(`unknown backlog command ${x}\n\n${USAGE}`);
      }
      return 0;
    }
    case "review": {
      const r = await review(d, need(x, "PR"), one(a, "model"));
      console.log(`REVIEW ${x} head=${r.sha} verdict=${r.verdict}`);
      return r.verdict === "CLEAR" ? 0 : 1;
    }
    case "merge":
      console.log(await mergeGate(d, need(x, "PR"), { dryRun: one(a, "dry-run") === "true" }));
      return 0;
    case "done": {
      const key = need(x, "lane key");
      await done(d, key);
      console.log(`DONE ${key}`);
      const rule = one(a, "lesson");
      if (rule !== undefined) {
        // A lesson never blocks the close (as dori): a bad one is a warning after DONE.
        const lane = d.store.lane(key)!;
        try {
          console.log(formatLessonAdded(addLesson(d.store.root, {
            cwd: lane.cwd, rule, evidence: one(a, "evidence") ?? lane.final?.evidence.join(" ") ?? lane.done ?? "closed lane", lane: key,
          }, d.now())));
        } catch (e) {
          console.log(`LESSON_WARNING ${(e as Error).message}`);
        }
      }
      return 0;
    }
    case "pause":
    case "resume": {
      const key = need(x, "lane key");
      const out = await (cmd === "pause" ? pauseLane : resumeLane)(d, key, one(a, "note"));
      console.log(out.lines.join("\n"));
      return 0;
    }
    case "object": {
      const key = need(x, "lane key");
      const reasons = a.flags.get("reason") ?? [];
      const sent = await objectDone(d, key, reasons);
      console.log(`OBJECTED ${key}`);
      return deliveryOutcome(sent, key);
    }
    case "status":
      status(d);
      return 0;
    case "daemon":
      return daemon(d.store.root);
    case "daemon-loop":
      return runDaemonLoop(d.store.root);
    case "down": {
      if (!DOWN_GROUPS[x ?? "all"]) throw new Refusal(`seori down takes duty, loop, daemon or all\n\n${USAGE}`);
      const r = await downHome(d, x ?? "all", { keepAutostart: one(a, "keep-autostart") === "true" });
      console.log(r.lines.join("\n"));
      return r.ok ? 0 : 1;
    }
    case "install-skill": {
      const r = installSkill(SEORI_SRC, one(a, "skills-dir") ?? defaultSkillsDir());
      console.log(`${r.ok ? "SKILL" : "WARNING"} ${r.note}`);
      return r.ok ? 0 : 1;
    }
    case "uninstall": {
      // Its loops and daemon run from this checkout: stop them before their command goes away.
      // Run from the lead or duty terminal, closing it would end this command before the uninstall: it is left open.
      console.log((await downHome(d, "all", { keepSelf: true })).lines.join("\n"));
      const lines = await uninstall({ skillsDir: one(a, "skills-dir") ?? defaultSkillsDir(), home: d.store.root, purge: a.flags.has("purge") });
      for (const line of lines) console.log(line);
      return 0;
    }
    case "msg":
      return msg(d, a, x);
    case "presence": {
      if (x !== "discord") throw new Refusal(`seori presence takes discord\n\n${USAGE}`);
      const stop = new AbortController();
      const onSignal = () => stop.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const root = d.store.root;
        return await runPresence(root, realPresenceDeps(), stop.signal);
      } catch (e) {
        if (e instanceof PresenceConfigError) throw new Refusal(e.message);
        throw e instanceof Error ? new Error(redact(e.message)) : e;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    case "watch":
      return watch(d, a, x);
    case "verify-pr": {
      const r = await verifyPr(d, parsePr(need(x, "owner/repo#N")), loadConfig(d.store.root));
      console.log(r.lines.join("\n"));
      return r.ok ? 0 : 2;
    }
    case "lesson":
      return lesson(d, a, x);
    case "checkpoint": {
      const key = laneKey(d, need(x, "lane key"));
      const w = recordCheckpoint(d.store.root, key, {
        step: need(one(a, "step"), "--step"),
        result: need(one(a, "result"), "--result"),
        evidence: a.flags.get("evidence") ?? [],
        remoteEffects: a.flags.get("remote-effect") ?? [],
      }, d.now());
      console.log(formatCheckpointWrite(w));
      return 0;
    }
    case "worklog": {
      const root = d.store.root;
      const now = d.now();
      if (x === "list") {
        const out = worklogListOutput(worklogList(root, { open: one(a, "open") === "true" }));
        for (const w of out.stderr) console.error(w);
        console.log(out.stdout);
        return 0;
      }
      const rest = () => need(a.pos.slice(3).join(" ") || undefined, "text");
      const item =
        x === "add" ? worklogAdd(root, need(a.pos.slice(2).join(" ") || undefined, "title"), need(one(a, "source"), "--source"), now)
        : x === "next" ? worklogNext(root, need(a.pos[2], "item id"), rest(), now)
        : x === "note" ? worklogNote(root, need(a.pos[2], "item id"), rest(), now)
        : x === "close" ? worklogClose(root, need(a.pos[2], "item id"), need(one(a, "result"), "--result"), now)
        : undefined;
      if (!item) throw new Refusal(`unknown worklog command ${x}\n\n${USAGE}`);
      console.log(worklogItemLine(item));
      return 0;
    }
    case "can-launch": {
      const r = await canLaunch(d, loadConfig(d.store.root));
      console.log(canLaunchLine(r));
      return r.ok ? 0 : 4;
    }
    case "guard":
      console.log((await guardLines(d, loadConfig(d.store.root))).join("\n"));
      return 0;
    case "heavy": {
      const label = need(x, "label");
      if (a.rest.length === 0) throw new Refusal(`seori heavy ${label} -- <cmd...>: give the command after --\n\n${USAGE}`);
      return runHeavy(d.store.root, label, a.rest, { config: loadConfig(d.store.root) });
    }
    case "boot": {
      const r = await bootReport(d);
      console.log(r.lines.join("\n"));
      return r.complete ? 0 : 1;
    }
    case "checkpoints": {
      const key = laneKey(d, need(x, "lane key"));
      console.log(formatCheckpoints(key, listCheckpoints(d.store.root, key)).join("\n"));
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 64;
  }
}

if (import.meta.main) {
  let code = 0;
  try {
    code = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof Unverified) {
      console.log(e.message);
      process.exit(3);
    }
    if (!(e instanceof Refusal || e instanceof WatchRefusal || e instanceof ConfigError || e instanceof HerdrRecord)) throw e;
    console.error(e.message);
    code = 2;
  } finally {
    await hooksSettled();
  }
  process.exit(code);
}
