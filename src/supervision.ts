import { appendFileSync, existsSync, lstatSync, mkdirSync, statSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, loadConfig, type SeoriConfig } from "./config.ts";
import { type Deps, type DutyEvent, tellLead } from "./harness.ts";
import { DeliveryUncertain, ToolError } from "./runtime/index.ts";
import { type Ceilings, type Lane, type LaneLogKind, lockFile } from "./store.ts";

import { PAUSED_WORKING_MARKS } from "./pause.ts";
import { refText } from "./refs.ts";
import { startAgain } from "./restart.ts";
import { runHook } from "./hooks.ts";

/** How long a close waits for another process's hold on the cost ledger before giving up (one stderr line). */
const COST_LOCK_WAIT_MS = 2000;

// Lane supervision, run by the duty loop: ceilings (wall-clock time, tokens, cost) and stalls are reported to the lead
// once each. seori never kills or messages a lane for them: the lead decides. A paused lane is left alone, except that
// one reading working on two passes in a row is reported, since the owner said wait.

/** Token and cost totals of a lane's omp session. Unknown stays undefined, never 0. */
export type LaneUsage = { tokens?: number; costUsd?: number };

/**
 * Sums `message.usage.totalTokens` and `message.usage.cost.total` over the assistant messages of the lane's omp session
 * jsonl (its path from the runtime, see SessionRuntime.agentSession). A total is undefined when the session file is unknown or
 * unreadable or no assistant message carries that number; damaged lines (a torn last write) are skipped.
 */
