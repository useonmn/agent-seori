// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { agentCommand, selectAgent, type AgentProfile } from "./agent/profile.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { Channel, type IdState, type MessengerRow } from "./channel.ts";
import { Outbox } from "./outbox.ts";
import {
  DeliveryUncertain, deliverOrThrow, shq, spawnExec, ToolError, type AgentStatus, type Exec, type SessionRef, type SessionRuntime,
} from "./runtime/index.ts";
import { loadMessengers, SendUncertain, type MessengerConfig, type SendTarget } from "./messenger/adapter.ts";
import { adapterFor } from "./messenger/index.ts";
import { KEY_RE, reservedKey, Store, type Ceilings, type DeliveryAttempt, type HostLoad, type Lane, type QueuedMessage, type Role } from "./store.ts";
import { DEFAULT_CONFIG, loadConfig, type SeoriConfig } from "./config.ts";
import { OMP_ULW_URL, type Workflow, workflowPrefix } from "./workflow.ts";
import { autoCloseTick, claimLeadLine, claimText, closeLane, closeRule, sameClaim } from "./done-flow.ts";
import { guardTick } from "./guard.ts";
import { progressTick } from "./progress.ts";
import { superviseTick } from "./supervision.ts";
import { checkSignals, parseDone } from "./signals.ts";
import { GLOBAL_LESSONS_HEADING, LESSONS_HEADING, lessonsForRepo, lessonWarnings, renderLessons } from "./lessons.ts";
import { verifyPr } from "./verify-pr.ts";
import { resolveTarget } from "./target.ts";
import { refText, sameSession } from "./refs.ts";
import { loadHooks, runHook } from "./hooks.ts";

export { KEY_RE, reservedKey };
export { resolveTarget };

export const NUDGE_MINUTES = [10, 20, 40] as const;
const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");
const FOOTER_RE = /(^|\n)## Lane rules \(added by seori for lane [\s\S]*$/;
/** The lessons block renderLessons puts at the top of a brief: the heading, one `- ` line per lesson, a blank line. */
const LESSONS_RE = new RegExp(`^(?:${GLOBAL_LESSONS_HEADING}\\n(?:- .*\\n)*\\n)?(?:${LESSONS_HEADING}\\n(?:- .*\\n)*\\n)?`);

export type Deps = {
  readonly store: Store;
  /** Every session seori opens or talks to goes through this (hc, src/runtime/hc); records store each session's SessionRef. */
  readonly runtime: SessionRuntime;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly seoriCmd: string;
  readonly host: () => HostLoad;
  /** Waits between the reads that confirm a lane's kickoff took (tests advance a fake clock instead). */
  readonly sleep: (ms: number) => Promise<void>;
  /** The agent seori starts in every pane and runs as the reviewer (src/agent/profile.ts: omp, the only agent). */
  readonly agent: AgentProfile;
  /** SEORI_MODEL: passed as `--model` to every agent seori starts (lead, duty, lanes) and the reviewer's default. */
  readonly model?: string;
  /** Sends one duty alert to the human through a configured messenger. Throws like MessengerAdapter.send. */
  readonly notify: (config: MessengerConfig, target: SendTarget, text: string) => Promise<void>;
  /** The OS, process.platform when unset (tests pin it). `seori up` on hc uses systemd --user units only on "linux". */
  readonly platform?: string;
};

export const defaultDeps = (): Deps => {
  const store = new Store();
  // Selected on first use, like the runtime, so a bad SEORI_AGENT or config.json fails the command that needs an agent
  // with its own message, not every command.
  let agent: AgentProfile | undefined;
  const profile = (): AgentProfile => (agent ??= selectAgent(store.root).profile);
  const agentCmd = (): string => agentCommand(profile());
  let hc: HcRuntime | undefined;
  return {
    store,
    get runtime() {
      return (hc ??= new HcRuntime(undefined, { agentCommand: agentCmd() }));
    },
    exec: spawnExec,
    now: Date.now,
    get agent() {
      return profile();
    },
    get agentCmd() {
      return agentCmd();
    },
    seoriCmd: process.env["SEORI_CMD"] ?? defaultSeoriCmd(store.root, process.env),
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    sleep: (ms) => Bun.sleep(ms),
    model: process.env["SEORI_MODEL"] || undefined,
    notify: async (config, target, text) => {
      await adapterFor(config, store.root).send(target, text);
    },
  };
};

/** What selects this seori: its home and the model it starts omp with. */
const seoriVars = (home: string, env: Record<string, string | undefined>): [string, string][] =>
  ([["SEORI_HOME", home], ["SEORI_MODEL", env["SEORI_MODEL"]]] as [string, string | undefined][])
    .filter((kv): kv is [string, string] => Boolean(kv[1]));

/** The environment every terminal seori opens gets (see seoriVars). */
export function paneEnv(home: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(seoriVars(home, env));
}

// The omp profile's settings files (agent-omp.yml, its mnemopi DB per home) live in src/agent/profile.ts.
export { AGENT_OMP_CONFIG, agentOmpConfig, agentOmpConfigFiles, DEFAULT_HOME, ompMemoryDb } from "./agent/profile.ts";

/**
 * How agents and loop panes call seori. The command carries seoriVars as an env prefix, so it also works in a shell
 * seori did not open (a lead started by hand).
 */
export function defaultSeoriCmd(home: string, env: Record<string, string | undefined>): string {
  const prefix = seoriVars(home, env).map(([k, v]) => `${k}=${shq(v)}`).join(" ");
  return `${prefix} bun ${shq(CLI)}`;
}

export class Refusal extends Error {}

/**
 * A ulw-plan lane started without ceiling flags: the configured defaults, with supervision.ulwPlan filling the token and
 * wall-clock ceilings they leave off (its review rounds have no cap of their own). Undefined when nothing changes.
 */
export function ulwPlanCeilings(config: SeoriConfig): Ceilings | undefined {
  const defs = config.supervision.defaults;
  const plan = config.supervision.ulwPlan;
  const c: Ceilings = { wallMinutes: defs.wallMinutes ?? plan.wallMinutes, tokens: defs.tokens ?? plan.tokens, costUsd: defs.costUsd };
  return c.wallMinutes === defs.wallMinutes && c.tokens === defs.tokens ? undefined : c;
}

