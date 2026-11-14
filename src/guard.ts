import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type GuardThresholds, type SeoriConfig } from "./config.ts";
import { tellLead, type Deps, type DutyEvent } from "./harness.ts";
import { DeliveryUncertain, ToolError } from "./runtime/index.ts";

// The host guard: one reading of the machine (load, memory, disk, panes) that holds new lanes (`seori can-launch`)
// and tells the lead once when the host crosses a threshold and once when it recovers (the duty tick's guardTick).

/**
 * One reading of the host. `loadPct` is the 1-minute load per core in percent (100 = every core busy). Disk is the least free
 * space on the volumes lanes work on (open lane directories, else $HOME). A figure that could not be read is undefined, with the reason in `unreadable`; it is
 * never guessed as 0 or as fine. `loadPct` is undefined when the host reports no load average: shown as unknown, it never alerts.
 */
export type HostSample = {
  readonly loadPct?: number;
  readonly memFreePct: number;
  readonly diskFreeGb?: number;
  readonly panes?: number;
  readonly unreadable: readonly string[];
};

const KB_PER_GB = 1024 * 1024;

/** First line of a failed command's output, short enough for one alert line. */
function why(stderr: string, stdout: string): string {
  const first = (stderr.trim() || stdout.trim()).split("\n")[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 120)}...` : first || "no output";
}

/** Available kilobytes from `df -k -P <path>`: the last line's fourth column (POSIX format keeps one line per volume). */
export function parseDfAvailableKb(stdout: string): number | undefined {
  const last = stdout.trim().split("\n").at(-1)?.trim().split(/\s+/);
  const kb = Number(last?.[3]);
  return last && last.length >= 6 && Number.isFinite(kb) && kb >= 0 ? kb : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Where new work lands: the working directory of every open lane that still exists (its worktree when seori gave it
 * one, else its cwd), or the user's home directory (where repos and worktrees live) when no lane is open. $SEORI_HOME
 * itself is not measured: it holds small state files and may sit on a small tmpfs (e.g. under /tmp), which says
 * nothing about the room lanes have to work; a lane worktree under it is measured, since the lane works there.
 */
function workPaths(d: Deps): string[] {
  const cwds = d.store.lanes().filter((l) => l.status !== "done").map((l) => l.worktree ?? l.cwd).filter((p) => existsSync(p));
  return cwds.length > 0 ? [...new Set(cwds)] : [homedir()];
}

/**
 * Reads the host: load and memory from Deps.host, free disk of the work volumes (lane directories, else $HOME) from `df -k -P`, and the live pane
 * count from the runtime's session list (`hc ls`).
 */
export async function sampleHost(d: Deps): Promise<HostSample> {
  const host = d.host();
  const unreadable: string[] = [];

  let diskFreeGb: number | undefined;
  let diskFault: string | undefined;
  for (const path of workPaths(d)) {
    const df = await d.exec("df", ["-k", "-P", path]).catch((e: unknown) => ({ code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
    const kb = df.code === 0 ? parseDfAvailableKb(df.stdout) : undefined;
    if (kb !== undefined) diskFreeGb = Math.min(diskFreeGb ?? Infinity, kb / KB_PER_GB);
    else diskFault ??= `df: ${df.code === 0 ? "unexpected output" : why(df.stderr, df.stdout)}`;
  }
  if (diskFreeGb === undefined) unreadable.push(`disk free unreadable (${diskFault ?? "df: no path to measure"})`);

  let panes: number | undefined;
  const rt = d.runtime;
  try {
    panes = (await rt.list()).length;
  } catch (e) {
    unreadable.push(`panes unreadable (hc ls: ${e instanceof ToolError ? why(e.result.stderr, e.result.stdout) : e instanceof Error ? why(e.message, "") : String(e)})`);
  }

  return {
    ...(host.load1 !== null ? { loadPct: host.cores > 0 ? Math.round((host.load1 / host.cores) * 100) : 0 } : {}),
    memFreePct: host.memFreePct,
    ...(diskFreeGb !== undefined ? { diskFreeGb } : {}),
    ...(panes !== undefined ? { panes } : {}),
    unreadable,
  };
}

const gb = (n: number): string => `${Math.floor(n)} GB`;

/**
 * Why a new lane must wait: free memory, free disk or the pane count past its threshold. A figure that could not be
 * read holds nothing (as dori, which counts unknown memory as free): a flaky `df` or hc call must not stop all work.
 * `seori guard` still prints it.
 * CPU load never holds a launch: it moves too fast to plan around (heavy commands wait for it instead, see heavy.ts).
 */
export function holdReasons(s: HostSample, t: GuardThresholds): string[] {
  const r: string[] = [];
  if (s.memFreePct < t.memFreeMinPct) r.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb !== undefined && s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${gb(s.diskFreeGb)} < ${t.diskFreeMinGb} GB`);
  if (s.panes !== undefined && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
}

/** `seori can-launch`: ok when nothing holds a new lane (see holdReasons). */
export async function canLaunch(d: Deps, config: SeoriConfig): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons = holdReasons(await sampleHost(d), config.guard);
  return { ok: reasons.length === 0, reasons };
}

/** The line `seori can-launch` prints: `CAN_LAUNCH` (exit 0) or `HOLD <reason> | <reason>` (exit 4). */
export const canLaunchLine = (r: { ok: boolean; reasons: readonly string[] }): string => (r.ok ? "CAN_LAUNCH" : `HOLD ${r.reasons.join(" | ")}`);

