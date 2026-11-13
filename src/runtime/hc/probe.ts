// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import type { Exec } from "../exec.ts";
import { interactiveShellInFront } from "../foreground.ts";
import { omoScreenIdle } from "../herdr/client.ts";
import type { AgentStatus, ForegroundProcess, Probe } from "../types.ts";
import { hcCall, isKind } from "./exec.ts";

/** Recent lines read to look for omo's idle input box (the same window the herdr runtime reads). */
const SCREEN_LINES = 30;

/** hc's OSC 7501 words seori has a status for; `error` and any other word read as `unknown` (nothing is typed). */
const REPORTED: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function foregroundOf(value: unknown): ForegroundProcess | undefined {
  const fg = rec(value);
  const name = text(fg?.["name"]);
  if (fg === undefined || name === undefined) return undefined;
  const argv = Array.isArray(fg["argv"]) ? fg["argv"].filter((a): a is string => typeof a === "string") : [name];
  const pid = num(fg["pid"]);
  return { name, argv, ...(pid === undefined ? {} : { pid }) };
}

/** The status word of hc's `status` field (an object `{app,state}`, or a bare word); undefined when it never reported. */
export function statusWord(value: unknown): AgentStatus | undefined {
  const word = typeof value === "string" ? value : text(rec(value)?.["state"]);
  if (word === undefined) return undefined;
  return REPORTED.has(word) ? (word as AgentStatus) : "unknown";
}

/**
 * One `hc get` record as a Probe. The status is the program's own OSC 7501 word; a program that never reported
 * (`status: null`, a plain shell is "silent") is a `shell` when an interactive shell leads the foreground, else
 * `unknown`, never idle. An unreadable foreground counts as a shell in front. The screen check is applied by `probe`.
 */
export function parseProbe(terminal: unknown): Probe {
  const t = rec(terminal) ?? {};
  if (t["state"] === "finished") return { status: "gone", shellInFront: false };
  const fg = foregroundOf(t["foreground"]);
  const foreground = fg === undefined ? undefined : [fg];
  const shellInFront = interactiveShellInFront({ foreground_processes: foreground });
  const status = statusWord(t["status"]) ?? (shellInFront ? "shell" : "unknown");
  const agent = text(rec(t["status"])?.["app"]) ?? fg?.name;
  const [rootPid, turn, title, cwd] = [num(t["pid"]), num(t["turn"]), text(t["title"]), text(t["cwd"])];
  return {
    status,
    ...(agent === undefined ? {} : { agent }),
    ...(fg?.pid === undefined ? {} : { pgid: fg.pid }),
    ...(rootPid === undefined ? {} : { rootPid }),
    ...(turn === undefined ? {} : { turn }),
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    shellInFront,
    ...(foreground === undefined ? {} : { foreground }),
  };
}

/** `hc get` as a Probe with no screen check; a terminal hc no longer knows is `gone`, any other failure throws. */
export async function getProbe(exec: Exec, id: string): Promise<Probe> {
  try {
    return parseProbe(await hcCall(exec, ["get", id]));
  } catch (e) {
    if (isKind(e, "not_found")) return { status: "gone", shellInFront: false };
    throw e;
  }
}

/** Believe the screen only when it positively shows omo's idle input; a failed read is doubt and stays working. */
async function screenShowsIdle(exec: Exec, id: string): Promise<boolean> {
  try {
    const result = await hcCall(exec, ["read", id, "--lines", String(SCREEN_LINES)]);
    return typeof result["text"] === "string" && omoScreenIdle(result["text"]);
  } catch {
    return false;
  }
}

/** A probe plus hc's own status word, which `deliver` needs for its compare-and-send gate. */
export type HcProbe = { readonly probe: Probe; readonly word: AgentStatus };

/**
 * `hc get`, then the screen check: omo reports `working` over OSC 7501 for as long as any monitor or background
 * session is live, even between turns, so a `working` word with no shell in front reads `idle` when the screen
 * positively shows the idle input (a lone `❯` between two rules).
 */
export async function probeWithWord(exec: Exec, id: string): Promise<HcProbe> {
  const parsed = await getProbe(exec, id);
  const word = parsed.status;
  if (word !== "working" || parsed.shellInFront || !(await screenShowsIdle(exec, id))) return { probe: parsed, word };
  return { probe: { ...parsed, status: "idle" }, word };
}

export async function probe(exec: Exec, id: string): Promise<Probe> {
  return (await probeWithWord(exec, id)).probe;
}