/**
 * Refuses a workflow whose omp extension is not enabled, before any pane opens: a kickoff with the keyword but without
 * the extension would hand the lane a goal that starts with a meaningless word. `fromConfig`: the workflow came from
 * config.json, so the way out is that setting or `--workflow none`, not leaving the flag off.
 */
export async function requireWorkflowExtension(d: Deps, workflow: Workflow, fromConfig = false): Promise<void> {
  const what = fromConfig ? `config.json "workflow" is "${workflow}"` : `--workflow ${workflow}`;
  const instead = fromConfig ? `remove "workflow" from config.json, or start the lane with --workflow none` : "start the lane without --workflow";
  let listed: { npm?: { name?: unknown; enabled?: unknown }[]; marketplace?: { name?: unknown; enabled?: unknown }[] };
  try {
    const r = await d.exec(d.agentCmd, ["plugin", "list", "--json"]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
    listed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Refusal(`${what}: could not list omp's plugins to check for the omp-ulw extension (${d.agentCmd} plugin list --json: ${e instanceof Error ? e.message : String(e)}); fix that, or ${instead}`);
  }
  const plugins = [...(listed.npm ?? []), ...(listed.marketplace ?? [])];
  if (!plugins.some((p) => p.name === "omp-ulw" && p.enabled === true)) {
    throw new Refusal(`${what}: the omp-ulw extension is not enabled in omp (${d.agentCmd} plugin list); install it from ${OMP_ULW_URL}, or ${instead}`);
  }
}

/**
 * Starts the agent in a session, with `--model model` (a lane's own `seori start --model`, else SEORI_MODEL) when one
 * is set.
 */
export async function startAgent(d: Deps, ref: SessionRef, args: readonly string[] = [], model = d.model): Promise<void> {
  await d.runtime.startAgent(ref, [...args, ...(model ? ["--model", model] : [])]);
}

const sysctlMemoryLevel = (): string => execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 */
export function memFreePct(
  platform: string = process.platform,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (platform === "darwin") {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}

/** `SEORI_PROMPTS_DIR` when set, else the repo's `prompts/`. */
export const promptsDir = (): string => process.env["SEORI_PROMPTS_DIR"] || PROMPTS;

const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(promptsDir(), name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

// ---------- pane messaging ----------

// A pane with no running agent (`shell`) is never ready: text typed into a bare shell runs as a command (#66).
const READY_TO_READ: readonly AgentStatus[] = ["idle", "done"];

/**
 * A lane in goal mode stays `working` until its goal ends (the agent continues the goal right after every turn), so it
 * also reads while working: the agent takes a prompt into a working session as a steer and loses nothing. Never while
 * `blocked` (a dialog is open). Lead and duty panes wait for idle, so their messages arrive batched.
 */
function readyToRead(d: Deps, to: SessionRef, status: AgentStatus): boolean {
  if (READY_TO_READ.includes(status)) return true;
  return status === "working" && d.store.lanes().some((l) => sameSession(l.sessionRef, to) && l.status !== "done" && l.status !== "lost");
}

export type SendResult = "DELIVERED" | "QUEUED" | "HELD";

/**
 * Delivers now when the pane can read (see readyToRead); otherwise queues it for the duty loop.
 * The command-line path: an uncertain delivery is a result, never an error (see settled).
 */
export async function send(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  return settled(sendOrThrow(d, target, text, from));
}

/** send for the duty and hourly loops: throws DeliveryUncertain, having recorded it, so they report the failure. */
async function sendOrThrow(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  const to = resolveTarget(d, target);
  d.store.enqueue(to, { at: d.now(), from, text });
  return (await flushInbox(d, to)) === "delivered" ? "DELIVERED" : "QUEUED";
}

/**
 * An uncertain delivery is already recorded on the queued message (#89), so on the command-line path it is a result:
 * a sender who saw a failure would send again. `HELD`: it may or may not have reached the pane and is not resent.
 */
async function settled<T extends SendResult | undefined>(delivery: Promise<T>): Promise<T | "HELD"> {
  try {
    return await delivery;
  } catch (e) {
    if (e instanceof DeliveryUncertain) return "HELD";
    throw e;
  }
}

/**
 * `seori send --to-shell`: the operator's per-message opt-in to type this one message into a pane with no agent.
 * Only the CLI flag reaches here, never relayed content, and queued messages are never typed with it. If an agent
 * is in the pane, or appears before typing, the message takes the queued agent path instead.
 */
export async function sendToShell(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  const to = resolveTarget(d, target);
  if ((await d.runtime.status(to)) !== "shell") return send(d, target, text, from);
  if (await d.runtime.typeIntoShell(to, text)) return "DELIVERED";
  d.store.enqueue(to, { at: d.now(), from, text });
  return "QUEUED";
}

/**
 * Delivers a pane's queued messages as one batch. `held`: only messages held after an ambiguous delivery are left;
 * they wait for a person or the lead (#89). `queued` also when another flush of this pane holds its inbox lock: one
 * flush per pane at a time, across processes (#108). Throws DeliveryUncertain, having recorded the attempt on the
 * queued messages, when the batch may already have reached the pane, and Refusal when the pane is gone.
 */
export async function flushInbox(d: Deps, to: SessionRef): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  if (d.store.queued(to).length === 0) return "delivered";
  const release = d.store.lockInbox(to, d.now());
  if (!release) return "queued";
  try {
    return await flushLocked(d, to);
  } finally {
    release();
  }
}

async function flushLocked(d: Deps, to: SessionRef): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  // Re-read under the lock: the flush that held it may have delivered these meanwhile.
  const all = d.store.queued(to);
  if (all.length === 0) return "delivered";
  const queued = all.filter((m) => m.attempt?.state !== "ambiguous");
  const status = await d.runtime.status(to);
  // Before the held check, so a gone pane with only held messages says so instead of delivery-ambiguous forever (#108).
  if (status === "gone") throw new Refusal(`pane ${refText(to)} is gone; ${all.length} message(s) kept in its inbox`);
  if (queued.length === 0) return "held";
  if (status === "shell") return "no-agent";
  if (!readyToRead(d, to, status)) return "queued";
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  try {
    // Typed only under the status just read (hc compares and sends in one step): a goal-mode lane takes it while working.
    if (!(await deliverOrThrow(d.runtime, to, body, { when: status === "working" ? "working" : "idle" }))) return "no-agent";
  } catch (e) {
    if (e instanceof DeliveryUncertain) await recordUncertain(d, to, queued, e);
    throw e;
  }
  settleInbox(d, to, queued);
  return "delivered";
}

/** Re-reads the inbox and drops the batch (delivered) or marks it with the failed attempt; messages queued meanwhile stay. */
function settleInbox(d: Deps, to: SessionRef, batch: readonly QueuedMessage[], attempt?: DeliveryAttempt): void {
  const left = [...batch];
  d.store.rewriteInbox(to, (msgs) =>
    msgs.flatMap((m) => {
      const i = left.findIndex((b) => b.at === m.at && b.from === m.from && b.text === m.text);
      if (i < 0) return [m];
      left.splice(i, 1);
      return attempt ? [{ ...m, attempt }] : [];
    }),
  );
}

const NOTICE_FROM = "seori-delivery";

/**
 * Records an uncertain delivery on the queued messages: the batch is held and the lead is told once; held messages are
 * never retried, so the notice is never repeated. A notice that itself fails ambiguously is held without another
 * notice, so this cannot loop.
 */
async function recordUncertain(d: Deps, to: SessionRef, batch: readonly QueuedMessage[], e: DeliveryUncertain): Promise<void> {
  const detail = failureDetail(e);
  settleInbox(d, to, batch, { at: d.now(), state: "ambiguous", detail });
  await noticeHeld(d, to, batch, `hc said: ${detail}`);
}

async function noticeHeld(d: Deps, to: SessionRef, batch: readonly QueuedMessage[], why: string): Promise<void> {
  if (batch.every((m) => m.from === NOTICE_FROM)) return;
  const which = batch.map((m) => `from ${m.from} queued ${new Date(m.at).toISOString()}`).join(", ");
  const text =
    `[DELIVERY-AMBIGUOUS ${refText(to)}] ${batch.length} message(s) (${which}) may or may not have reached the pane; ${why}. ` +
    `Held and not resent. Check the pane and see seori inbox list ${refText(to)}: if it did not arrive, seori inbox resend ${refText(to)} <index>; if it did, seori inbox ack ${refText(to)} <index>.`;
  try {
    await tellLead(d, text, NOTICE_FROM);
  } catch (err) {
    process.stderr.write(`seori: telling the lead about the ambiguous delivery to ${refText(to)} failed too (${failureDetail(err)}); the notice is kept in the lead's inbox\n`);
  }
}

// ---------- held entries (#108) ----------

export type InboxEntry = { index: number; state: "queued" | "held"; from: string; at: number; preview: string };

const PREVIEW_CHARS = 60;

/** A pane's queued messages, 1-based in inbox order. The text is never shown whole: its first 60 characters, JSON-escaped. */
export function inboxList(d: Deps, target: string): { to: SessionRef; entries: InboxEntry[] } {
  const to = resolveTarget(d, target);
  const entries = d.store.queued(to).map((m, i): InboxEntry => ({
    index: i + 1,
    state: m.attempt?.state === "ambiguous" ? "held" : "queued",
    from: m.from,
    at: m.at,
    preview: JSON.stringify(m.text.slice(0, PREVIEW_CHARS)) + (m.text.length > PREVIEW_CHARS ? "..." : ""),
  }));
  return { to, entries };
}

/**
 * `ack` drops a held entry (it did arrive); `resend` clears its attempt so the next flush delivers it (it did not).
 * Only held entries: a queued one is delivered anyway. Runs under the
 * inbox lock, so a flush in progress cannot overwrite the change.
 */
export function releaseHeld(d: Deps, target: string, index: number, how: "ack" | "resend"): string {
  const to = resolveTarget(d, target);
  const release = d.store.lockInbox(to, d.now());
  if (!release) throw new Refusal(`the inbox of ${refText(to)} is being flushed right now; try again`);
  try {
    d.store.rewriteInbox(to, (msgs) => {
      const m = Number.isInteger(index) ? msgs[index - 1] : undefined;
      if (!m) throw new Refusal(`no entry ${index} in the inbox of ${refText(to)} (${msgs.length} entries; see seori inbox list ${target})`);
      if (m.attempt?.state !== "ambiguous") throw new Refusal(`entry ${index} of ${refText(to)} is not held; only held entries can be acked or resent`);
      const { attempt: _, ...fresh } = m;
      return how === "ack" ? msgs.filter((_, i) => i !== index - 1) : msgs.map((x, i) => (i === index - 1 ? fresh : x));
    });
    return refText(to);
  } finally {
    release();
  }
}

/** The lead delivery's result, or undefined when no lead is registered. Throws DeliveryUncertain like sendOrThrow. */
export async function tellLead(d: Deps, text: string, from: string): Promise<"DELIVERED" | "QUEUED" | undefined> {
  if (!d.store.roles().lead) {
    process.stderr.write(`seori: no lead pane registered; message kept only in the lane log\n`);
    return undefined;
  }
  return sendOrThrow(d, "lead", text, from);
}

// ---------- lanes ----------

/**
 * Opens a lane: a session running the agent in goal mode on the brief. `done` is the lane's Done line (src/signals.ts),
 * checked before anything opens; with it, seori closes the lane on its own after READY (src/done-flow.ts). `thread`
 * is the lead channel id progress posts thread under; `ceilings` override the configured supervision defaults;
 * `activityPaths` are files or directories whose change counts as the lane's progress besides git status; `model`
 * is the model this lane's omp runs with instead of SEORI_MODEL.
 */
export async function startLane(d: Deps, key: string, briefFile: string, opts: StartOptions = {}): Promise<Lane> {
  const started = await openLaneSession(d, key, briefFile, opts);
  if (!started.took) {
    process.stderr.write(`seori: lane ${key}: ${d.agent.kind} in ${refText(started.lane.sessionRef)} has not started on the kickoff; check that pane\n`);
  }
  return started.lane;
}

/** `workflow`: the lane's workflow (src/workflow.ts); null starts stock omp goal mode whatever config.json says. */
export type StartOptions = {
  cwd?: string; done?: string; thread?: string; ceilings?: Ceilings; activityPaths?: readonly string[]; model?: string;
  workflow?: Workflow | null;
};

/**
 * What startLane does, without the warning for a kickoff omp has not started on: the saved lane, when the kickoff
 * went in (`kickedAt`) and whether omp was seen starting on it (`took`). `seori start` goes on to its startup verdict
 * (src/startup-verdict.ts) instead of warning.
 */
export async function openLaneSession(d: Deps, key: string, briefFile: string, opts: StartOptions = {}): Promise<{ lane: Lane; kickedAt: number; took: boolean }> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost") throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
  // Stored without a leading `Done =`, which the footer adds back.
  const doneLine = opts.done?.trim().replace(/^Done\s*=\s*/i, "");
  if (opts.done !== undefined) parseDone(opts.done);
  if (opts.thread !== undefined && !opts.thread.trim()) throw new Refusal("--thread needs a lead channel id");
  if (opts.activityPaths?.some((p) => !p.trim())) throw new Refusal("--activity-path needs a path");
  if (opts.model !== undefined && !opts.model.trim()) throw new Refusal("--model needs a model name");
  const workflow = opts.workflow === undefined ? loadConfig(d.store.root).workflow : (opts.workflow ?? undefined);
  if (workflow !== undefined) await requireWorkflowExtension(d, workflow, opts.workflow === undefined);
  const ceilings = opts.ceilings ?? (workflow === "ulw-plan" ? ulwPlanCeilings(loadConfig(d.store.root)) : undefined);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const closeAfterMin = doneLine === undefined ? 0 : loadConfig(d.store.root).closeAfterMin;
  const footer = prompt("lane-footer.md", { key, seori: d.seoriCmd, close_rule: closeRule(d.seoriCmd, key, doneLine, closeAfterMin) });
  const lessons = lessonsForRepo(d.store.root, cwd);
  for (const line of lessonWarnings(lessons.problems)) process.stderr.write(`${line}\n`);
  // The lead may pass briefs/<key>.md itself (e.g. on a retry): drop the lessons block and the footer seori already
  // added, whatever the path, so the brief always carries exactly one of each.
  const source = readFileSync(briefFile, "utf8").replace(LESSONS_RE, "").replace(FOOTER_RE, "").trimEnd();
  await Bun.write(briefPath, `${renderLessons(lessons.lessons)}${source}\n\n${footer}`);

  const env = { SEORI_LANE: key, ...paneEnv(d.store.root), ...d.agent.agentEnv(d.store.root) };
  const rt = d.runtime;
  const ref = await rt.create({ name: key, cwd, env, role: "lane", group: loadConfig(d.store.root).name, home: d.store.root });
  let kickedAt = 0;
  let took = false;
  try {
    await startAgent(d, ref, [], opts.model?.trim() ?? d.model);
    if (!(await deliverOrThrow(rt, ref, d.agent.kickoff(briefPath, key, workflow === undefined ? undefined : workflowPrefix(workflow))))) throw new Error(`${d.agent.kind} was not in front of the pane to take the kickoff`);
    kickedAt = d.now();
    took = await kickoffTook(d, ref);
  } catch (e) {
    await rt.close(ref).catch(() => undefined);
    throw new Refusal(`lane ${key} did not start, pane ${refText(ref)} closed: ${failureDetail(e)}`);
  }

  const now = d.now();
  const lane: Lane = {
    key, sessionRef: ref, paneId: ref.id, tabId: "", brief: briefPath, cwd,
    status: "working", createdAt: now, lastActivityAt: now, nudges: 0,
    ...(doneLine !== undefined ? { done: doneLine } : {}),
    ...(opts.thread !== undefined ? { thread: opts.thread.trim() } : {}),
    ...(ceilings ? { ceilings } : {}),
    ...(opts.activityPaths?.length ? { activityPaths: [...opts.activityPaths] } : {}),
    ...(opts.model !== undefined ? { model: opts.model.trim() } : {}),
    ...(workflow !== undefined ? { workflow } : {}),
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${refText(ref)}`, key);
  return { lane, kickedAt, took };
}

/** How long a lane start waits for omp to start on the kickoff. */
export const KICKOFF_TAKE_MS = 20_000;
const KICKOFF_POLL_MS = 500;

/** Whether omp started on the kickoff (hc reports it working, done or on a dialog) within KICKOFF_TAKE_MS. */
async function kickoffTook(d: Deps, ref: SessionRef): Promise<boolean> {
  const until = d.now() + KICKOFF_TAKE_MS;
  for (;;) {
    const status = await d.runtime.status(ref);
    if (status === "working" || status === "done" || status === "blocked") return true;
    if (d.now() >= until) return false;
    await d.sleep(KICKOFF_POLL_MS);
  }
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(d: Deps, key: string, text: string, status?: "working" | "waiting"): Promise<SendResult | undefined> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  // Activity never ends a pause (only seori resume does): a paused lane woken by a watch or a message may report, but
  // its status stays paused so duty keeps leaving it alone and resume still works.
  if (status && lane.status !== "paused") lane.status = status;
  d.store.saveLane(lane);
  void runHook(d, "onReport", { key, text, evidence: "" });
  return settled(tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

/**
 * Records the lane's final answer (its done claim) and tells the lead. A new READY clears an earlier objection. A
 * lane with a Done line is also told when it closes: closeAfterMin after this claim, unless the lead objects.
 */
export async function ready(d: Deps, key: string, text: string, evidence: readonly string[]): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const closeAfterMin = lane.done === undefined ? undefined : loadConfig(d.store.root).closeAfterMin;
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  delete lane.objection;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  const claim = closeAfterMin === undefined ? "" : `\n${claimLeadLine(d.seoriCmd, key, closeAfterMin)}`;
  const result = await settled(tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}${claim}`, key));
  void runHook(d, "onReady", { key, text, evidence: evidence.join(" ") });
  if (closeAfterMin !== undefined) await send(d, key, claimText(closeAfterMin), "lead");
  return result;
}

