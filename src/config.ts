// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ceilings } from "./store.ts";
import { isWorkflow, type Workflow, WORKFLOWS } from "./workflow.ts";

// `$SEORI_HOME/config.json`: optional settings for the agent (read by src/agent/profile.ts), the done flow, PR rules, supervision, the host guard and heavy slots.
// Every field is optional; a missing file means all defaults. A malformed field is an error naming it, never a silent
// default, so a typo (`toknes`) cannot switch a ceiling off without anyone noticing.

export type RepoIdentity = { readonly name: string; readonly email: string };

export type GuardThresholds = {
  /** 1-minute load per core (percent) that raises an alert, and the level it must fall under to clear. */
  readonly loadAlertPct: number;
  readonly loadOkPct: number;
  /** Free memory below this percentage holds new lanes and alerts. */
  readonly memFreeMinPct: number;
  /** Free disk (GB) on the volumes lanes work on (open lane directories, else $HOME) below this holds new lanes and alerts. */
  readonly diskFreeMinGb: number;
  /** More live hc terminals than this holds new lanes and alerts. */
  readonly panesMax: number;
};

export type SeoriConfig = {
  /**
   * This instance's name: the `seori.group` label of every hc terminal `seori up` and `seori start` open, and part of
   * its systemd unit names. Each seori on a PC has its own $SEORI_HOME and its own name, so two instances never share
   * one group.
   */
  readonly name: string;
  /** Expected Git identity per `owner/repo` (keys match without case), checked by verify-pr and the merge gate. */
  readonly repoIdentities: Readonly<Record<string, RepoIdentity>>;
  /** A READY lane with a Done line closes on its own this long after the claim unless the lead objects. */
  readonly closeAfterMin: number;
  /**
   * A lane with a thread gets its newest report posted there at most this often, in minutes. `null` (the default) is
   * off: no progress post is sent. It is the only spelling of off, so a config cannot say it two ways.
   */
  readonly progressEveryMin: number | null;
  /** A lane whose terminal shows a dialog (hc `blocked`) this long is told to the lead once as [BLOCKED-PROMPT]. */
  readonly blockedPromptMin: number;
  /**
   * How long `seori start` waits for a new lane to confirm its start (its first check 20 s after the kickoff, then every
   * 10 s). A slow host can take minutes before omp's first turn runs.
   */
  readonly startupWaitSeconds: number;
  readonly supervision: {
    /** Ceilings for every lane; `seori start --wall-minutes/--token-limit/--cost-limit` override per lane. */
    readonly defaults: Ceilings;
    /** A lane hc reports working with no report and no file change for this long is stalled (told to the lead once). */
    readonly hungAfterMin: number;
    /** Files or directories (relative to a lane's cwd) whose change counts as every lane's progress, beside git status. */
    readonly activityPaths: readonly string[];
  };
  readonly guard: GuardThresholds;
  readonly heavy: { readonly slots: number; readonly maxLoadPct: number };
  /** Every lane's workflow (src/workflow.ts) unless `seori start --workflow` says otherwise; unset: stock omp goal mode. */
  readonly workflow?: Workflow;
};

/** The name of an instance whose config.json sets none: the first seori on a PC keeps the label it always had. */
export const DEFAULT_NAME = "seori";

/** Letters (any script), digits, `.`, `_` and `-`, starting with a letter or digit: a label value and unit name part that needs no quoting. */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,39}$/u;

export const DEFAULT_CONFIG: SeoriConfig = {
  name: DEFAULT_NAME,
  repoIdentities: {},
  closeAfterMin: 5,
  progressEveryMin: null,
  blockedPromptMin: 10,
  startupWaitSeconds: 180,
  supervision: { defaults: { wallMinutes: null, tokens: null, costUsd: null }, hungAfterMin: 20, activityPaths: [] },
  guard: { loadAlertPct: 150, loadOkPct: 80, memFreeMinPct: 10, diskFreeMinGb: 20, panesMax: 30 },
  heavy: { slots: 1, maxLoadPct: 80 },
};

export const configPath = (root: string): string => join(root, "config.json");

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function only(o: Obj, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ConfigError(`${where}: unknown field "${k}" (known: ${allowed.join(", ")})`);
}

function num(o: Obj, k: string, where: string, fallback: number): number {
  const v = o[k];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ConfigError(`${where}.${k} must be a nonnegative number`);
  return v;
}

/** A cadence: a positive number of minutes, or null to switch it off. 0 is refused (it would post on every pass). */
function minutes(o: Obj, k: string, where: string, fallback: number | null): number | null {
  const v = o[k];
  if (v === undefined) return fallback;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ConfigError(`${where}.${k} must be a positive number of minutes, or null (off)`);
  return v;
}

/** A ceiling: a nonnegative number, or null to switch it off. */
export function ceiling(v: unknown, where: string, fallback: number | null): number | null {
  if (v === undefined) return fallback;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ConfigError(`${where} must be a nonnegative number or null`);
  return v;
}

