import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, freemem, hostname, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { Channel, type IdState } from "./channel.ts";
import { DeliveryUncertain, Herdr, HerdrError, shq, spawnExec, type AgentStatus, type Exec } from "./herdr.ts";
import { loadMessengers, SendUncertain, type MessengerConfig, type SendTarget } from "./messenger/adapter.ts";
import { adapterFor } from "./messenger/index.ts";
import { KEY_RE, pidAlive, reservedKey, Store, type DeliveryAttempt, type HostLoad, type Lane, type QueuedMessage, type Role } from "./store.ts";

export { KEY_RE, reservedKey };

export const NUDGE_MINUTES = [10, 20, 40] as const;
const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");
const FOOTER_RE = /(^|\n)## Lane rules \(added by seori for lane [\s\S]*$/;

export type Deps = {
  readonly store: Store;
  readonly herdr: Herdr;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly seoriCmd: string;
  readonly host: () => HostLoad;
  /** SEORI_MODEL: passed as `--model` to every omp seori starts (lead, duty, lanes) and the reviewer's default. */
  readonly model?: string;
  /** Sends one duty alert to the human through a configured messenger. Throws like MessengerAdapter.send. */
  readonly notify: (config: MessengerConfig, target: SendTarget, text: string) => Promise<void>;
};

export const defaultDeps = (): Deps => {
  const store = new Store();
  return {
    store,
    herdr: new Herdr(),
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["SEORI_AGENT_CMD"] ?? "omp",
    seoriCmd: process.env["SEORI_CMD"] ?? defaultSeoriCmd(store.root, process.env),
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    model: process.env["SEORI_MODEL"] || undefined,
    notify: async (config, target, text) => {
      await adapterFor(config, store.root).send(target, text);
    },
  };
};

/**
 * How agents and loop panes call seori. Panes do not inherit this process's env, so the command carries what selects
 * this seori: its home, the herdr session it drives and the model it starts omp with (the hourly loop starts lanes).
 */
export function defaultSeoriCmd(home: string, env: Record<string, string | undefined>): string {
  const vars: [string, string | undefined][] = [["SEORI_HOME", home], ["SEORI_HERDR_SESSION", env["SEORI_HERDR_SESSION"]], ["SEORI_MODEL", env["SEORI_MODEL"]]];
  const prefix = vars.filter(([, v]) => v).map(([k, v]) => `${k}=${shq(v!)}`).join(" ");
  return `${prefix} bun ${shq(CLI)}`;
}

export class Refusal extends Error {}

export const INTEGRATION_MISSING = "herdr's omp integration is not installed; run: herdr integration install omp";

/** seori reads agent status from herdr, which reports omp as always idle without its omp integration: refuse to start. */
export async function requireOmpIntegration(d: Deps): Promise<void> {
  if (!(await d.herdr.ompIntegration())) throw new Refusal(INTEGRATION_MISSING);
}