/**
 * The lead closes a READY lane. A lane with a Done line closes only when checkSignals finds nothing: every signal
 * reads back live and no tracked work is uncommitted or on no remote; otherwise the refusal lists the reasons.
 */
export async function done(d: Deps, key: string): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done") {
    // Duty's done window or an earlier `seori done` closed it: nothing is left to close.
    const closed = lane.log.findLast((e) => e.kind === "done");
    const how = closed ? ` at ${new Date(closed.at).toISOString()} (${closed.text})` : "";
    throw new Refusal(`lane ${key} is already closed${how}; see its final state with: ${d.seoriCmd} status (record: ${join(d.store.root, "lanes", `${key}.json`)})`);
  }
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  const st = await d.runtime.status(lane.sessionRef);
  if (st === "working" || st === "blocked") throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (lane.done !== undefined) {
    const failures = await checkSignals(d, lane);
    if (failures.length) throw new Refusal(`lane ${key} is not done:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  }
  // The lead may have objected, paused it or a new READY may have come in while its pane and signals were read.
  const fresh = sameClaim(d, lane);
  if (!fresh) throw new Refusal(`lane ${key} changed while it was being checked (now ${d.store.lane(key)?.status ?? "gone"}); run done again`);
  await closeLane(d, fresh, lane.done === undefined ? "closed by lead" : "closed by lead: every Done signal read back live");
}

// ---------- duty loop ----------

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** A short one-line reason. A ToolError message carries the whole argv (the queued text), so use the runtime's own output. */
function failureDetail(e: unknown): string {
  if (e instanceof DeliveryUncertain) e = e.failure;
  const raw = e instanceof ToolError ? e.result.stderr || e.result.stdout : e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

/** A lane duty still supervises: working or waiting. */
const dutyOwned = (lane: Lane | undefined): lane is Lane =>
  lane !== undefined && (lane.status === "working" || lane.status === "waiting");

/**
 * Re-reads the lane, applies `change` and saves it, but only while duty still owns it: a pause, report, ready or done
 * written by another process during the pass is kept, never overwritten by an older copy. Returns the saved lane.
 */
function updateDutyLane(d: Deps, key: string, change: (lane: Lane) => void): Lane | undefined {
  const lane = d.store.lane(key);
  if (!dutyOwned(lane)) return undefined;
  change(lane);
  d.store.saveLane(lane);
  return lane;
}

/** One proactive pass: flush inboxes of panes that became idle, nudge lanes with no recent report, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  for (const to of d.store.inboxPanes()) {
    const paneId = refText(to);
    try {
      const result = await flushInbox(d, to);
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "no-agent") {
        events.push({ pane: paneId, action: "inbox-held", detail: `no agent in front; ${d.store.queued(to).length} message(s) kept` });
      }
      // Held after an ambiguous delivery (#89): shown on every pass, resent never; the lead was told once.
      const held = d.store.queued(to).filter((m) => m.attempt?.state === "ambiguous").length;
      if (held > 0) events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else if (e instanceof DeliveryUncertain) events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const listed of d.store.lanes()) {
    if (!dutyOwned(listed)) continue;
    try {
      const st = await d.runtime.status(listed.sessionRef);
      const now = d.now();
      // Re-read: a pause, report, ready or done may have landed while the pane was read (or an earlier lane nudged).
      const lane = d.store.lane(listed.key);
      if (!dutyOwned(lane)) continue;
      if (st === "gone") {
        const lost = updateDutyLane(d, lane.key, (l) => {
          l.status = "lost";
          l.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
        });
        if (!lost) continue;
        void runHook(d, "onLost", { key: lane.key, text: "pane disappeared without READY", evidence: "" });
        await tellLead(d, `[LOST ${lane.key}] pane ${refText(lane.sessionRef)} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      // A goal-mode lane reads `working` until its goal ends, so `working` is not progress: staleness counts from the
      // last lane activity seori records (start, report, ready). Delivery to a working lane pane is a steer.
      // A dialog (a tool approval) is open: nothing is sent to the lane, a long wait is told to the lead once.
      if (st === "blocked") {
        await blockedPrompt(d, lane, now, events);
        continue;
      }
      if (lane.blockedSince !== undefined) {
        updateDutyLane(d, lane.key, (l) => {
          delete l.blockedSince;
          if (l.alerts) for (const k of Object.keys(l.alerts)) if (k.startsWith("blocked-prompt:")) delete l.alerts[k];
        });
      }
      if (lane.status === "waiting") continue;
      const silentMin = (now - lane.lastActivityAt) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || silentMin < due) continue;
      const nudged = updateDutyLane(d, lane.key, (l) => {
        l.nudges += 1;
        l.log.push({ at: now, kind: "nudge", text: `no report ${Math.floor(silentMin)} min` });
      });
      if (!nudged) continue;
      if (nudged.nudges < NUDGE_MINUTES.length) {
        await sendOrThrow(d, lane.key, prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(silentMin)), seori: d.seoriCmd }), "duty");
        events.push({ lane: lane.key, action: `nudge-${nudged.nudges}` });
      } else {
        await tellLead(d, `[ESCALATE ${lane.key}] no report for ${Math.floor(silentMin)} min after ${nudged.nudges - 1} nudges`, "duty");
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: listed.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  try {
    await channelAlerts(d, events);
  } catch (e) {
    // An unwritable lead dir must not stop lane and inbox duty (a broken messengers.json is told to the lead, not thrown).
    events.push({ action: "channel-failed", detail: failureDetail(e) });
  }
  // Stuck reply drafts, the done window, ceilings and stalls, the host guard and progress posts: each its own module,
  // each guarded so one failing never stops the others.
  const ticks: [string, (d: Deps) => Promise<DutyEvent[]>][] = [
    ["drafts", draftsTick], ["autoclose", autoCloseTick], ["supervise", superviseTick], ["guard", guardTick], ["progress", progressTick],
  ];
  for (const [name, tick] of ticks) {
    try {
      events.push(...(await tick(d)));
    } catch (e) {
      events.push({ action: `${name}-failed`, detail: failureDetail(e) });
    }
  }
  return events;
}

