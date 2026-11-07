#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultDeps, done, dutyTick, inboxList, mergeGate, ready, Refusal, releaseHeld, report, requireOmpIntegration, review, send, sendToShell,
  startAgent, startLane, ROLES, type Deps, type SendResult,
} from "./harness.ts";
import { heartbeatPath, runDaemon } from "./daemon.ts";
import { shq } from "./herdr.ts";
import { backlogAdd, backlogDecide, backlogDrop, backlogImport, loopTick, msUntilNext, summary, HOUR, IMPORT_LIMIT } from "./loop.ts";
import { loadMessengers } from "./messenger/adapter.ts";
import { adapterFor } from "./messenger/index.ts";
import { msgClose, msgList, msgSend, parseTo, type MsgDeps } from "./msg.ts";
import type { Role } from "./store.ts";
import { ownerText, WATCH_USAGE, watchAdd, watchList, watchLog, watchRearm, watchStop } from "./watch/cli.ts";
import { WatchRefusal } from "./watch/store.ts";

const USAGE = `seori - a proactive multi-session harness on herdr + omp

  seori up [--cwd DIR]                         open lead, duty, duty loop, hourly loop and daemon panes
  seori role <lead|duty> [PANE]                register a pane as lead or duty (default: this pane)
  seori start <key> --brief FILE [--cwd DIR]   open a lane: new tab, omp session, brief + lane rules
  seori report <key> --text T [--status working|waiting]
  seori ready <key> --text T --evidence LINK [--evidence LINK ...]
  seori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                  [--to-shell]                operator only: type this one message into a pane with no agent
  seori inbox list <pane|role|key>             queued entries: index, state (queued|typed|held), sender, time, first 60 chars
  seori inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
  seori inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
  seori duty [--once] [--interval SECONDS]     flush inboxes, nudge silent lanes, escalate, detect lost lanes
  seori duty stop [--text WHY] | resume | status   kill switch
  seori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                              hourly: sync backlog, audit missed work, start the next item, ask decisions
  seori loop stop [--text WHY] | resume | status   kill switch and last run
  seori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  seori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
  seori backlog import <owner/repo> [--label seori] [--cwd DIR]   open labelled issues -> items
  seori review <owner/repo#N> [--model M]      fresh omp reviewer at the exact head -> receipt
  seori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
  seori done <key>                             lead closes a READY lane
  seori status
  seori daemon                                 receive messengers into the lead channel and run watches (seori up runs it)
  seori msg send (--reply-to ID[,ID...] | --to SOURCE:CHAT[:THREAD]) --text T [--again]
                                              answer messenger messages (one reply per id) or send a notice
  seori msg close <id> --why T                 close a lead channel message (messenger message or watch event) that needs no reply
  seori msg list [--all]                       open lead channel messages (messenger messages and watch events; --all: every one)
                                              columns: id  state  age  kind  sender-or-watch-name  text
${WATCH_USAGE}

--text may be omitted to read the message from stdin.
send, report and ready exit 3 and print HELD <target> when the delivery may or may not have reached the pane:
it is held and never resent, so do not send it again: check the pane, then seori inbox ack or seori inbox resend it.
QUEUED (exit 0) means it waits in the pane's inbox.
msg send exits 3 with HELD when the messenger may or may not have the reply: check the chat, then pass --again.
A second reply to an id is refused (exit 2) unless --again is given.
SEORI_MODEL=M passes --model M to every omp seori starts (lead, duty, lanes) and is the reviewer's default model.
watch add arms the watch for the lane in SEORI_LANE (set in every lane's pane), else for the lead; refusals exit 2.
up and start need herdr's omp integration (herdr integration install omp).`;

type Args = { pos: string[]; flags: Map<string, string[]> };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["once", "force", "dry-run", "to-shell", "again", "all", "persistent"]);

function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    const value = BOOLEAN_FLAGS.has(name) || next === undefined ? "true" : (i++, next);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags };
}

const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.at(-1);
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Refusal(`missing ${what}\n\n${USAGE}`);
  return v;
};