/** One line with every figure, e.g. `load 40% per core, memory free 52%, disk free 120 GB, panes 7`. */
export function hostLine(s: HostSample): string {
  return [
    `load ${s.loadPct === undefined ? "unknown" : `${s.loadPct}% per core`}`,
    `memory free ${s.memFreePct}%`,
    `disk free ${s.diskFreeGb === undefined ? "unknown" : gb(s.diskFreeGb)}`,
    `panes ${s.panes ?? "unknown"}`,
  ].join(", ");
}

/** `$SEORI_HOME/duty/guard.json`: what the lead was last told, so a crossing is told once, not every tick. */
export type GuardState = {
  readonly alerting: boolean;
  /** Load crossed loadAlertPct and has not yet fallen under loadOkPct. */
  readonly loadHigh: boolean;
  readonly since: number;
  readonly reasons: readonly string[];
};

export const guardStatePath = (root: string): string => join(root, "duty", "guard.json");

function saveGuardState(root: string, s: GuardState): void {
  const path = guardStatePath(root);
  mkdirSync(join(root, "duty"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readGuardState(root: string): GuardState | undefined {
  let s: unknown;
  try {
    s = JSON.parse(readFileSync(guardStatePath(root), "utf8"));
  } catch {
    return undefined; // no file yet, or a damaged one: start from "not alerting"
  }
  if (!isObj(s) || typeof s["alerting"] !== "boolean") return undefined;
  const reasons = s["reasons"];
  return {
    alerting: s["alerting"],
    loadHigh: s["loadHigh"] === true,
    since: typeof s["since"] === "number" ? s["since"] : 0,
    reasons: Array.isArray(reasons) ? reasons.map(String) : [],
  };
}

/**
 * The guard's verdict on a reading. Load alerts above loadAlertPct and, once high, stays high until it falls under
 * loadOkPct, so a load hovering at the threshold does not flap. Memory, disk and panes alert as in holdReasons; an
 * unreadable figure never alerts.
 */
export function guardVerdict(s: HostSample, t: GuardThresholds, wasLoadHigh: boolean): { loadHigh: boolean; reasons: string[] } {
  const pct = s.loadPct;
  const loadHigh = pct === undefined ? false : wasLoadHigh ? pct >= t.loadOkPct : pct > t.loadAlertPct;
  const load = loadHigh ? [wasLoadHigh && pct! <= t.loadAlertPct ? `load ${pct}% per core, not yet under ${t.loadOkPct}%` : `load ${pct}% per core > ${t.loadAlertPct}%`] : [];
  return { loadHigh, reasons: [...load, ...holdReasons(s, t)] };
}

/** `seori guard`: the current reading and verdict, read-only (`HOST ...`, then `HOST_GUARD ALERT <reasons>` or `HOST_GUARD OK`). */
export async function guardLines(d: Deps, config: SeoriConfig): Promise<string[]> {
  const s = await sampleHost(d);
  const v = guardVerdict(s, config.guard, readGuardState(d.store.root)?.loadHigh ?? false);
  return [`HOST ${hostLine(s)}`, v.reasons.length ? `HOST_GUARD ALERT ${v.reasons.join(" | ")}` : "HOST_GUARD OK"];
}

/**
 * Duty: tells the lead `[HOST-GUARD ALERT] <reasons>` when the host crosses a threshold and `[HOST-GUARD CLEAR] <figures>`
 * when every threshold is fine again, once per crossing. A failed delivery is reported as an event; the message stays
 * in the lead's inbox for the next flush and is not told again. A broken config.json is a `guard-failed` event.
 */
export async function guardTick(d: Deps): Promise<DutyEvent[]> {
  let config: SeoriConfig;
  try {
    config = loadConfig(d.store.root);
  } catch (e) {
    return [{ action: "guard-failed", detail: e instanceof Error ? e.message : String(e) }];
  }
  const s = await sampleHost(d);
  const prev = readGuardState(d.store.root) ?? { alerting: false, loadHigh: false, since: 0, reasons: [] };
  const v = guardVerdict(s, config.guard, prev.loadHigh);
  // An alert is only cleared by figures read as fine: a figure that could not be read this time (hc restarting, a
  // flaky df) keeps the alert as it was rather than sending a false CLEAR followed by a second ALERT.
  if (prev.alerting && v.reasons.length === 0 && s.unreadable.length > 0) {
    saveGuardState(d.store.root, { ...prev, loadHigh: v.loadHigh });
    return [];
  }
  const alerting = v.reasons.length > 0;
  const now = d.now();
  const next: GuardState = { alerting, loadHigh: v.loadHigh, since: alerting === prev.alerting ? prev.since : now, reasons: v.reasons };
  if (alerting === prev.alerting) {
    saveGuardState(d.store.root, next);
    return [];
  }
  const text = alerting ? `[HOST-GUARD ALERT] ${v.reasons.join(" | ")}` : `[HOST-GUARD CLEAR] ${hostLine(s)}`;
  const events: DutyEvent[] = [{ action: alerting ? "guard-alert" : "guard-clear", detail: alerting ? v.reasons.join(" | ") : hostLine(s) }];
  // Saved first: tellLead puts the message in the lead's inbox before it tries the pane, so whatever happens next it
  // is kept there for duty's next flush, and telling it again would only say it twice.
  saveGuardState(d.store.root, next);
  try {
    await tellLead(d, text, "duty");
  } catch (e) {
    const detail = e instanceof DeliveryUncertain ? "delivery uncertain" : e instanceof ToolError ? why(e.result.stderr, e.result.stdout) : e instanceof Error ? e.message : String(e);
    events.push({ action: "guard-delivery-failed", detail: `${events[0]!.action} kept in the lead inbox: ${detail}` });
  }
  return events;
}