export async function laneUsage(d: Deps, lane: Lane): Promise<LaneUsage> {
  const path = await d.runtime.agentSession(lane.sessionRef);
  if (!path) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let tokens: number | undefined;
  let costUsd: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: { role?: unknown; usage?: { totalTokens?: unknown; cost?: { total?: unknown } } } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)) tokens = (tokens ?? 0) + usage.totalTokens;
    if (typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total)) costUsd = (costUsd ?? 0) + usage.cost.total;
  }
  return { ...(tokens !== undefined ? { tokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

/** One lane close's reading in `$SEORI_HOME/cost.jsonl`: unknown totals are null, never 0. */
export type CostRecord = { key: string; closeKey: string; tokens: number | null; costUsd: number | null; at: number };

/**
 * Records what a lane spent when it closes (dori-superagent 4ea8bd1): its omp session's totals, read while the session
 * is still open, appended to `cost.jsonl` once per lane (`closeKey` = key@createdAt, so a retried close adds nothing
 * and a reopened key gets its own line). `hooks.recordCost`, when configured, runs once with a known reading. Local
 * only: nothing is sent anywhere unless that hook is set.
 */
export async function recordCloseCost(d: Deps, lane: Lane): Promise<void> {
  const path = join(d.store.root, "cost.jsonl");
  const closeKey = `${lane.key}@${lane.createdAt}`;
  const recorded = (): boolean =>
    existsSync(path) && readFileSync(path, "utf8").split("\n").some((line) => {
      try {
        return (JSON.parse(line) as Partial<CostRecord>).closeKey === closeKey;
      } catch {
        return false;
      }
    });
  if (recorded()) return;
  const usage = await laneUsage(d, lane);
  // Two closes can both pass the check above while usage is read; the check is repeated under the lock so only one appends.
  const lock = join(d.store.root, "cost.jsonl.lock");
  const deadline = d.now() + COST_LOCK_WAIT_MS;
  let release = lockFile(lock, d.now());
  while (!release) {
    if (d.now() > deadline) throw new Error(`cost ledger is locked by another process (${lock})`);
    await d.sleep(5);
    release = lockFile(lock, d.now());
  }
  const record: CostRecord = { key: lane.key, closeKey, tokens: usage.tokens ?? null, costUsd: usage.costUsd ?? null, at: d.now() };
  try {
    if (recorded()) return;
    appendFileSync(path, JSON.stringify(record) + "\n");
  } finally {
    release();
  }
  if (record.tokens === null && record.costUsd === null) return;
  void runHook(d, "recordCost", { key: lane.key, tokens: String(record.tokens), cost: String(record.costUsd), closeKey });
}

type CeilingName = keyof Ceilings;

/** A reached ceiling: which one, the lane's reading and the limit. */
export type CeilingHit = { readonly which: CeilingName; readonly actual: number; readonly limit: number };

/** The ceilings that apply to a lane: its own from `seori start`, else the config defaults. */
export const laneCeilings = (lane: Lane, config: SeoriConfig): Ceilings => lane.ceilings ?? config.supervision.defaults;

/**
 * The ceilings a lane has reached (reading >= limit). Wall-clock time counts from the lane's start; tokens and cost
 * come from `usage`, and an unknown reading reaches nothing.
 */
export function reachedCeilings(lane: Lane, ceilings: Ceilings, usage: LaneUsage, now: number): CeilingHit[] {
  const readings: Record<CeilingName, number | undefined> = {
    wallMinutes: (now - lane.createdAt) / 60_000,
    tokens: usage.tokens,
    costUsd: usage.costUsd,
  };
  const hits: CeilingHit[] = [];
  for (const which of ["wallMinutes", "tokens", "costUsd"] as const) {
    const limit = ceilings[which];
    const actual = readings[which];
    if (limit !== null && actual !== undefined && actual >= limit) hits.push({ which, actual, limit });
  }
  return hits;
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** The lead's message for a reached ceiling. */
export function blockedText(key: string, hit: CeilingHit): string {
  const detail =
    hit.which === "wallMinutes" ? `wall-clock ceiling reached (${Math.floor(hit.actual)} min, limit ${hit.limit} min)`
    : hit.which === "tokens" ? `token ceiling reached (${Math.round(hit.actual)} tokens, limit ${hit.limit})`
    : `cost ceiling reached (${money(hit.actual)}, limit ${money(hit.limit)})`;
  return `[BLOCKED ${key}] ${detail}; the lane keeps running until you decide`;
}

/** The lead's message for a stalled lane. */
export const stalledText = (key: string, quietMin: number): string =>
  `[STALLED ${key}] hc reads it working, but it has sent no report and changed no file for ${quietMin} min; the lane keeps running until you decide`;

/** The lead's message for a paused lane whose pane read working on two duty passes in a row. */
export const workingWhilePausedText = (key: string, paneId: string): string =>
  `[WORKING-WHILE-PAUSED ${key}] pane ${paneId} reads working on two duty passes in a row while the lane is paused; it stays paused until seori resume ${key}`;

// ---------- file activity ----------

/** Per-lane file activity seen by earlier passes: the last fingerprint and when it last changed. */
type ActivityState = Record<string, { fingerprint: string; changedAt?: number }>;

const activityPath = (root: string): string => join(root, "duty", "supervision.json");

function readActivity(root: string): ActivityState {
  const path = activityPath(root);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as ActivityState) : {};
  } catch {
    // A torn or damaged state file only costs one pass of change history.
    return {};
  }
}

function writeActivity(root: string, state: ActivityState): void {
  const path = activityPath(root);
  mkdirSync(join(root, "duty"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * What the lane has changed on disk: HEAD plus every path `git status` lists under lane.cwd (tracked changes and
 * every untracked file, node_modules left out) with its mtime and size. Untracked files are listed one by one, as a
 * new directory's own mtime does not change when a file inside it is rewritten. `newestMtime` is the latest mtime
 * among them. Not a git work tree, or git failing: an empty fingerprint, so only reports count as progress there.
 * `activityPaths` (resolved against cwd, symlinks followed) are added with their mtime, ctime and size, git or not,
 * as upstream does: a lane whose output lies outside its repo (or that has none) shows progress there. A directory's
 * own times change only when an entry is added, removed or renamed; a file rewritten inside it is no change.
 */
export async function fileActivity(
  d: Deps, cwd: string, activityPaths: readonly string[] = [],
): Promise<{ fingerprint: string; newestMtime?: number }> {
  const git = await gitActivity(d, cwd);
  if (activityPaths.length === 0) return git;
  const paths = [...new Set(activityPaths.map((p) => resolve(cwd, p)))].sort().map((path) => {
    try {
      const st = statSync(path);
      return [path, st.mtimeMs, st.ctimeMs, st.size];
    } catch {
      return [path, null];
    }
  });
  return { ...git, fingerprint: JSON.stringify({ git: git.fingerprint, paths }) };
}

async function gitActivity(d: Deps, cwd: string): Promise<{ fingerprint: string; newestMtime?: number }> {
  const status = await d.exec("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (status.code !== 0) return { fingerprint: "" };
  // Porcelain paths are relative to the repository root, not to cwd: cwd may be a subdirectory of the repo.
  const prefix = await d.exec("git", ["-C", cwd, "rev-parse", "--show-prefix"]);
  if (prefix.code !== 0) return { fingerprint: "" };
  const cwdInRepo = prefix.stdout.trim();
  const head = await d.exec("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", "HEAD"]);
  const entries = status.stdout.split("\0");
  const files: [string, number | null, number | null][] = [];
  let newestMtime: number | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    // A rename or copy is followed by its source path as a separate entry.
    if ("RC".includes(entry[0]!) || "RC".includes(entry[1]!)) i++;
    const fromRoot = entry.slice(3);
    if (!fromRoot.startsWith(cwdInRepo)) continue;
    const rel = fromRoot.slice(cwdInRepo.length);
    if (!rel || rel.split("/").includes("node_modules")) continue;
    const path = join(cwd, rel);
    try {
      const st = lstatSync(path);
      files.push([`${entry.slice(0, 2)} ${rel}`, st.mtimeMs, st.size]);
      newestMtime = Math.max(newestMtime ?? 0, st.mtimeMs);
    } catch {
      files.push([`${entry.slice(0, 2)} ${rel}`, null, null]);
    }
  }
  files.sort((a, b) => a[0].localeCompare(b[0]));
  const fingerprint = JSON.stringify({ head: head.code === 0 ? head.stdout.trim() : null, files });
  return { fingerprint, ...(newestMtime !== undefined ? { newestMtime } : {}) };
}

// ---------- the tick ----------

/** A short one-line reason. A ToolError message carries the whole argv, so use the runtime's own output. */
function reason(e: unknown): string {
  if (e instanceof ToolError) return (e.result.stderr || e.result.stdout).trim().split("\n")[0] ?? "hc failed";
  return e instanceof Error ? e.message : String(e);
}

/**
 * Tells the lead; whatever happens counts as told. With no lead registered the message is kept only in the lane log
 * (tellLead says so). Every failure after that comes after the message was queued (a gone lead pane, a failed or
 * uncertain delivery): it reaches the lead later and must not be queued again on the next pass.
 */
async function tell(d: Deps, text: string, lane: string, events: DutyEvent[]): Promise<void> {
  try {
    await tellLead(d, text, "duty");
  } catch (e) {
    if (!(e instanceof DeliveryUncertain)) events.push({ lane, action: "supervise-failed", detail: reason(e) });
  }
}

/** Re-reads the lane, applies `change` and saves it, so a report the lane sent meanwhile is kept. */
function mark(d: Deps, key: string, change: (lane: Lane) => void, log?: { kind: LaneLogKind; text: string }): void {
  const lane = d.store.lane(key);
  if (!lane) return;
  lane.alerts ??= {};
  change(lane);
  if (log) lane.log.push({ at: d.now(), ...log });
  d.store.saveLane(lane);
}

/**
 * One supervision pass over the open lanes (the duty loop runs it with dutyTick):
 * - working/waiting lanes: each ceiling (lane.ceilings ?? config defaults) is reported once when reached, as
 *   `[BLOCKED <key>] ...` with a "blocked" log entry; a raised limit can be reported again. Tokens and cost are read
 *   only when such a ceiling is set; an unknown reading is shown once as a `usage-unknown` event.
 * - working lanes that hc reads working: no report (lastActivityAt) and no file change in lane.cwd (see
 *   fileActivity) for config.supervision.hungAfterMin is a stall, reported once per stretch as `[STALLED <key>] ...`
 *   with a "stalled" log entry. A waiting lane said it waits, so its quiet is no stall (as it gets no nudge).
 * - paused lanes: no ceiling or stall report; a pane read working on two passes in a row is reported once per working
 *   stretch as `[WORKING-WHILE-PAUSED <key>]` and the lane stays paused. A gone pane (a restart or a down closes paused
 *   panes too) marks the lane lost and is told as `[LOST <key>]`, as dutyTick does for running lanes, but as a lane that
 *   was paused, with the command that resumes it: the pause meant "later", not "failed".
 * The lane is never messaged or killed. One lane's failure is an event and the pass goes on.
 */
export async function superviseTick(d: Deps): Promise<DutyEvent[]> {
  if (d.store.stop("duty")) return [];
  let config: SeoriConfig;
  try {
    config = loadConfig(d.store.root);
  } catch (e) {
    if (e instanceof ConfigError) return [{ action: "supervise-failed", detail: e.message }];
    throw e;
  }
  const events: DutyEvent[] = [];
  const activity = readActivity(d.store.root);
  const seen = new Set<string>();
  for (const lane of d.store.lanes()) {
    try {
      if (lane.status === "paused") await pausedCheck(d, lane, events);
      else if (lane.status === "working" || lane.status === "waiting") {
        seen.add(lane.key);
        await ceilingCheck(d, lane, config, events);
        await stallCheck(d, lane, config, activity, events);
      }
    } catch (e) {
      events.push({ lane: lane.key, action: "supervise-failed", detail: reason(e) });
    }
  }
  // Only running lanes keep change history: a resumed lane starts a fresh one.
  for (const key of Object.keys(activity)) if (!seen.has(key)) delete activity[key];
  writeActivity(d.store.root, activity);
  return events;
}

async function pausedCheck(d: Deps, lane: Lane, events: DutyEvent[]): Promise<void> {
  const [seenMark, toldMark] = PAUSED_WORKING_MARKS;
  const st = await d.runtime.status(lane.sessionRef);
  if (st === "gone") {
    // As dutyTick does for running lanes: otherwise the key stays paused with no pane, and done/start both refuse it.
    mark(d, lane.key, (l) => { l.status = "lost"; delete l.pausedFrom; }, { kind: "lost", text: "pane disappeared while paused" });
    void runHook(d, "onLost", { key: lane.key, text: "pane disappeared while paused", evidence: "" });
    await tell(
      d,
      `[LOST ${lane.key}] pane ${refText(lane.sessionRef)} closed while the lane was paused (a seori restart or down closes ` +
        `paused lanes' panes too). It was paused, not failed: its record and brief stay; to resume it: ${startAgain(lane, d.seoriCmd)}`,
      lane.key,
      events,
    );
    events.push({ lane: lane.key, action: "lost" });
    return;
  }
  if (st !== "working") {
    // Idle again: the next working stretch is new and is reported again.
    if (lane.alerts?.[seenMark] !== undefined || lane.alerts?.[toldMark] !== undefined) {
      mark(d, lane.key, (l) => { delete l.alerts![seenMark]; delete l.alerts![toldMark]; });
    }
    return;
  }
  if (lane.alerts?.[seenMark] === undefined) {
    mark(d, lane.key, (l) => { l.alerts![seenMark] = d.now(); });
    return;
  }
  if (lane.alerts[toldMark] !== undefined) return;
  await tell(d, workingWhilePausedText(lane.key, refText(lane.sessionRef)), lane.key, events);
  mark(d, lane.key, (l) => { l.alerts![toldMark] = d.now(); });
  events.push({ lane: lane.key, action: "working-while-paused" });
}

async function ceilingCheck(d: Deps, lane: Lane, config: SeoriConfig, events: DutyEvent[]): Promise<void> {
  const ceilings = laneCeilings(lane, config);
  const wantsUsage = ceilings.tokens !== null || ceilings.costUsd !== null;
  const usage = wantsUsage ? await laneUsage(d, lane) : {};
  const unknown = (["tokens", "costUsd"] as const).filter((k) => ceilings[k] !== null && usage[k] === undefined);
  const unknownMark = `usage-unknown:${unknown.join(",")}`;
  if (unknown.length > 0 && lane.alerts?.[unknownMark] === undefined) {
    mark(d, lane.key, (l) => { l.alerts![unknownMark] = d.now(); });
    events.push({ lane: lane.key, action: "usage-unknown", detail: `${unknown.join(" and ")} ceiling cannot be checked: the lane's omp session usage is unavailable` });
  }
  for (const hit of reachedCeilings(lane, ceilings, usage, d.now())) {
    // The limit is part of the mark, so a limit the lead raised is reported again once reached.
    const key = `ceiling:${hit.which}:${hit.limit}`;
    if (lane.alerts?.[key] !== undefined) continue;
    const text = blockedText(lane.key, hit);
    await tell(d, text, lane.key, events);
    mark(d, lane.key, (l) => { l.alerts![key] = d.now(); }, { kind: "blocked", text });
    events.push({ lane: lane.key, action: "blocked", detail: hit.which });
  }
}

async function stallCheck(d: Deps, lane: Lane, config: SeoriConfig, activity: ActivityState, events: DutyEvent[]): Promise<void> {
  const now = d.now();
  const files = await fileActivity(d, lane.cwd, [...config.supervision.activityPaths, ...(lane.activityPaths ?? [])]);
  const before = activity[lane.key];
  const changedAt = before === undefined ? undefined : before.fingerprint !== files.fingerprint ? now : before.changedAt;
  activity[lane.key] = { fingerprint: files.fingerprint, ...(changedAt !== undefined ? { changedAt } : {}) };
  if (lane.status !== "working") return;
  const lastProgress = Math.max(lane.lastActivityAt, changedAt ?? 0, Math.min(files.newestMtime ?? 0, now));
  const quietMs = now - lastProgress;
  if (quietMs < config.supervision.hungAfterMin * 60_000) return;
  // Once per stall: progress after it makes a new mark.
  const key = `stalled:${Math.round(lastProgress)}`;
  if (lane.alerts?.[key] !== undefined) return;
  if ((await d.runtime.status(lane.sessionRef)) !== "working") return;
  const text = stalledText(lane.key, Math.floor(quietMs / 60_000));
  await tell(d, text, lane.key, events);
  mark(d, lane.key, (l) => {
    for (const k of Object.keys(l.alerts!)) if (k.startsWith("stalled:")) delete l.alerts![k];
    l.alerts![key] = now;
  }, { kind: "stalled", text });
  events.push({ lane: lane.key, action: "stalled" });
}