/** Starts omp in a pane via `herdr agent start`, named `<label>-<pane id>` so names stay unique across live agents. */
export async function startAgent(d: Deps, label: string, paneId: string, args: readonly string[] = []): Promise<void> {
  await d.herdr.agentStart(`${label}-${paneId.replaceAll(":", "")}`, paneId, [...args, ...(d.model ? ["--model", d.model] : [])]);
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

const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(PROMPTS, name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

// ---------- pane messaging ----------

export function resolveTarget(d: Deps, target: string): string {
  if (/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(target)) return target;
  const roles = d.store.roles();
  if (target === "lead" || target === "duty") {
    const pane = roles[target];
    if (!pane) throw new Refusal(`no ${target} pane registered (seori role ${target} <pane>)`);
    return pane;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.paneId;
  throw new Refusal(`unknown target ${target}: not a pane id, role or open lane`);
}

// A pane with no running agent (`shell`) is never ready: text typed into a bare shell runs as a command (#66).
const READY_TO_READ: readonly AgentStatus[] = ["idle", "done"];

/**
 * A lane in omp goal mode stays `working` until its goal ends (omp continues the goal right after every turn), so it
 * also reads while working: omp takes a prompt into a working agent as a steer and loses nothing. Never while
 * `blocked` (a dialog is open). Lead and duty panes wait for idle, so their messages arrive batched.
 */
function readyToRead(d: Deps, paneId: string, status: AgentStatus): boolean {
  if (READY_TO_READ.includes(status)) return true;
  return status === "working" && d.store.lanes().some((l) => l.paneId === paneId && l.status !== "done" && l.status !== "lost");
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
  const paneId = resolveTarget(d, target);
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return (await flushInbox(d, paneId)) === "delivered" ? "DELIVERED" : "QUEUED";
}

/**
 * An uncertain delivery is already recorded on the queued message (#89), so on the command-line path it is a result:
 * a sender who saw a failure would send again. `HELD`: it may or may not have reached the pane and is not resent.
 * `QUEUED`: typed text that only waits for its Enter.
 */
async function settled<T extends SendResult | undefined>(delivery: Promise<T>): Promise<T | "QUEUED" | "HELD"> {
  try {
    return await delivery;
  } catch (e) {
    if (e instanceof DeliveryUncertain) return e.typed ? "QUEUED" : "HELD";
    throw e;
  }
}

/**
 * `seori send --to-shell`: the operator's per-message opt-in to type this one message into a pane with no agent.
 * Only the CLI flag reaches here, never relayed content, and queued messages are never typed with it. If an agent
 * is in the pane, or appears before typing, the message takes the queued agent path instead.
 */
export async function sendToShell(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  const paneId = resolveTarget(d, target);
  if ((await d.herdr.status(paneId)) !== "shell") return send(d, target, text, from);
  if (await d.herdr.typeIntoShell(paneId, text)) return "DELIVERED";
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return "QUEUED";
}

/**
 * Delivers a pane's queued messages as one batch. `held`: only messages held after an ambiguous delivery are left;
 * they wait for a person or the lead (#89). `queued` also when another flush of this pane holds its inbox lock: one
 * flush per pane at a time, across processes (#108). Throws DeliveryUncertain, having recorded the attempt on the
 * queued messages, when the batch may already have reached the pane, and Refusal when the pane is gone.
 */
export async function flushInbox(d: Deps, paneId: string): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  if (d.store.queued(paneId).length === 0) return "delivered";
  const release = d.store.lockInbox(paneId, d.now());
  if (!release) return "queued";
  try {
    return await flushLocked(d, paneId);
  } finally {
    release();
  }
}

async function flushLocked(d: Deps, paneId: string): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  // Re-read under the lock: the flush that held it may have delivered these meanwhile.
  const all = d.store.queued(paneId);
  if (all.length === 0) return "delivered";
  const queued = all.filter((m) => m.attempt?.state !== "ambiguous");
  const status = await d.herdr.status(paneId);
  // Before the held check, so a gone pane with only held messages says so instead of delivery-ambiguous forever (#108).
  if (status === "gone") throw new Refusal(`pane ${paneId} is gone; ${all.length} message(s) kept in its inbox`);
  if (queued.length === 0) return "held";
  const typed = queued.filter((m) => m.attempt?.state === "typed");
  if (status === "shell") {
    // The agent the text was typed into is gone from the pane: an Enter later would go to another agent's empty input.
    if (typed.length > 0) await holdTyped(d, paneId, typed, "the agent left the pane before its Enter");
    return "no-agent";
  }
  if (!readyToRead(d, paneId, status)) return "queued";
  if (typed.length > 0) {
    // An earlier pass typed these and only the Enter failed: press Enter, never type them again (#89), and only into
    // the agent they were typed into (#108).
    const submitted = await d.herdr.submitTyped(paneId, typed[0]!.attempt);
    if (submitted === "wait") return "no-agent";
    if (submitted === "changed") {
      await holdTyped(d, paneId, typed, "a different agent is in the pane than the one the text was typed into");
      return typed.length === queued.length ? "held" : "queued";
    }
    settleInbox(d, paneId, typed);
    // Messages queued after the typed batch were not delivered by this Enter; they wait for the next pass.
    return typed.length === queued.length ? "delivered" : "queued";
  }
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  try {
    if (!(await d.herdr.deliver(paneId, body))) return "no-agent";
  } catch (e) {
    if (e instanceof DeliveryUncertain) await recordUncertain(d, paneId, queued, e);
    throw e;
  }
  settleInbox(d, paneId, queued);
  return "delivered";
}

/** Re-reads the inbox and drops the batch (delivered) or marks it with the failed attempt; messages queued meanwhile stay. */
function settleInbox(d: Deps, paneId: string, batch: readonly QueuedMessage[], attempt?: DeliveryAttempt): void {
  const left = [...batch];
  const rest = d.store.queued(paneId).flatMap((m) => {
    const i = left.findIndex((b) => b.at === m.at && b.from === m.from && b.text === m.text);
    if (i < 0) return [m];
    left.splice(i, 1);
    return attempt ? [{ ...m, attempt }] : [];
  });
  d.store.saveInbox(paneId, rest);
}

const NOTICE_FROM = "seori-delivery";

/**
 * Records an uncertain delivery on the queued messages. Typed text only waits for its Enter. An ambiguous batch is
 * held and the lead is told once; held messages are never retried, so the notice is never repeated. A notice that
 * itself fails ambiguously is held without another notice, so this cannot loop.
 */
async function recordUncertain(d: Deps, paneId: string, batch: readonly QueuedMessage[], e: DeliveryUncertain): Promise<void> {
  const detail = failureDetail(e);
  settleInbox(d, paneId, batch, { at: d.now(), state: e.typed ? "typed" : "ambiguous", detail, ...(e.typed ? e.agent : {}) });
  if (!e.typed) await noticeHeld(d, paneId, batch, `herdr said: ${detail}`);
}

/** Typed text whose agent left or changed (#108): it may sit in a lost input, so it is held like an ambiguous batch. */
async function holdTyped(d: Deps, paneId: string, typed: readonly QueuedMessage[], why: string): Promise<void> {
  settleInbox(d, paneId, typed, { at: d.now(), state: "ambiguous", detail: why });
  await noticeHeld(d, paneId, typed, why);
}

async function noticeHeld(d: Deps, paneId: string, batch: readonly QueuedMessage[], why: string): Promise<void> {
  if (batch.every((m) => m.from === NOTICE_FROM)) return;
  const which = batch.map((m) => `from ${m.from} queued ${new Date(m.at).toISOString()}`).join(", ");
  const text =
    `[DELIVERY-AMBIGUOUS ${paneId}] ${batch.length} message(s) (${which}) may or may not have reached the pane; ${why}. ` +
    `Held and not resent. Check the pane and see seori inbox list ${paneId}: if it did not arrive, seori inbox resend ${paneId} <index>; if it did, seori inbox ack ${paneId} <index>.`;
  try {
    await tellLead(d, text, NOTICE_FROM);
  } catch (err) {
    process.stderr.write(`seori: telling the lead about the ambiguous delivery to ${paneId} failed too (${failureDetail(err)}); the notice is kept in the lead's inbox\n`);
  }
}

// ---------- held entries (#108) ----------

export type InboxEntry = { index: number; state: "queued" | "typed" | "held"; from: string; at: number; preview: string };

const PREVIEW_CHARS = 60;

/** A pane's queued messages, 1-based in inbox order. The text is never shown whole: its first 60 characters, JSON-escaped. */
export function inboxList(d: Deps, target: string): { paneId: string; entries: InboxEntry[] } {
  const paneId = resolveTarget(d, target);
  const entries = d.store.queued(paneId).map((m, i): InboxEntry => ({
    index: i + 1,
    state: m.attempt?.state === "ambiguous" ? "held" : m.attempt?.state === "typed" ? "typed" : "queued",
    from: m.from,
    at: m.at,
    preview: JSON.stringify(m.text.slice(0, PREVIEW_CHARS)) + (m.text.length > PREVIEW_CHARS ? "..." : ""),
  }));
  return { paneId, entries };
}

/**
 * `ack` drops a held entry (it did arrive); `resend` clears its attempt so the next flush delivers it (it did not).
 * Only held entries: a typed one is in the pane's input already, and a queued one is delivered anyway. Runs under the
 * inbox lock, so a flush in progress cannot overwrite the change.
 */
export function releaseHeld(d: Deps, target: string, index: number, how: "ack" | "resend"): string {
  const paneId = resolveTarget(d, target);
  const release = d.store.lockInbox(paneId, d.now());
  if (!release) throw new Refusal(`the inbox of ${paneId} is being flushed right now; try again`);
  try {
    const msgs = d.store.queued(paneId);
    const m = Number.isInteger(index) ? msgs[index - 1] : undefined;
    if (!m) throw new Refusal(`no entry ${index} in the inbox of ${paneId} (${msgs.length} entries; see seori inbox list ${target})`);
    if (m.attempt?.state !== "ambiguous") throw new Refusal(`entry ${index} of ${paneId} is not held; only held entries can be acked or resent`);
    const { attempt: _, ...fresh } = m;
    d.store.saveInbox(paneId, how === "ack" ? msgs.filter((_, i) => i !== index - 1) : msgs.map((x, i) => (i === index - 1 ? fresh : x)));
    return paneId;
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

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; workspace?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost") throw new Refusal(`lane ${key} is already open in ${existing.paneId}`);
  await requireOmpIntegration(d);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, seori: d.seoriCmd });
  // The lead may pass briefs/<key>.md itself (e.g. on a retry): drop any footer seori already added,
  // whatever the path, so the brief always carries exactly one.
  const source = readFileSync(briefFile, "utf8").replace(FOOTER_RE, "").trimEnd();
  await Bun.write(briefPath, `${source}\n\n${footer}`);

  const workspace = opts.workspace ?? process.env["HERDR_WORKSPACE_ID"];
  const env = { SEORI_LANE: key, SEORI_HOME: d.store.root };
  const pane = workspace
    ? await d.herdr.createTab(key, cwd, workspace, env)
    : await d.herdr.createTab(key, cwd, (await d.herdr.createWorkspace("seori", cwd)).workspaceId, env);
  try {
    await startAgent(d, key, pane.paneId);
    const kickoff =
      `/goal Read your brief at ${briefPath} and execute it. Your lane key is ${key}. ` +
      `The work is finished only when the brief's exit condition holds and you have sent seori ready.`;
    if (!(await d.herdr.deliver(pane.paneId, kickoff))) throw new Error("omp was not in front of the pane to take the kickoff");
  } catch (e) {
    await d.herdr.close(pane.paneId).catch(() => undefined);
    throw new Refusal(`lane ${key} did not start, pane ${pane.paneId} closed: ${failureDetail(e)}`);
  }

  const now = d.now();
  const lane: Lane = {
    key, paneId: pane.paneId, tabId: pane.tabId, brief: briefPath, cwd,
    status: "working", createdAt: now, lastActivityAt: now, nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${pane.paneId}`, key);
  return lane;
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
  if (status) lane.status = status;
  d.store.saveLane(lane);
  return settled(tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

export async function ready(d: Deps, key: string, text: string, evidence: readonly string[]): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  return settled(tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key));
}

export async function done(d: Deps, key: string): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  const st = await d.herdr.status(lane.paneId);
  if (st === "working" || st === "blocked") throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (st !== "gone") await d.herdr.close(lane.paneId);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
  d.store.saveLane(lane);
}

// ---------- duty loop ----------

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** A short one-line reason. A HerdrError message carries the whole argv (the queued text), so use herdr's own output. */
function failureDetail(e: unknown): string {
  if (e instanceof DeliveryUncertain) e = e.failure;
  const raw = e instanceof HerdrError ? e.result.stderr || e.result.stdout : e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

/** One proactive pass: flush inboxes of panes that became idle, nudge lanes with no recent report, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  for (const paneId of d.store.inboxPanes()) {
    try {
      const result = await flushInbox(d, paneId);
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "no-agent") {
        events.push({ pane: paneId, action: "inbox-held", detail: `no agent in front; ${d.store.queued(paneId).length} message(s) kept` });
      }
      // Held after an ambiguous delivery (#89): shown on every pass, resent never; the lead was told once.
      const held = d.store.queued(paneId).filter((m) => m.attempt?.state === "ambiguous").length;
      if (held > 0) events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else if (e instanceof DeliveryUncertain && !e.typed) events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting") continue;
    try {
      const st = await d.herdr.status(lane.paneId);
      const now = d.now();
      if (st === "gone") {
        lane.status = "lost";
        lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
        d.store.saveLane(lane);
        await tellLead(d, `[LOST ${lane.key}] pane ${lane.paneId} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      // A goal-mode lane reads `working` until its goal ends, so `working` is not progress: staleness counts from the
      // last lane activity seori records (start, report, ready). Delivery to a working lane pane is a steer.
      if (lane.status === "waiting" || st === "blocked") continue;
      const silentMin = (now - lane.lastActivityAt) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || silentMin < due) continue;
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `no report ${Math.floor(silentMin)} min` });
      d.store.saveLane(lane);
      if (lane.nudges < NUDGE_MINUTES.length) {
        await sendOrThrow(d, lane.key, prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(silentMin)), seori: d.seoriCmd }), "duty");
        events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      } else {
        await tellLead(d, `[ESCALATE ${lane.key}] no report for ${Math.floor(silentMin)} min after ${lane.nudges - 1} nudges`, "duty");
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: lane.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  try {
    await channelAlerts(d, events);
  } catch (e) {
    // An unwritable lead dir must not stop lane and inbox duty (a broken messengers.json is told to the lead, not thrown).
    events.push({ action: "channel-failed", detail: failureDetail(e) });
  }
  return events;
}

