#!/usr/bin/env bun
// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, resolve } from "node:path";
import {
  agentOmpConfigFiles, defaultDeps, done, dutyTick, inboxList, mergeGate, paneEnv, ready, Refusal, releaseHeld, report, requireOmpIntegration, review, send, sendToShell,
  startAgent, startLane, ROLES, type Deps, type SendResult,
} from "./harness.ts";
import { heartbeatPath, runDaemon } from "./daemon.ts";
import { down, DOWN_GROUPS, liveRunners, running, sleepUnless } from "./down.ts";
import { defaultSkillsDir, installSkill, SEORI_SRC, uninstall } from "./install.ts";
import { backlogAdd, backlogDecide, backlogDrop, backlogImport, loopTick, msUntilNext, summary, HOUR, IMPORT_LIMIT } from "./loop.ts";
import { loadMessengers } from "./messenger/adapter.ts";
import { adapterFor } from "./messenger/index.ts";
import { flushLine, msgClose, msgDepsFor, msgDrafts, msgDrop, msgFlush, msgList, msgSend, parseTo } from "./msg.ts";
import { statusOf, type SessionRef } from "./runtime/index.ts";
import { pidAlive, type Role } from "./store.ts";
import { parsePr } from "./harness.ts";
import { candidateLine, DEFAULT_PAIR_MINUTES, pairedLine, pairOwner } from "./pair.ts";
import { canLaunch, canLaunchLine, guardLines } from "./guard.ts";
import { runHeavy } from "./heavy.ts";
import { objectDone } from "./done-flow.ts";
import { pauseLane, resumeLane, Unverified } from "./pause.ts";
import { bootReport } from "./boot.ts";
import { worklogAdd, worklogClose, worklogItemLine, worklogList, worklogListOutput, worklogNext, worklogNote } from "./worklog.ts";
import { ConfigError, configPath, loadConfig } from "./config.ts";
import { formatCheckpoints, formatCheckpointWrite, listCheckpoints, recordCheckpoint } from "./checkpoints.ts";
import { addLesson, formatLessonAdded, formatLessonMarked, formatLessons, isLessonMark, listLessons, markLesson } from "./lessons.ts";
import { verifyPr } from "./verify-pr.ts";
import { ownerText, WATCH_USAGE, watchAdd, watchList, watchLog, watchRearm, watchStop } from "./watch/cli.ts";
import { WatchRefusal } from "./watch/store.ts";
import { refText } from "./refs.ts";
import { parseRef } from "./runtime/types.ts";