/** The default of config.json's blockedPromptMin: a lane whose pane shows a dialog this long is told as [BLOCKED-PROMPT]. */
export const BLOCKED_PROMPT_MINUTES = DEFAULT_CONFIG.blockedPromptMin;

/**
 * Records when a lane's pane was first seen `blocked` (blockedSince) and, once it has stayed blocked for
 * blockedPromptMin (config.json, default BLOCKED_PROMPT_MINUTES), tells the lead once per blocked spell. Nothing goes to the lane: an Enter would answer the
 * dialog. A pane that is no longer blocked clears blockedSince (dutyTick), so a later dialog is a new spell.
 */
async function blockedPrompt(d: Deps, lane: Lane, now: number, events: DutyEvent[]): Promise<void> {
  if (lane.blockedSince === undefined) {
    updateDutyLane(d, lane.key, (l) => {
      l.blockedSince = now;
    });
    return;
  }
  const key = `blocked-prompt:${lane.blockedSince}`;
  if (lane.alerts?.[key] !== undefined || now - lane.blockedSince < loadConfig(d.store.root).blockedPromptMin * 60_000) return;
  const waited = now - lane.blockedSince;
  // A threshold under a minute (a short test setting) is told in seconds, not as "0 min".
  const minutes = waited >= 60_000 ? `${Math.floor(waited / 60_000)} min` : `${Math.round(waited / 1000)} s`;
  const text = `[BLOCKED-PROMPT ${lane.key}] pane ${refText(lane.sessionRef)} waits on a dialog (a tool approval or question) for ${minutes}; nothing is sent to the lane while it is open`;
  // Marked before telling: tellLead queues the notice in the lead's inbox first, so it is not lost if delivery waits.
  const marked = updateDutyLane(d, lane.key, (l) => {
    l.alerts = { ...(l.alerts ?? {}), [key]: now };
    l.log.push({ at: now, kind: "blocked", text });
  });
  if (!marked) return;
  await tellLead(d, text, "duty");
  events.push({ lane: lane.key, action: "blocked-prompt", detail: minutes });
}

