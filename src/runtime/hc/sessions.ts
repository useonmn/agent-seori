// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { homeTag } from "../../systemd.ts";
import type { Exec } from "../exec.ts";
import type { CreateSpec, GroupInfo, SessionInfo, SessionRef, SessionRole } from "../types.ts";
import { hcCall, isKind } from "./exec.ts";
import { statusWord } from "./probe.ts";

/** The label that groups seori's terminals (hc has no workspaces); never `dori.group`. */
export const GROUP_LABEL = "seori.group";
/** The label naming the seori home a terminal was opened for (its homeTag), so a down closes only its own home's terminals. */
export const HOME_LABEL = "seori.home";
/** The group of a spec that names none. */
export const DEFAULT_GROUP = "seori";
/**
 * The messenger token variables the adapters read (telegram.ts, discord.ts, slack.ts; a test keeps this list equal to
 * theirs). A terminal inherits the hc core's environment, so an agent terminal unsets them and a token exported where
 * the core started is not in the environment of the commands a lane, the lead or duty runs. This is defence in depth
 * only: those commands run as the owner and can still read $SEORI_HOME/secrets.json.
 */
export const MESSENGER_TOKEN_ENV = [
  "SEORI_TELEGRAM_TOKEN",
  "SEORI_DISCORD_TOKEN",
  "SEORI_SLACK_BOT_TOKEN",
  "SEORI_SLACK_APP_TOKEN",
] as const;
/**
 * The terminals that run only seori's own resident process and talk to the messengers (macOS): the daemon and the duty
 * loop, whose alerts go out through the adapters. The hourly loop sends nothing to a messenger.
 */
const TOKEN_ROLES: ReadonlySet<SessionRole> = new Set<SessionRole>(["daemon", "duty-loop"]);
const NAME_MAX = 32;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RM_RETRIES = 5;
export const RM_RETRY_MS = 200;

/**
 * hc's name rule: 1-32 of a-z 0-9 - _ . starting with a letter or digit, and never id-shaped (`t7`), because a name
 * is resolved before an id. Lowercased, other characters become `-`, leading separators are dropped; undefined when
 * nothing usable is left (the terminal then has no name, only its labels).
 */
export function slugName(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, NAME_MAX);
  if (slug === "" || /^t[0-9]+$/.test(slug)) return undefined;
  return slug;
}

const rows = (result: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(result["terminals"])
    ? result["terminals"].filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    : [];
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
// Addresses with a machine prefix (`machine/t7`) are another core's terminals, mirrored into this core's list.
const isLocal = (address: string | undefined): address is string => address !== undefined && !address.includes("/");

/** This core's live local terminal rows (`hc ls` hides finished ones), optionally of one group. */
async function liveRows(exec: Exec, group?: string): Promise<Record<string, unknown>[]> {
  const result = await hcCall(exec, ["ls", ...(group === undefined ? [] : ["--label", `${GROUP_LABEL}=${group}`])]);
  return rows(result).filter((t) => isLocal(str(t["address"])) && t["state"] === "live");
}

/**
 * The `hc run` argv for a spec: labels for grouping, the env through the `env` utility (one argv element per K=V), the
 * messenger tokens unset first except in a TOKEN_ROLES terminal.
 */
export function createArgv(spec: CreateSpec, shell: string, name: string | undefined): string[] {
  for (const key of Object.keys(spec.env))
    if (!ENV_KEY.test(key)) throw new Error(`env key ${JSON.stringify(key)} is not a shell variable name`);
  const labels = [
    `${GROUP_LABEL}=${spec.group ?? DEFAULT_GROUP}`,
    `seori.role=${spec.role}`,
    `seori.name=${spec.name}`,
    ...(spec.role === "lane" ? [`seori.lane=${spec.name}`] : []),
    ...(spec.home === undefined ? [] : [`${HOME_LABEL}=${homeTag(spec.home)}`]),
  ];
  return [
    "run",
    "--bg",
    "--no-parent",
    "--no-notify",
    ...labels.flatMap((l) => ["--label", l]),
    "--cwd",
    spec.cwd,
    ...(name === undefined ? [] : ["--name", name]),
    "--",
    "env",
    ...(TOKEN_ROLES.has(spec.role) ? [] : MESSENGER_TOKEN_ENV.flatMap((k) => ["-u", k])),
    ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    shell,
  ];
}

/**
 * A terminal running the user's shell with the env set, no parent and no notes (seori's inbox is the only delivery
 * path). The slug name is used only when no live terminal holds it; a name taken in between is retried without one.
 * Identity is the address plus labels, never the name.
 */
export async function create(exec: Exec, spec: CreateSpec, shell: string): Promise<SessionRef> {
  const slug = slugName(spec.name);
  const taken = slug === undefined ? false : (await liveRows(exec)).some((t) => str(t["name"]) === slug);
  const name = taken ? undefined : slug;
  let result: Record<string, unknown>;
  try {
    result = await hcCall(exec, createArgv(spec, shell, name));
  } catch (e) {
    if (name === undefined || !isKind(e, "name_taken")) throw e;
    result = await hcCall(exec, createArgv(spec, shell, undefined));
  }
  const id = str(result["address"]);
  if (id === undefined) throw new Error("hc run did not return an address");
  return { runtime: "hc", id, group: spec.group ?? DEFAULT_GROUP };
}

/** Types the command into the session's shell: a shell reports no status, so there is no `--if` gate. */
export async function start(exec: Exec, id: string, command: string): Promise<void> {
  await hcCall(exec, ["send", id, "--", command]);
}

/** One label of an `hc get` answer. */
const labelOf = (got: Record<string, unknown>, key: string): string | undefined => {
  const labels = got["labels"];
  return typeof labels === "object" && labels !== null ? str((labels as Record<string, unknown>)[key]) : undefined;
};

/**
 * This core's live terminals, all of them or those labelled `seori.group=<group>`. With `homes`, each terminal's
 * seori.home label is read with `hc get` (`hc ls` rows carry no labels) into `home`; one removed in between is skipped.
 */
export async function list(exec: Exec, group: string | undefined, homes = false): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  for (const t of await liveRows(exec, group)) {
    const id = str(t["address"]) ?? "";
    let home: string | undefined;
    if (homes) {
      let got: Record<string, unknown>;
      try {
        got = await hcCall(exec, ["get", id]);
      } catch (e) {
        if (isKind(e, "not_found")) continue;
        throw e;
      }
      if (got["state"] !== "live") continue;
      home = labelOf(got, HOME_LABEL);
    }
    out.push(info(t, id, group, home));
  }
  return out;
}