const USAGE = `seori - a proactive multi-session harness on herdr + omp

  seori up [--cwd DIR]                         open lead, duty, duty loop, hourly loop and daemon panes (once per home)
  seori role <lead|duty> [REF]                 register a session (w1:p3, herdr:w1:p3, hc:t7) as lead or duty (default: this one)
  seori start <key> --brief FILE [--cwd DIR]   open a lane: new tab, omp session, lessons + brief + lane rules
              [--done "SIGNALS"] [--thread ID] [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--force]
                                              Done line read back live before close; ID = lead channel id for progress posts;
                                              ceilings block (report to lead); exits 4 with HOLD when the host is full
  seori report <key> --text T [--status working|waiting]
  seori ready <key> --text T --evidence LINK [--evidence LINK ...]
  seori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                  [--to-shell]                operator only: type this one message into a pane with no agent
  seori inbox list <pane|role|key>             queued entries: index, state (queued|typed|held), sender, time, first 60 chars
  seori inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
  seori inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
  seori duty [--once] [--interval SECONDS]     flush inboxes, nudge silent lanes, escalate, detect lost lanes, close Done lanes,
                                              ceilings and stalls, host guard, progress posts to the owner's thread
  seori duty stop [--text WHY] | resume | status   kill switch
  seori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                              hourly: sync backlog, audit missed work, start the next item, ask decisions
  seori loop stop [--text WHY] | resume | status   kill switch and last run
  seori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  seori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
  seori backlog import <owner/repo> [--label seori] [--cwd DIR]   open labelled issues -> items
  seori review <owner/repo#N> [--model M]      fresh omp reviewer at the exact head -> receipt
  seori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks + verify-pr -> squash merge
  seori verify-pr <owner/repo#N>               commit identities (config repoIdentities) + fix-needs-a-test rule; exit 2 on FAIL
  seori done <key> [--lesson T [--evidence P]] lead closes a READY lane (a Done line must read back live); optional lesson
  seori object <key> --reason T [--reason T]   the lead objects to a READY claim: back to working with the reasons
  seori pause <key> [--note T] | resume <key> [--note T]   pause/resume a lane's omp goal (exit 3 if unconfirmed)
  seori checkpoint <key> --step ID --result T --evidence P [--remote-effect R ...] | checkpoints <key>
  seori lesson add <key|--cwd DIR> --rule T --evidence P | lesson list [--cwd DIR] | lesson mark <id> --outcome O
                                              O = helped|no-effect|harmful|encoded; new lanes get a repo's pending/helped lessons
  seori worklog add <title> --source REF | next <id> <text> | note <id> <text> | close <id> --result T | list [--open]
  seori boot                                   read-only check after a restart or compaction (exit 1 if something was unreadable)
  seori can-launch | guard                     room for a lane? (exit 4 HOLD) | host reading and guard state
  seori heavy <label> -- <cmd...>              run a heavy command when load is low and a heavy slot is free
  seori status
  seori daemon                                 receive messengers into the lead channel and run watches (seori up runs it)
  seori daemon-loop                            run the daemon and restart it when it crashes (seori up's daemon pane)
  seori down [duty|loop|daemon|all]            stop the duty loop, hourly loop and daemon processes (default all);
                                              exit 1 if one is still running after 30 s
  seori install-skill [--skills-dir DIR]       link the seori-mode skill into omp; install.sh runs it
  seori uninstall [--skills-dir DIR] [--purge] remove the skill link and the seori command; --purge also deletes $SEORI_HOME
  seori msg send (--reply-to ID[,ID...] | --to SOURCE:CHAT[:THREAD]) --text T [--again] [--now]
                                              answer messenger messages (one reply per id) or send a notice; while the
                                              lead extension runs it is drafted and goes out when the lead's turn ends
                                              (--now: send at once); a second send to the same ids replaces the draft
  seori msg send --replace DRAFT --text T      change the text of an open draft (reply or notice)
  seori msg drafts                             open drafts: draft  age  reply IDS|notice SOURCE:CHAT  text
  seori msg drop <draft> --why T               discard an open draft; its ids are open again
  seori msg flush                              send every open draft now, oldest first
  seori msg close <id> --why T                 close a lead channel message (messenger message or watch event) that needs no reply
  seori msg list [--all]                       open lead channel messages (messenger messages and watch events; --all: every one)
                                              columns: id  state  age  kind  sender-or-watch-name  text
  seori msg check [SOURCE]                     verify messengers' tokens (prints who the bot is); SOURCE works before pairing
  seori msg pair <SOURCE> [--minutes N] [--write] [--all] [--force]
                                              setup: print the sender of the next DM to the bot; --write makes them the owner;
                                              --force re-pairs a configured Telegram owner (drops updates queued for the daemon)
${WATCH_USAGE}

--text may be omitted to read the message from stdin.
send, report and ready exit 3 and print HELD <target> when the delivery may or may not have reached the pane:
it is held and never resent, so do not send it again: check the pane, then seori inbox ack or seori inbox resend it.
QUEUED (exit 0) means it waits in the pane's inbox.
msg send exits 3 with HELD when the messenger may or may not have the reply: check the chat, then pass --again.
msg flush prints SENT, HELD or FAILED per draft; it exits 1 if a draft failed (it stays open), else 3 if one is HELD.
A second reply to an id is refused (exit 2) unless --again is given.
SEORI_MODEL=M passes --model M to every omp seori starts (lead, duty, lanes) and is the reviewer's default model.
watch add arms the watch for the lane in SEORI_LANE (set in every lane's pane), else for the lead; refusals exit 2.
watch stop, rearm and log take a name of that same owner's live watches (--for picks another owner) or any watch's id.
up and start need herdr's omp integration (herdr integration install omp).`;

