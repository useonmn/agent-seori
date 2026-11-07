import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Refusal } from "../harness.ts";
import { Store } from "../store.ts";
import { type Watch, type WatchOwner, type WatchSource, WAKE_BUDGET, WAKE_WINDOW_MS, WatchStore } from "./store.ts";

// `seori watch ...`: arms, lists, stops and rearms the watches the daemon's engine runs. Any agent may arm one (the lead
// or a lane, like omo's monitor); the store enforces the limits, so this file only turns arguments into store calls.

export const WATCH_USAGE = `  seori watch add (--command CMD [--filter RE] [--cwd DIR] | --file PATH | --checks OWNER/REPO#N
                   | --pane PANE --status idle|working|blocked|gone)
                   [--name N] [--persistent] [--timeout DUR] [--for lead|KEY]
                                              wake the lead or a lane when it fires (DUR: 90s, 30m, 2h)
  seori watch list [--all]                     active and muted watches (--all: every one)
  seori watch stop <id|name>                   end a watch
  seori watch rearm <id|name>                  unmute a watch that used up its wake budget
  seori watch log <id|name> [-n N]             the watch's last events`;

const PANE_STATUSES = ["idle", "working", "blocked", "gone"] as const;
const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const CHECKS_RE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** `90s`, `30m`, `2h`, `1d` in milliseconds. */
export function parseDuration(s: string): number {
  const m = DURATION_RE.exec(s);
  if (!m) throw new Refusal(`--timeout takes a duration like 90s, 30m or 2h, not ${s}`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

/** Compact age or remaining time for `watch list`: 45s, 12m, 1h30m, 6d2h. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${Math.floor(h / 24)}d`;
}

export const ownerText = (o: WatchOwner): string => (o.kind === "lead" ? "lead" : o.key);

export function targetText(s: WatchSource): string {
  switch (s.kind) {
    case "command":
      return `command: ${s.command}${s.filter !== undefined ? ` /${s.filter}/` : ""}`;
    case "file":
      return `file: ${s.path}`;
    case "checks":
      return `checks: ${s.repo}#${s.number}`;
    case "pane":
      return `pane: ${s.pane} -> ${s.status}`;
  }
}

const live = (w: Watch): boolean => w.status === "active" || w.status === "muted";

/** --for, else the lane this command runs in (SEORI_LANE), else the lead. A lane owner must be an open lane. */
function ownerOf(root: string, forFlag: string | undefined, env: Record<string, string | undefined>): WatchOwner {
  const who = forFlag ?? env["SEORI_LANE"] ?? "lead";
  if (who === "lead") return { kind: "lead" };
  const lane = new Store(root).lane(who);
  if (!lane) throw new Refusal(`no lane ${who}; --for takes lead or an open lane key`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${who} is ${lane.status}; a watch for it would never be delivered`);
  return { kind: "lane", key: who };
}

export type AddFlags = {
  readonly command?: string;
  readonly filter?: string;
  readonly cwd?: string;
  readonly file?: string;
  readonly checks?: string;
  readonly pane?: string;
  readonly status?: string;
  readonly name?: string;
  readonly persistent?: boolean;
  readonly timeout?: string;
  readonly for?: string;
};

function sourceOf(f: AddFlags): WatchSource {
  const given = (["command", "file", "checks", "pane"] as const).filter((k) => f[k] !== undefined);
  if (given.length !== 1) throw new Refusal(`give exactly one of --command, --file, --checks, --pane\n\n${WATCH_USAGE}`);
  if (f.command !== undefined) {
    return { kind: "command", command: f.command, cwd: resolve(f.cwd ?? process.cwd()), ...(f.filter !== undefined ? { filter: f.filter } : {}) };
  }
  if (f.file !== undefined) return { kind: "file", path: resolve(f.file) };
  if (f.checks !== undefined) {
    const m = CHECKS_RE.exec(f.checks);
    if (!m) throw new Refusal(`--checks takes OWNER/REPO#N, not ${f.checks}`);
    return { kind: "checks", repo: m[1]!, number: Number(m[2]) };
  }
  const status = f.status as (typeof PANE_STATUSES)[number] | undefined;
  if (status === undefined || !PANE_STATUSES.includes(status)) throw new Refusal(`--pane needs --status ${PANE_STATUSES.join("|")}`);
  return { kind: "pane", pane: f.pane!, status };
}

export function watchAdd(root: string, f: AddFlags, env: Record<string, string | undefined>, now: number): Watch {
  const source = sourceOf(f);
  return new WatchStore(root).add({
    source,
    owner: ownerOf(root, f.for, env),
    ...(f.name !== undefined ? { name: f.name } : {}),
    ...(f.persistent ? { persistent: true } : {}),
    ...(f.timeout !== undefined ? { timeoutMs: parseDuration(f.timeout) } : {}),
  }, now);
}

export function watchList(root: string, opts: { all: boolean }, now: number): string[] {
  return new WatchStore(root).list()
    .filter((w) => opts.all || live(w))
    .map((w) => {
      const wakes = w.wakes.filter((t) => t > now - WAKE_WINDOW_MS).length;
      return [
        w.id,
        w.name,
        ownerText(w.owner),
        w.status,
        targetText(w.source),
        `age ${formatDuration(now - w.createdAt)}`,
        live(w) ? `expires in ${formatDuration(w.expiresAt - now)}` : `ended${w.reason ? `: ${w.reason}` : ""}`,
        `wakes ${wakes}/${WAKE_BUDGET} last hour`,
        `muted events ${w.mutedEvents}`,
      ].join("  ");
    });
}

function findLive(store: WatchStore, idOrName: string): Watch {
  const w = store.find(idOrName);
  if (!w) throw new Refusal(`no watch ${idOrName} (seori watch list --all)`);
  if (!live(w)) throw new Refusal(`watch ${w.id} ${w.name} is already ${w.status}`);
  return w;
}

export function watchStop(root: string, idOrName: string, now: number): Watch {
  const store = new WatchStore(root);
  const reason = "stopped by seori watch stop";
  const w: Watch = { ...findLive(store, idOrName), status: "stopped", reason };
  store.save(w);
  store.appendEvent(w.id, { at: now, ev: "stopped", reason });
  return w;
}

/** Unmutes a muted watch with a fresh wake budget; returns it and how many events it counted while muted. */
export function watchRearm(root: string, idOrName: string, now: number): { watch: Watch; missed: number } {
  const store = new WatchStore(root);
  const found = findLive(store, idOrName);
  if (found.status !== "muted") throw new Refusal(`watch ${found.id} ${found.name} is ${found.status}, not muted`);
  const watch: Watch = { ...found, status: "active", wakes: [], mutedEvents: 0 };
  store.save(watch);
  store.appendEvent(watch.id, { at: now, ev: "rearmed", missed: found.mutedEvents });
  return { watch, missed: found.mutedEvents };
}

/** The last `n` lines of the watch's event log, each as `<iso time> <the event's other fields as JSON>`. */
export function watchLog(root: string, idOrName: string, n: number): string[] {
  const store = new WatchStore(root);
  const w = store.find(idOrName);
  if (!w) throw new Refusal(`no watch ${idOrName} (seori watch list --all)`);
  const path = store.eventsPath(w.id);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-n).map((line) => {
    try {
      const { at, ...rest } = JSON.parse(line) as Record<string, unknown>;
      return `${typeof at === "number" ? new Date(at).toISOString() : "-"} ${JSON.stringify(rest)}`;
    } catch {
      return line; // a torn last line from a writer that crashed is shown as written
    }
  });
}