// ---------- lead channel alerts ----------

/** The daemon rewrites its heartbeat at least every 10 s; 90 s without one is an outage, not a slow write. */
export const HEARTBEAT_STALE_MS = 90_000;
/** How long a message may wait (offline lead) or sit delivered (blocked lead) before the human is told. */
export const ALERT_AFTER_MS = 2 * 60_000;

export const ALERT_TEXT = {
  "lead-offline": "seori: the lead is offline; your message is kept and will be answered when it is back.",
  // `blocked` is reported both for a question in the terminal and after a turn that ended in a provider error, so the
  // text names both; the extension keeps redelivering in the error case.
  "lead-blocked": "seori: the lead is stuck (a question in its terminal, or its model is failing); your message is queued and will be retried.",
  "gave-up": "seori: the lead could not answer this after 3 tries; please check the terminal.",
} as const;
type AlertWhy = keyof typeof ALERT_TEXT;

/** `lead/duty-alerts.json`: alert state that is not per message id, so an outage or a breakage is told once, not every tick. */
type DutyAlerts = { daemonDownSince?: number; configBrokenSince?: number; messengerFailing?: Record<string, number>; draftsTold?: string[] };

/** An open reply draft this old was not released at a turn end (a crashed turn, a failed flush): the lead is told. */
export const DRAFTS_ALERT_MS = 5 * 60_000;