function info(t: Record<string, unknown>, id: string, group: string | undefined, home: string | undefined): SessionInfo {
  const [name, cwd, status, agent] = [str(t["name"]), str(t["cwd"]), statusWord(t["status"]), str(t["agent"])];
  return {
    ref: { runtime: "hc", id, ...(group === undefined ? {} : { group }) },
    ...(name === undefined ? {} : { name }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(status === undefined ? {} : { status }),
    ...(agent === undefined ? {} : { agent }),
    ...(home === undefined ? {} : { home }),
  };
}

/**
 * Every `seori.group` value on a live terminal of this core, as a group whose id is its label. `hc ls` rows carry no
 * labels, so each terminal is read with `hc get`; one removed in between is skipped.
 */
export async function groups(exec: Exec): Promise<GroupInfo[]> {
  const seen = new Set<string>();
  for (const t of await liveRows(exec)) {
    let got: Record<string, unknown>;
    try {
      got = await hcCall(exec, ["get", str(t["address"]) ?? ""]);
    } catch (e) {
      if (isKind(e, "not_found")) continue;
      throw e;
    }
    const group = labelOf(got, GROUP_LABEL);
    if (group !== undefined && got["state"] === "live") seen.add(group);
  }
  return [...seen].map((g) => ({ id: g, label: g }));
}

/**
 * Kill, then remove the record. A program that takes a moment to die makes `rm` answer `live`: retried 5 times
 * 200 ms apart; still live after that is logged (the kill was sent), not thrown. An unknown terminal is already closed.
 */
export async function close(
  exec: Exec,
  id: string,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
): Promise<void> {
  try {
    await hcCall(exec, ["kill", id]);
  } catch (e) {
    if (isKind(e, "not_found")) return;
    if (!isKind(e, "finished")) throw e;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await hcCall(exec, ["rm", id]);
      return;
    } catch (e) {
      if (isKind(e, "not_found")) return;
      if (!isKind(e, "live")) throw e;
      if (attempt >= RM_RETRIES) {
        log(`seori: hc terminal ${id} still running after kill; left in place`);
        return;
      }
      await sleep(RM_RETRY_MS);
    }
  }
}

export function selfRef(env: Readonly<Record<string, string | undefined>>): SessionRef | undefined {
  const id = env["HC_TERMINAL_ID"];
  return id === undefined || id === "" ? undefined : { runtime: "hc", id };
}