type Args = { pos: string[]; flags: Map<string, string[]>; /** Everything after a bare `--`, verbatim (seori heavy). */ rest: string[] };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["once", "force", "dry-run", "to-shell", "again", "all", "persistent", "write", "open", "now", "purge", "help"]);

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
  const src = readFileSync(join(import.meta.dir, "..", "prompts", name), "utf8").replaceAll("{{seori}}", d.seoriCmd);
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

/**
 * Writes `$SEORI_HOME/prompts/lead-omp.yml` (omp settings for the lead only) and returns the PI_CONFIG_FILES value
 * that loads it after every agent's settings (agentOmpConfigFiles), all after a PI_CONFIG_FILES already in the
 * environment, joined with the path delimiter (omp splits on it), so it overlays those too.
 */
function leadOmpConfig(root: string): string {
  const dir = join(root, "prompts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "lead-omp.yml");
  writeFileSync(path, "advisor:\n  syncBacklog: strict\n");
  return agentOmpConfigFiles(root, [path]);
}

/**
 * What `seori up` finds before it opens anything, so an autostart script can call it every logon. This home is up when
 * one of its loops or its daemon is alive, or its lead pane is: then the ALREADY UP line is returned and nothing opens.
 * Otherwise a workspace that already has this home's name belongs to someone else (another home with the same name, or
 * a workspace left from this home's loops that are gone): opening a second one under that label is refused. Undefined:
 * up may open.
 */
export async function upCheck(d: Deps, name: string, alive: (pid: number) => boolean = pidAlive): Promise<string | undefined> {
  const root = d.store.root;
  const runners = liveRunners(root, alive);
  const named = (await d.runtimes.default.groups()).filter((w) => w.label === name);
  const lead = d.store.roles().lead;
  // herdr pane ids are `<workspace>:p<n>`. The lead counts only inside a workspace with this home's name: herdr ids start
  // over after a herdr restart, and an old id can then name another instance's pane.
  const leadLive = lead !== undefined && named.some((w) => w.id === lead.id.split(":")[0]) && (await statusOf(d.runtimes, lead)) !== "gone";
  if (runners.length > 0 || leadLive) {
    const hint = leadLive ? "" : "; the lead pane is gone: run seori down, then seori up, to open a new set";
    return `ALREADY UP name=${name} home=${root} lead=${leadLive ? refText(lead) : "gone"} running=${runners.join(",") || "none"}; nothing opened${hint}`;
  }
  if (named.length > 0) {
    throw new Refusal(
      `a herdr workspace labelled "${name}" (${named.map((w) => w.id).join(", ")}) is open, but this home (${root}) has no live lead, ` +
        `loop or daemon in it. Close that workspace if it is a leftover of this home, or give this home its own name in ${configPath(root)}`,
    );
  }
  return undefined;
}

async function up(d: Deps, cwd: string): Promise<void> {
  await requireOmpIntegration(d);
  const name = loadConfig(d.store.root).name;
  const already = await upCheck(d, name);
  if (already) {
    console.log(already);
    return;
  }
  // Every pane gets seori's environment from herdr (--env), so its commands need no shell-specific env prefix.
  const env = paneEnv(d.store.root);
  // The extension reads its home and how to run seori from the environment of the shell omp starts in. The lead's omp
  // also gets PI_CONFIG_FILES with advisor.syncBacklog: strict, so the advisor's agent-end review finishes before
  // agent_end and its reply drafts are released only after the review (src/release.ts). Only the lead gets that file;
  // the lead, duty and lanes all get agent-omp.yml (no setup wizard in an agent pane).
  const leadEnv = { SEORI_HOME: d.store.root, SEORI_CMD: d.seoriCmd, ...env, PI_CONFIG_FILES: leadOmpConfig(d.store.root) };
  const rt = d.runtimes.default;
  const below = (near: SessionRef, role: "duty-loop" | "hourly-loop" | "daemon", paneEnv: Record<string, string>) =>
    rt.create({ name: role, cwd, env: paneEnv, role, container: "split-below", near });
  const leadRef = await rt.create({ name, cwd, env: leadEnv, role: "lead", container: "workspace-root" });
  const lead = { paneId: refText(leadRef), workspaceId: leadRef.group ?? "" };
  await startAgent(d, "lead", leadRef, ["-e", LEAD_EXTENSION, "--append-system-prompt", renderPrompt(d, "lead.md")]);
  d.store.setRole("lead", leadRef);
  const dutyRef = await rt.create({
    name: "duty", cwd, env: { ...env, PI_CONFIG_FILES: agentOmpConfigFiles(d.store.root) }, role: "duty", container: "tab", group: lead.workspaceId,
  });
  const duty = { paneId: refText(dutyRef) };
  await startAgent(d, "duty", dutyRef, ["--append-system-prompt", renderPrompt(d, "duty.md")]);
  d.store.setRole("duty", dutyRef);
  const loopRef = await below(dutyRef, "duty-loop", env);
  const hourlyRef = await below(loopRef, "hourly-loop", { ...env, HERDR_WORKSPACE_ID: lead.workspaceId });
  const daemonRef = await below(hourlyRef, "daemon", env);
  const [loop, hourly, daemon] = [{ paneId: refText(loopRef) }, { paneId: refText(hourlyRef) }, { paneId: refText(daemonRef) }];
  const daemonStarted = d.now();
  await rt.start(daemonRef, `${d.seoriCmd} daemon-loop`);
  // The duty loop's first tick reports a missing heartbeat to the lead as a daemon outage, so it starts only once the
  // daemon is up; a daemon that does not come up is reported here and left to duty's outage alert.
  const beat = await heartbeatSince(d.store.root, daemonStarted, {
    onSlow: () => console.error(`waiting for the messenger daemon in ${daemon.paneId} to start (a first start can be slow)...`),
  });
  if (!beat) {
    console.error(`WARNING: the messenger daemon in ${daemon.paneId} wrote no heartbeat within ${DAEMON_START_MS / 1000} s; check that pane`);
  }
  await rt.start(loopRef, `${d.seoriCmd} duty --interval 60`);
  await rt.start(hourlyRef, `${d.seoriCmd} loop`);
  console.log(
    `UP lead=${lead.paneId} duty=${duty.paneId} loop=${loop.paneId} hourly=${hourly.paneId} daemon=${daemon.paneId} home=${d.store.root} name=${name}`,
  );
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

async function msg(d: Deps, a: Args, sub: string | undefined): Promise<number> {
  const root = d.store.root;
  if (sub === "send") {
    const replyTo = a.flags.get("reply-to")?.flatMap((v) => v.split(",")).map((id) => id.trim()).filter(Boolean);
    const to = one(a, "to");
    const replace = one(a, "replace");
    const r = await msgSend(root, {
      ...(replyTo ? { replyTo } : {}),
      ...(to !== undefined ? { to: parseTo(to) } : {}),
      ...(replace !== undefined ? { replace } : {}),
      text: await textOf(a),
      again: one(a, "again") === "true",
      sendNow: one(a, "now") === "true",
    }, msgDepsFor(root, d.now));
    const what = r.ids.length ? r.ids.join(",") : to!;
    if (r.status === "DRAFTED") {
      console.log(`DRAFTED ${r.draft} ${what}: goes out when your turn ends`);
      return 0;
    }
    if (r.status === "REPLACED") {
      console.log(`REPLACED ${r.draft}`);
      return 0;
    }
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
  if (sub === "drafts") {
    const lines = msgDrafts(root, d.now());
    console.log(lines.length ? lines.join("\n") : "EMPTY");
    return 0;
  }
  if (sub === "drop") {
    const draft = need(a.pos[2], "draft id");
    msgDrop(root, draft, need(one(a, "why"), "--why"), d.now());
    console.log(`DROPPED ${draft}`);
    return 0;
  }
  if (sub === "flush") {
    const outcomes = await msgFlush(root, msgDepsFor(root, d.now));
    console.log(outcomes.length ? outcomes.map(flushLine).join("\n") : "EMPTY");
    return outcomes.some((o) => o.status === "FAILED") ? 1 : outcomes.some((o) => o.status === "HELD") ? 3 : 0;
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
  throw new Refusal(`unknown msg command ${sub}\n\n${USAGE}`);
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

function lesson(d: Deps, a: Args, sub: string | undefined): number {
  const root = d.store.root;
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
    console.log(formatLessonMarked(markLesson(root, need(a.pos[2], "lesson id"), outcome, d.now())));
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
  const [cmd, x] = a.pos;
  switch (cmd) {
    case "up":
      await up(d, resolve(one(a, "cwd") ?? process.cwd()));
      return 0;
    case "role": {
      const role = need(x, "role") as Role;
      if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
      const given = a.pos[2];
      const ref = given === undefined ? d.runtimes.selfAny(process.env) : parseRef(given);
      if (given !== undefined && ref === undefined) throw new Refusal(`${given} is not a session ref (w1:p3, herdr:w1:p3 or hc:t7)`);
      if (ref === undefined) throw new Refusal(`missing session ref (not inside herdr or hc?)\n\n${USAGE}`);
      d.store.setRole(role, ref);
      console.log(`ROLE ${role}=${refText(ref)}`);
      return 0;
    }
    case "start": {
      const key = need(x, "lane key");
      const config = loadConfig(d.store.root);
      // Nothing is read about the host before the omp integration check: without it no lane can start anyway.
      await requireOmpIntegration(d);
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
      const lane = await startLane(d, key, need(one(a, "brief"), "--brief"), {
        cwd: one(a, "cwd"), workspace: one(a, "workspace"),
        ...(one(a, "done") !== undefined ? { done: one(a, "done")! } : {}),
        ...(one(a, "thread") !== undefined ? { thread: one(a, "thread")! } : {}),
        ...(anyCeiling ? {
          ceilings: {
            wallMinutes: ceilingFlag("wall-minutes", defaults.wallMinutes),
            tokens: ceilingFlag("token-limit", defaults.tokens),
            costUsd: ceilingFlag("cost-limit", defaults.costUsd),
          },
        } : {}),
      });
      console.log(`STARTED ${lane.key} pane=${refText(lane.sessionRef)} brief=${lane.brief}`);
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
      const tick = async () => {
        for (const e of await dutyTick(d)) console.log(`DUTY ${[e.lane ?? e.pane, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`);
      };
      if (one(a, "once")) {
        await tick();
        return 0;
      }
      const me = running(d.store.root, "duty");
      try {
        while (!me.stopped.aborted) {
          await tick();
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
      const group = DOWN_GROUPS[x ?? "all"];
      if (!group) throw new Refusal(`seori down takes duty, loop, daemon or all\n\n${USAGE}`);
      const r = await down(d.store.root, group);
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
      console.log((await down(d.store.root, DOWN_GROUPS["all"]!)).lines.join("\n"));
      const name = (() => {
        try {
          return loadConfig(d.store.root).name;
        } catch {
          return undefined; // a broken config.json must not stop an uninstall
        }
      })();
      const lines = await uninstall({ skillsDir: one(a, "skills-dir") ?? defaultSkillsDir(), home: d.store.root, name, purge: a.flags.has("purge") });
      for (const line of lines) console.log(line);
      return 0;
    }
    case "msg":
      return msg(d, a, x);
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
    if (!(e instanceof Refusal || e instanceof WatchRefusal || e instanceof ConfigError)) throw e;
    console.error(e.message);
    code = 2;
  }
  process.exit(code);
}