export function loadConfig(root: string): SeoriConfig {
  const path = configPath(root);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${path}: not valid JSON (${(e as Error).message})`);
  }
  if (!isObj(raw)) throw new ConfigError(`${path}: must be a JSON object`);
  // talkWithOthers, agentTurnLimit and trusted belonged to the removed talking-with-others: a config.json that still has
  // them loads, and they are ignored. So does `"runtime": "hc"`, left from when seori could also run on herdr; any other
  // runtime is refused, since hc is the only one.
  if ("runtime" in raw && raw["runtime"] !== "hc") {
    throw new ConfigError(`${path}: "runtime" ${JSON.stringify(raw["runtime"])} is not supported; seori runs on hc only: remove "runtime" from config.json`);
  }
  only(raw, ["name", "agent", "runtime", "repoIdentities", "closeAfterMin", "progressEveryMin", "blockedPromptMin", "startupWaitSeconds", "supervision", "guard", "heavy", "hooks", "workflow", "talkWithOthers", "agentTurnLimit", "trusted"], path);
  const D = DEFAULT_CONFIG;

  const name = raw["name"] ?? D.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new ConfigError(`${path}: name must be 1-40 letters, digits, ".", "_" or "-", starting with a letter or digit`);
  }

  const repoIdentities: Record<string, RepoIdentity> = {};
  if (raw["repoIdentities"] !== undefined) {
    if (!isObj(raw["repoIdentities"])) throw new ConfigError(`${path}: repoIdentities must be an object of "owner/repo": {name, email}`);
    for (const [repo, id] of Object.entries(raw["repoIdentities"])) {
      if (!isObj(id) || typeof id["name"] !== "string" || !id["name"] || typeof id["email"] !== "string" || !id["email"]) {
        throw new ConfigError(`${path}: repoIdentities["${repo}"] needs a nonempty "name" and "email"`);
      }
      repoIdentities[repo.toLowerCase()] = { name: id["name"], email: id["email"] };
    }
  }

  const sup = raw["supervision"] ?? {};
  if (!isObj(sup)) throw new ConfigError(`${path}: supervision must be an object`);
  only(sup, ["defaults", "hungAfterMin", "activityPaths"], `${path} supervision`);
  const activityPaths = sup["activityPaths"] ?? D.supervision.activityPaths;
  if (!Array.isArray(activityPaths) || !activityPaths.every((p) => typeof p === "string" && p !== "")) {
    throw new ConfigError(`${path} supervision.activityPaths must be a list of non-empty paths`);
  }
  const defs = sup["defaults"] ?? {};
  if (!isObj(defs)) throw new ConfigError(`${path}: supervision.defaults must be an object`);
  only(defs, ["wallMinutes", "tokens", "costUsd"], `${path} supervision.defaults`);

  const guard = raw["guard"] ?? {};
  if (!isObj(guard)) throw new ConfigError(`${path}: guard must be an object`);
  only(guard, Object.keys(D.guard), `${path} guard`);

  const workflow = raw["workflow"];
  if (workflow !== undefined && !isWorkflow(workflow)) {
    throw new ConfigError(`${path}: workflow must be one of ${WORKFLOWS.map((w) => JSON.stringify(w)).join(", ")} (omp-ulw workflows run under omp's goal), got ${JSON.stringify(workflow)}`);
  }

  const heavy = raw["heavy"] ?? {};
  if (!isObj(heavy)) throw new ConfigError(`${path}: heavy must be an object`);
  only(heavy, ["slots", "maxLoadPct"], `${path} heavy`);
  const slots = num(heavy, "slots", `${path} heavy`, D.heavy.slots);
  if (!Number.isInteger(slots) || slots < 1) throw new ConfigError(`${path} heavy.slots must be a whole number of at least 1`);

  return {
    name,
    repoIdentities,
    closeAfterMin: num(raw, "closeAfterMin", path, D.closeAfterMin),
    progressEveryMin: minutes(raw, "progressEveryMin", path, D.progressEveryMin),
    blockedPromptMin: num(raw, "blockedPromptMin", path, D.blockedPromptMin),
    startupWaitSeconds: num(raw, "startupWaitSeconds", path, D.startupWaitSeconds),
    supervision: {
      defaults: {
        wallMinutes: ceiling(defs["wallMinutes"], `${path} supervision.defaults.wallMinutes`, D.supervision.defaults.wallMinutes),
        tokens: ceiling(defs["tokens"], `${path} supervision.defaults.tokens`, D.supervision.defaults.tokens),
        costUsd: ceiling(defs["costUsd"], `${path} supervision.defaults.costUsd`, D.supervision.defaults.costUsd),
      },
      hungAfterMin: num(sup, "hungAfterMin", `${path} supervision`, D.supervision.hungAfterMin),
      activityPaths: activityPaths as string[],
    },
    guard: {
      loadAlertPct: num(guard, "loadAlertPct", `${path} guard`, D.guard.loadAlertPct),
      loadOkPct: num(guard, "loadOkPct", `${path} guard`, D.guard.loadOkPct),
      memFreeMinPct: num(guard, "memFreeMinPct", `${path} guard`, D.guard.memFreeMinPct),
      diskFreeMinGb: num(guard, "diskFreeMinGb", `${path} guard`, D.guard.diskFreeMinGb),
      panesMax: num(guard, "panesMax", `${path} guard`, D.guard.panesMax),
    },
    heavy: { slots, maxLoadPct: num(heavy, "maxLoadPct", `${path} heavy`, D.heavy.maxLoadPct) },
    ...(workflow !== undefined ? { workflow } : {}),
  };
}

/** The identity configured for `owner/repo`, matched without case. */
export const identityFor = (config: SeoriConfig, repo: string): RepoIdentity | undefined => config.repoIdentities[repo.toLowerCase()];