// ---------- lead channel alerts ----------

/** The daemon rewrites its heartbeat at least every 10 s; 90 s without one is an outage, not a slow write. */
export const HEARTBEAT_STALE_MS = 90_000;
/** How long a message may wait (offline lead) or sit delivered (blocked lead) before the human is told. */
export const ALERT_AFTER_MS = 2 * 60_000;

export const ALERT_TEXT = {
  "lead-offline": "seori: the lead is offline; your message is kept and will be answered when it is back.",
  "lead-blocked": "seori: the lead is waiting on a question in its terminal; your message is queued.",
  "gave-up": "seori: the lead could not answer this after 3 tries; please check the terminal.",
} as const;
type AlertWhy = keyof typeof ALERT_TEXT;

/** `lead/duty-alerts.json`: alert state that is not per message id, so an outage or a breakage is told once, not every tick. */
type DutyAlerts = { daemonDownSince?: number; configBrokenSince?: number };

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
 * No lead extension is consuming: its lock is missing or held by a dead pid on this host. A lock from another host,
 * or one that cannot be read, cannot be judged here, so it counts as consuming rather than raising a false alarm.
 */
function consumerOffline(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return true;
  }
  const lock = (() => { try { return JSON.parse(raw) as { pid?: unknown; host?: unknown }; } catch { return {}; } })();
  return lock.host === hostname() && typeof lock.pid === "number" && !pidAlive(lock.pid);
}