async function textOf(a: Args): Promise<string> {
  const t = one(a, "text");
  if (t !== undefined) return t;
  if (process.stdin.isTTY) throw new Refusal("give --text or pipe the message on stdin");
  return (await Bun.stdin.text()).trim();
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
 * The daemon pane's restart loop. A daemon that crashed (SIGKILL, OOM, a panic) or exited to load a changed
 * messengers.json is back within about a second. Only a deliberate stop ends the loop: Ctrl-C (130) or kill/SIGTERM
 * (143). sh -c so the loop works whatever the pane's login shell is.
 */
export const daemonLoop = (seoriCmd: string): string =>
  `while :; do ${seoriCmd} daemon; s=$?; case "$s" in 130|143) exit "$s";; esac; sleep 1; done`;

async function up(d: Deps, cwd: string): Promise<void> {
  await requireOmpIntegration(d);
  const env = { SEORI_HOME: d.store.root };
  const session = process.env["SEORI_HERDR_SESSION"];
  // The extension reads its home and how to run seori from the environment of the shell omp starts in.
  const leadEnv = { ...env, SEORI_CMD: d.seoriCmd, ...(session ? { SEORI_HERDR_SESSION: session } : {}) };
  const lead = await d.herdr.createWorkspace("seori", cwd, leadEnv);
  await startAgent(d, "lead", lead.paneId, ["-e", LEAD_EXTENSION, "--append-system-prompt", renderPrompt(d, "lead.md")]);
  d.store.setRole("lead", lead.paneId);
  const duty = await d.herdr.createTab("duty", cwd, lead.workspaceId, env);
  await startAgent(d, "duty", duty.paneId, ["--append-system-prompt", renderPrompt(d, "duty.md")]);
  d.store.setRole("duty", duty.paneId);
  const loop = await d.herdr.split(duty.paneId, cwd, env);
  const hourly = await d.herdr.split(loop.paneId, cwd, { ...env, HERDR_WORKSPACE_ID: lead.workspaceId });
  const daemon = await d.herdr.split(hourly.paneId, cwd, env);
  const daemonStarted = d.now();
  await d.herdr.run(daemon.paneId, `sh -c ${shq(daemonLoop(d.seoriCmd))}`);
  // The duty loop's first tick reports a missing heartbeat to the lead as a daemon outage, so it starts only once the
  // daemon is up; a daemon that does not come up is reported here and left to duty's outage alert.
  if (!(await heartbeatSince(d.store.root, daemonStarted))) {
    console.error(`WARNING: the messenger daemon in ${daemon.paneId} wrote no heartbeat within ${DAEMON_START_MS / 1000} s; check that pane`);
  }
  await d.herdr.run(loop.paneId, `${d.seoriCmd} duty --interval 60`);
  await d.herdr.run(hourly.paneId, `${d.seoriCmd} loop`);
  console.log(
    `UP lead=${lead.paneId} duty=${duty.paneId} loop=${loop.paneId} hourly=${hourly.paneId} daemon=${daemon.paneId} home=${d.store.root}`,
  );
}

const DAEMON_START_MS = 15_000;

/** Polls the daemon heartbeat until one written at or after `since` appears, for at most DAEMON_START_MS of real time. */
async function heartbeatSince(root: string, since: number): Promise<boolean> {
  for (let waited = 0; ; waited += 200) {
    let beat: unknown;
    try {
      beat = JSON.parse(readFileSync(heartbeatPath(root), "utf8"));
    } catch {
      // not written yet
    }
    if (beat && typeof beat === "object" && "at" in beat && typeof beat.at === "number" && beat.at >= since) return true;
    if (waited >= DAEMON_START_MS) return false;
    await Bun.sleep(200);
  }
}

/**
 * Runs the daemon until SIGINT or SIGTERM, then stops it cleanly (lock released, heartbeat stopped) and re-raises the
 * signal: the shell running `seori up`'s restart loop sees a status of 128 or more and stops the loop too, so Ctrl-C or
 * `kill` stops the daemon instead of restarting it. Returns 0 when messengers.json changed, which the loop restarts.
 */
async function daemon(root: string): Promise<number> {
  const stop = new AbortController();
  let caught: NodeJS.Signals | undefined;
  const onSignal = (sig: NodeJS.Signals) => {
    caught = sig;
    stop.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await runDaemon(root, { signal: stop.signal });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (!caught) return 0;
  process.kill(process.pid, caught);
  // If the re-raised signal is not delivered before main exits, the shell convention still reports it: 128 + number.
  return 128 + osConstants.signals[caught];
}

function msgDeps(d: Deps): MsgDeps {
  const root = d.store.root;
  return { adapterFor: (c) => adapterFor(c, root), configs: loadMessengers(root), now: d.now };
}

async function msg(d: Deps, a: Args, sub: string | undefined): Promise<number> {
  const root = d.store.root;
  if (sub === "send") {
    const replyTo = a.flags.get("reply-to")?.flatMap((v) => v.split(",")).map((id) => id.trim()).filter(Boolean);
    const to = one(a, "to");
    const r = await msgSend(root, {
      ...(replyTo ? { replyTo } : {}),
      ...(to !== undefined ? { to: parseTo(to) } : {}),
      text: await textOf(a),
      again: one(a, "again") === "true",
    }, msgDeps(d));
    const what = r.ids.length ? r.ids.join(",") : to!;
    if (r.status === "SENT") {
      console.log(`SENT ${what} message=${r.messageId}`);
      return 0;
    }
    console.log(`HELD ${what}: the messenger may or may not have the reply; check the chat, then resend with --again`);
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
  if (sub === "stop") {
    const w = watchStop(root, need(a.pos[2], "watch id or name"), d.now());
    console.log(`STOPPED ${w.id} ${w.name}`);
    return 0;
  }
  if (sub === "rearm") {
    const { watch: w, missed } = watchRearm(root, need(a.pos[2], "watch id or name"), d.now());
    console.log(`REARMED ${w.id} ${w.name}: ${missed} event(s) missed while muted; wake budget reset`);
    return 0;
  }
  if (sub === "log") {
    // -n is the one short flag: parse() only knows --flags, so it arrives as a positional pair.
    const at = a.pos.indexOf("-n");
    const n = at >= 0 ? Number(a.pos[at + 1]) : 20;
    if (!(Number.isInteger(n) && n > 0)) throw new Refusal("-n takes a whole number > 0");
    const lines = watchLog(root, need(a.pos[2] === "-n" ? a.pos[4] : a.pos[2], "watch id or name"), n);
    console.log(lines.length ? lines.join("\n") : "EMPTY");
    return 0;
  }
  throw new Refusal(`unknown watch command ${sub}\n\n${USAGE}`);
}

function status(d: Deps): void {
  const roles = d.store.roles();
  console.log(`lead=${roles.lead ?? "-"} duty=${roles.duty ?? "-"} home=${d.store.root}`);
  for (const l of d.store.lanes()) {
    const last = l.log.at(-1);
    const age = Math.round((d.now() - l.lastActivityAt) / 60_000);
    console.log(`${l.key.padEnd(24)} ${l.status.padEnd(8)} ${l.paneId.padEnd(8)} active ${age}m ago  ${last ? `${last.kind}: ${last.text.slice(0, 60)}` : ""}`);
  }
}

export async function main(argv: readonly string[], d: Deps = defaultDeps()): Promise<number> {
  const a = parse(argv);
  const [cmd, x] = a.pos;
  switch (cmd) {
    case "up":
      await up(d, resolve(one(a, "cwd") ?? process.cwd()));
      return 0;
    case "role": {
      const role = need(x, "role") as Role;
      if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
      const pane = need(a.pos[2] ?? process.env["HERDR_PANE_ID"], "pane id (not inside herdr?)");
      d.store.setRole(role, pane);
      console.log(`ROLE ${role}=${pane}`);
      return 0;
    }
    case "start": {
      const lane = await startLane(d, need(x, "lane key"), need(one(a, "brief"), "--brief"), {
        cwd: one(a, "cwd"), workspace: one(a, "workspace"),
      });
      console.log(`STARTED ${lane.key} pane=${lane.paneId} brief=${lane.brief}`);
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
        const { paneId, entries } = inboxList(d, target);
        if (entries.length === 0) console.log(`EMPTY ${paneId}`);
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
      do {
        for (const e of await dutyTick(d)) console.log(`DUTY ${[e.lane ?? e.pane, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`);
        if (one(a, "once")) break;
        await Bun.sleep(interval);
      } while (true);
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
      do {
        try {
          const run = await loopTick(d, opts);
          console.log(run.skipped ? `LOOP skipped: ${run.skipped}` : `LOOP started=${run.started.length} findings=${run.findings.length} asked=${run.asked.length}`);
        } catch (e) {
          console.error(`LOOP ERROR ${e instanceof Error ? e.message : String(e)}`);
          if (one(a, "once")) return 1;
        }
        if (one(a, "once")) break;
        opts.force = false;
        await Bun.sleep(msUntilNext(d, interval));
      } while (true);
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
    case "done":
      await done(d, need(x, "lane key"));
      console.log(`DONE ${x}`);
      return 0;
    case "status":
      status(d);
      return 0;
    case "daemon":
      return daemon(d.store.root);
    case "msg":
      return msg(d, a, x);
    case "watch":
      return watch(d, a, x);
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
    if (!(e instanceof Refusal || e instanceof WatchRefusal)) throw e;
    console.error(e.message);
    code = 2;
  }
  process.exit(code);
}