/**
 * Tells the lead once per draft about open outbox drafts older than DRAFTS_ALERT_MS. Leftovers are not flushed on
 * their own: the turn that drafted them may have crashed half-done, so the lead decides whether they go out. Told
 * drafts are kept in duty-alerts.json only while they stay open.
 */
async function draftsTick(d: Deps): Promise<DutyEvent[]> {
  const open = new Outbox(d.store.root).open();
  const state = readJsonFile<DutyAlerts>(dutyAlertsPath(d.store.root)) ?? {};
  const told = (state.draftsTold ?? []).filter((id) => open.some((o) => o.draft === id));
  const due = open.filter((o) => !told.includes(o.draft) && d.now() - o.at > DRAFTS_ALERT_MS).map((o) => o.draft);
  const events: DutyEvent[] = [];
  if (due.length) {
    let delivered = true;
    try {
      await tellLead(d, `[DRAFTS] ${due.length} reply draft(s) not sent: ${due.join(", ")}; send them with ${d.seoriCmd} msg flush or drop them with ${d.seoriCmd} msg drop <draft> --why '...'`, "duty");
    } catch (e) {
      // As daemonAlert: an uncertain delivery is held with the lead told, so those drafts count as told.
      if (!(e instanceof DeliveryUncertain)) {
        delivered = false;
        events.push({ action: "drafts-alert-failed", detail: failureDetail(e) });
      }
    }
    if (delivered) {
      told.push(...due);
      events.push({ action: "drafts-alerted", detail: due.join(", ") });
    }
  }
  const before = state.draftsTold ?? [];
  if (told.length !== before.length || told.some((id, i) => before[i] !== id)) {
    // Re-read: another alert may have saved its own field in between.
    const latest = readJsonFile<DutyAlerts>(dutyAlertsPath(d.store.root)) ?? {};
    delete latest.draftsTold;
    saveDutyAlerts(d.store.root, told.length ? { ...latest, draftsTold: told } : latest);
  }
  return events;
}

/** A messenger whose receive has failed for this long (bad token, another consumer, a platform outage) is told to the lead. */
export const MESSENGER_FAILING_ALERT_MS = 3 * 60_000;

const dutyAlertsPath = (root: string): string => join(root, "lead", "duty-alerts.json");