/**
 * Messenger alerts, only when a messenger is configured (or messengers.json is there but broken): a broken config and a
 * daemon outage go to the lead, then per-id alerts go to the human. A broken config has no messenger to reply through,
 * so it skips the per-id alerts, but the outage check still runs: the daemon cannot start on that file.
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
  if (broken !== undefined) return;

  const open = channel.open();
  // Send-uncertain and gave-up ids are final: they are never delivered again, so "kept" or "queued" would be false.
  const waiting = open.filter((s) => !s.uncertain && !s.gaveUp);
  const waited = (at: number | undefined): boolean => at !== undefined && now - at > ALERT_AFTER_MS;
  const due: [IdState, AlertWhy][] = [];
  const offline = waiting.filter((s) => !s.alerted.includes("lead-offline") && waited(s.row.at));
  if (offline.length && consumerOffline(channel.consumerLockPath)) due.push(...offline.map((s): [IdState, AlertWhy] => [s, "lead-offline"]));
  const stuck = waiting.filter((s) => !s.alerted.includes("lead-blocked") && waited(s.lastDeliveredAt));
  const lead = d.store.roles().lead;
  if (stuck.length && lead) {
    try {
      if ((await d.herdr.status(lead)) === "blocked") due.push(...stuck.map((s): [IdState, AlertWhy] => [s, "lead-blocked"]));
    } catch (e) {
      events.push({ pane: lead, action: "lead-status-failed", detail: failureDetail(e) });
    }
  }
  for (const s of open) if (s.gaveUp && !s.alerted.includes("gave-up")) due.push([s, "gave-up"]);

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
  const sha = await headSha(d, pr);
  const text = prompt("review.md", { pr: pr.id, repo: pr.repo, number: String(pr.number), sha });
  const argv = [
    "-p", "--no-session", "--mode", "json", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files",
    "--approval-mode", "yolo", ...(model ? ["--model", model] : []), text,
  ];
  const res = await d.exec(d.agentCmd, argv);
  if (res.code === 3) throw new Error(`reviewer hit the cost cap: ${res.stderr.trim()}`);
  const answer = reviewerAnswer(res.stdout);
  if (answer?.stopReason === "aborted") throw new Error("reviewer stopped before finishing (deadline)");
  if (res.code !== 0) throw new Error(`reviewer exited ${res.code}: ${res.stderr.trim()}`);
  const verdicts = [...(answer?.text ?? "").matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = verdicts.at(-1);
  if (!last) throw new Error("reviewer printed no VERDICT line; no receipt written");
  const verdict = last[1] as "CLEAR" | "BLOCK";
  const summary = answer!.text.trim().slice(-4000);
  d.store.saveReceipt({ pr: pr.id, sha, verdict, model: answer!.model ?? model ?? "default", at: d.now(), summary });
  return { verdict, sha };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
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
  return undefined;
}

export const ROLES: readonly Role[] = ["lead", "duty"];