const saveDutyAlerts = (root: string, next: DutyAlerts): void => {
  const path = dutyAlertsPath(root);
  mkdirSync(join(root, "lead"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
};

const readJsonFile = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

/**
 * Messenger alerts, only when a messenger is configured (or messengers.json is there but broken): a broken config and a
 * daemon outage go to the lead, then per-id alerts go to the human. A broken config has no messenger to reply through,
 * so it skips the per-id alerts, but the outage check still runs: the daemon cannot start on that file.
 * Watch rows have no chat to alert in and nobody waits on them: the lead extension closes one once it is seen or has
 * given up (the watch itself stays in `seori watch list`), so they are left out here.
 */
async function channelAlerts(d: Deps, events: DutyEvent[]): Promise<void> {
  let messengers: MessengerConfig[] = [];
  let broken: string | undefined;
  try {
    messengers = loadMessengers(d.store.root);
  } catch (e) {
    broken = failureDetail(e);
  }
  await configAlert(d, broken, events);
  if (messengers.length === 0 && broken === undefined) return;
  const channel = new Channel(d.store.root);
  const now = d.now();
  await daemonAlert(d, now, events);
  await messengerAlerts(d, messengers, now, events);
  if (broken !== undefined) return;

  const open = channel.open().filter((s): s is IdState & { readonly row: MessengerRow } => s.row.kind === "messenger");
  // Send-uncertain and gave-up ids are final: they are never delivered again, so "kept" or "queued" would be false.
  const waiting = open.filter((s) => !s.uncertain && !s.gaveUp);
  const waited = (at: number | undefined): boolean => at !== undefined && now - at > ALERT_AFTER_MS;
  const due: [IdState & { readonly row: MessengerRow }, AlertWhy][] = [];
  // A drafted id still waits while no lead is consuming: only the lead extension sends drafts, so the owner is told.
  const offline = waiting.filter((s) => !s.alerted.includes("lead-offline") && waited(s.row.at));
  if (offline.length && channel.consumerOffline()) due.push(...offline.map((s): [typeof s, AlertWhy] => [s, "lead-offline"]));
  // A live lead's drafted id is answered: its reply goes out when the turn ends (duty's [DRAFTS] alert covers a stuck one).
  const stuck = waiting.filter((s) => !s.drafted && !s.alerted.includes("lead-blocked") && waited(s.lastDeliveredAt));
  const lead = d.store.roles().lead;
  if (stuck.length && lead) {
    try {
      if ((await d.runtime.status(lead)) === "blocked") due.push(...stuck.map((s): [typeof s, AlertWhy] => [s, "lead-blocked"]));
    } catch (e) {
      events.push({ pane: refText(lead), action: "lead-status-failed", detail: failureDetail(e) });
    }
  }
  for (const s of open) if (s.gaveUp && !s.drafted && !s.alerted.includes("gave-up")) due.push([s, "gave-up"]);

  for (const [s, why] of due) {
    const { id, source, chat, thread } = s.row;
    const config = messengers.find((m) => m.source === source);
    if (!config) {
      events.push({ action: "alert-failed", detail: `${id} ${why}: no messenger configured for source ${source}` });
      continue;
    }
    // Ids are `<source>:<chat>:<message id>`; the messenger replies to its own message id.
    const prefix = `${source}:${chat}:`;
    const target: SendTarget = { chat, ...(thread !== undefined ? { thread } : {}), replyTo: id.startsWith(prefix) ? id.slice(prefix.length) : id };
    try {
      await d.notify(config, target, ALERT_TEXT[why]);
    } catch (e) {
      // An uncertain send may have reached the human and is never retried (the adapter contract); a definite failure
      // stays unrecorded so the next tick tries again.
      if (!(e instanceof SendUncertain)) {
        events.push({ action: "alert-failed", detail: `${id} ${why}: ${failureDetail(e)}` });
        continue;
      }
      events.push({ action: "alert-uncertain", detail: `${id} ${why}: ${failureDetail(e)}` });
    }
    channel.appendLedger({ id, ev: "alerted", at: now, why });
    events.push({ action: "alerted", detail: `${id} ${why}` });
  }
}

/** Tells the lead once per breakage that messengers.json does not load; a file that loads again ends it. */
async function configAlert(d: Deps, broken: string | undefined, events: DutyEvent[]): Promise<void> {
  const state = readJsonFile<DutyAlerts>(dutyAlertsPath(d.store.root)) ?? {};
  if (broken === undefined) {
    if (state.configBrokenSince === undefined) return;
    const { configBrokenSince, ...rest } = state;
    saveDutyAlerts(d.store.root, rest);
    events.push({ action: "config-fixed", detail: `broken ${Math.floor((d.now() - configBrokenSince) / 1000)} s` });
    return;
  }
  if (state.configBrokenSince !== undefined) return;
  try {
    await tellLead(d, `[MESSENGER] messengers.json is invalid (${broken}); the daemon cannot start, so messenger messages are not received until it is fixed`, "duty");
  } catch (e) {
    // Same as daemonAlert: an uncertain delivery is recorded and held with the lead told, so the breakage counts as told.
    if (!(e instanceof DeliveryUncertain)) {
      events.push({ action: "config-alert-failed", detail: failureDetail(e) });
      return;
    }
  }
  saveDutyAlerts(d.store.root, { ...state, configBrokenSince: d.now() });
  events.push({ action: "config-broken", detail: broken });
}

/** Tells the lead once per outage that the daemon is down (nothing is received meanwhile); a fresh heartbeat ends it. */
async function daemonAlert(d: Deps, now: number, events: DutyEvent[]): Promise<void> {
  const state = readJsonFile<DutyAlerts>(dutyAlertsPath(d.store.root)) ?? {};
  const beat = readJsonFile<{ at?: unknown }>(join(d.store.root, "messenger", "daemon.heartbeat"));
  const age = typeof beat?.at === "number" ? now - beat.at : undefined;
  if (age !== undefined && age <= HEARTBEAT_STALE_MS) {
    if (state.daemonDownSince === undefined) return;
    const { daemonDownSince, ...rest } = state;
    saveDutyAlerts(d.store.root, rest);
    events.push({ action: "daemon-up", detail: `down ${Math.floor((now - daemonDownSince) / 1000)} s` });
    return;
  }
  if (state.daemonDownSince !== undefined) return;
  const detail = age === undefined ? "no heartbeat" : `last heartbeat ${Math.floor(age / 1000)} s ago`;
  try {
    await tellLead(d, `[MESSENGER] seori daemon is down (${detail}); messenger messages are not received until it runs again`, "duty");
  } catch (e) {
    // DeliveryUncertain is recorded and held with the lead told (see recordUncertain): the outage counts as told.
    if (!(e instanceof DeliveryUncertain)) {
      events.push({ action: "daemon-alert-failed", detail: failureDetail(e) });
      return;
    }
  }
  saveDutyAlerts(d.store.root, { ...state, daemonDownSince: now });
  events.push({ action: "daemon-down", detail });
}

/**
 * Tells the lead once per failure streak that a messenger cannot receive (the daemon's `messenger/<source>/health.json`,
 * written by src/daemon.ts while receive keeps failing), with the adapter's error so the owner knows what to fix; the
 * file disappearing ends the streak. Reads the file here rather than importing daemon.ts, which imports this module.
 * While the daemon is down its files are stale and daemonAlert already tells the lead, so no new streak is told then.
 */
async function messengerAlerts(d: Deps, messengers: readonly MessengerConfig[], now: number, events: DutyEvent[]): Promise<void> {
  const state = readJsonFile<DutyAlerts>(dutyAlertsPath(d.store.root)) ?? {};
  const told = { ...(state.messengerFailing ?? {}) };
  const beat = readJsonFile<{ at?: unknown }>(join(d.store.root, "messenger", "daemon.heartbeat"));
  const daemonUp = typeof beat?.at === "number" && now - beat.at <= HEARTBEAT_STALE_MS;
  let changed = false;
  for (const source of new Set([...messengers.map((m) => m.source), ...Object.keys(told)])) {
    const health = readJsonFile<{ failingSince?: unknown; error?: unknown; failures?: unknown }>(join(d.store.root, "messenger", source, "health.json"));
    const since = typeof health?.failingSince === "number" ? health.failingSince : undefined;
    if (since === undefined) {
      if (told[source] === undefined) continue;
      delete told[source];
      changed = true;
      events.push({ action: "messenger-recovered", detail: source });
      continue;
    }
    if (!daemonUp || told[source] !== undefined || now - since < MESSENGER_FAILING_ALERT_MS) continue;
    const minutes = Math.floor((now - since) / 60_000);
    try {
      await tellLead(d, `[MESSENGER] ${source} has not been able to receive for ${minutes} min (${String(health?.failures)} failures; last error: ${String(health?.error)}); messages sent there are not reaching you until this is fixed`, "duty");
    } catch (e) {
      if (!(e instanceof DeliveryUncertain)) {
        events.push({ action: "messenger-alert-failed", detail: `${source}: ${failureDetail(e)}` });
        continue;
      }
    }
    told[source] = now;
    changed = true;
    events.push({ action: "messenger-failing", detail: `${source}: ${String(health?.error)}` });
  }
  if (!changed) return;
  // Re-read: daemonAlert may have saved its own field in between.
  const latest = readJsonFile<DutyAlerts>(dutyAlertsPath(d.store.root)) ?? {};
  saveDutyAlerts(d.store.root, { ...latest, messengerFailing: told });
}

// ---------- review + merge gate ----------

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

/** A PR head that gh cannot read is a refusal with the cause, not a crash: the CLI maps Refusal to exit 2. */
async function headShaOrRefuse(d: Deps, pr: PrRef, code: string): Promise<string> {
  try {
    return await headSha(d, pr);
  } catch (e) {
    throw new Refusal(`${code} cannot read PR head: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type AssistantMessage = { role?: string; content?: unknown; stopReason?: string; provider?: string; model?: string };

/**
 * The reviewer's final answer from omp's `--mode json` event stream: the last assistant message of the last
 * `agent_end`, or the last assistant `message_end` when the run ended without one. Lines that are not JSON are skipped.
 */
export function reviewerAnswer(stdout: string): { text: string; stopReason?: string; model?: string } | undefined {
  let fromEnd: AssistantMessage | undefined;
  let fromMessage: AssistantMessage | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: { type?: string; messages?: AssistantMessage[]; message?: AssistantMessage };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) fromEnd = event.messages.findLast((m) => m?.role === "assistant");
    if (event.type === "message_end" && event.message?.role === "assistant") fromMessage = event.message;
  }
  const m = fromEnd ?? fromMessage;
  if (!m) return undefined;
  const parts = Array.isArray(m.content) ? (m.content as { type?: string; text?: unknown }[]) : [];
  const text = parts.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n");
  const model = m.model ? (m.provider ? `${m.provider}/${m.model}` : m.model) : undefined;
  return { text, ...(m.stopReason ? { stopReason: m.stopReason } : {}), ...(model ? { model } : {}) };
}

/**
 * Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. The
 * reviewer loads none of the cwd's extensions, skills, rules or context files, and no approval prompt can silently
 * deny its tools.
 */
export async function review(d: Deps, prId: string, model: string | undefined = d.model): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  // The reviewer is always omp: a hooks.reviewCommand left in config.json is refused here (exit 2), never ignored.
  loadHooks(d.store.root);
  const sha = await headShaOrRefuse(d, pr, "REVIEW_REFUSED");
  const text = prompt("review.md", { pr: pr.id, repo: pr.repo, number: String(pr.number), sha });
  const res = await d.exec(d.agentCmd, d.agent.reviewArgs(text, model));
  if (res.code === 3) throw new Error(`reviewer hit the cost cap: ${res.stderr.trim()}`);
  const answer = reviewerAnswer(res.stdout);
  if (answer?.stopReason === "aborted") throw new Error("reviewer stopped before finishing (deadline)");
  if (res.code !== 0) throw new Error(`reviewer exited ${res.code}: ${res.stderr.trim()}`);
  const verdicts = [...(answer?.text ?? "").matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = verdicts.at(-1);
  if (!last) {
    // Keep the reviewer's last 200 stdout lines (private, 0600) so a missing VERDICT can be diagnosed.
    const name = `${pr.id.replaceAll("/", "__").replace("#", "_")}@${sha}-${randomUUID()}.noverdict.txt`;
    const diagnostic = join(d.store.root, "receipts", name);
    writeFileSync(diagnostic, res.stdout.split(/\r?\n/).slice(-200).join("\n"), { flag: "wx", mode: 0o600 });
    throw new Error(`reviewer printed no VERDICT line; no receipt written; reviewer output saved to ${diagnostic}`);
  }
  const verdict = last[1] as "CLEAR" | "BLOCK";
  const summary = answer!.text.trim().slice(-4000);
  d.store.saveReceipt({ pr: pr.id, sha, verdict, model: answer!.model ?? model ?? "default", at: d.now(), summary });
  return { verdict, sha };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headShaOrRefuse(d, pr, "MERGE_REFUSED");
  const refused = await gateRefusal(d, pr, sha);
  if (refused) throw new Refusal(`MERGE_REFUSED ${refused}`);
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  return `MERGED ${pr.id} head=${sha}`;
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<string | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return `no review receipt at head ${sha.slice(0, 12)} (run: seori review ${pr.id})`;
  if (receipt.verdict !== "CLEAR") return `review at ${sha.slice(0, 12)} is ${receipt.verdict}`;
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return "no checks reported: an empty check list is never green";
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`;
  if (!checks.some((c) => c.bucket === "pass")) return "every check was skipped";
  // Commit identities and the fix-needs-a-test rule (src/verify-pr.ts); `gh pr merge --match-head-commit` still pins the head.
  const verified = await verifyPr(d, pr, loadConfig(d.store.root));
  if (!verified.ok) return `verify-pr failed:\n${verified.lines.join("\n")}`;
  return undefined;
}

export const ROLES: readonly Role[] = ["lead", "duty"];
