import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { driftCheck } from "./boot-checks.ts";
import { Channel } from "./channel.ts";
import { ConfigError, configPath, loadConfig } from "./config.ts";
import { heartbeatPath, healthPath } from "./daemon.ts";
import { loadHooks } from "./hooks.ts";
import { HEARTBEAT_STALE_MS, type Deps } from "./harness.ts";
import { loadMessengers } from "./messenger/adapter.ts";
import { ToolError } from "./runtime/index.ts";
import { checkedLane, type Lane, type StoredLane } from "./store.ts";
import { WatchStore } from "./watch/store.ts";
import { worklogLines, worklogPath, worklogRead } from "./worklog.ts";
import { HerdrRecord, refText } from "./refs.ts";
import { startAgain } from "./restart.ts";

// `seori boot`: the read-only check a lead runs after a restart or a compaction, so it resumes from the record and not
// from memory. It changes nothing: no lane or role write, no relaunch, no stopped watch, no closed message, and it
// creates no file or directory either (stores whose directory is missing are read as empty).

/** A lane seori still owns: everything but done and lost. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(["working", "waiting", "ready", "paused"]);
/** Longest text shown from a report, a final answer or a channel message. */
const PREVIEW_CHARS = 80;
/**
 * Most of owner.md that boot prints. A profile is a page of short facts; the bound keeps a file grown far past that
 * from crowding the lead's context, and the truncation line points at the file for the rest.
 */
export const OWNER_PROFILE_MAX_CHARS = 8_000;

/** The owner's profile: who they are, how to address them, their work, tools and standing rules. The owner may edit it. */
export const ownerProfilePath = (root: string): string => join(root, "owner.md");

/** One session from the runtime's list: its id and, when the runtime detects one, the agent and its status. */
type ListedPane = { readonly paneId: string; readonly agent?: string; readonly status: string };

const preview = (text: string): string => JSON.stringify(text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}...` : text);
const iso = (at: number): string => new Date(at).toISOString();
const ageText = (ms: number): string => `${Math.max(0, Math.floor(ms / 1000))}s`;

/**
 * The runtime's session list (`hc ls`). Throws on a failed or unparsable list: a failed list is never
 * an empty one, so no lane is called vanished on it.
 */
async function listPanes(d: Deps): Promise<ListedPane[]> {
  const rt = d.runtime;
  let sessions;
  try {
    sessions = await rt.list();
  } catch (e) {
    if (e instanceof ToolError) throw new Error(`hc ls exited ${e.result.code}: ${(e.result.stderr || e.result.stdout).trim()}`);
    throw e;
  }
  return sessions.map((s) => ({ paneId: refText(s.ref), ...(s.agent ? { agent: s.agent } : {}), status: s.status ?? "unknown" }));
}

/** Every lane file, parsed one by one so a damaged file is named and the other lanes are still checked. */
function scanLanes(root: string): { lanes: Lane[]; unreadable: string[] } {
  const dir = join(root, "lanes");
  const lanes: Lane[] = [];
  const unreadable: string[] = [];
  if (!existsSync(dir)) return { lanes, unreadable };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const lane = JSON.parse(readFileSync(path, "utf8")) as StoredLane;
      if (typeof lane?.key !== "string" || typeof lane.paneId !== "string" || typeof lane.status !== "string" || !Array.isArray(lane.log)) {
        throw new Error("not a lane record");
      }
      const checked = checkedLane(lane, path);
      if (checked) lanes.push(checked);
    } catch (e) {
      unreadable.push(e instanceof HerdrRecord ? `${path} (${e.message})` : path);
    }
  }
  lanes.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  return { lanes, unreadable };
}

/** A JSON file: undefined when absent, "unreadable" when present but not JSON. */
function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "unreadable";
  }
}

/**
 * The owner profile for the top of the boot: an `OWNER` header, then the file's text with each line indented by two
 * spaces, so nothing in the owner's text can pass for a boot line (`DRIFT`, `BOOT checked`). A missing file is one line;
 * only a file that is there and cannot be read is a failure.
 */
function ownerProfileLines(root: string): { lines: string[]; readable: boolean } {
  const path = ownerProfilePath(root);
  if (!existsSync(path)) return { lines: [`OWNER none: no profile at ${path} yet; write it when you learn something durable about the owner`], readable: true };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { lines: [`OWNER unreadable ${path} (${e instanceof Error ? e.message : String(e)})`], readable: false };
  }
  const body = text.trimEnd();
  if (!body) return { lines: [`OWNER ${path} empty`], readable: true };
  // Cut at the last line break inside the bound, so the shown part ends on a whole line.
  const lastBreak = body.lastIndexOf("\n", OWNER_PROFILE_MAX_CHARS);
  const shown = body.length > OWNER_PROFILE_MAX_CHARS ? body.slice(0, lastBreak > 0 ? lastBreak : OWNER_PROFILE_MAX_CHARS) : body;
  const lines = [`OWNER ${path} (the owner's profile; their edits win over memory)`, ...shown.split(/\r?\n/).map((line) => `  ${line}`)];
  if (shown.length < body.length) lines.push(`OWNER truncated: showed ${shown.length} of ${body.length} characters; read the rest in ${path}`);
  return { lines, readable: true };
}

/**
 * Read-only recovery check after a restart or compaction. Lines, in order:
 * `OWNER` and the owner profile (owner.md) indented below it; `CONFIG`, `MESSENGERS`; `LEAD`/`DUTY` pane and status;
 * `PANES` summary, `VANISHED` (an open lane whose pane is gone),
 * `UNREGISTERED` (agent panes no role and no open lane owns); per open lane `READY`, `PAUSED`, then `REPORT`/`NO-REPORT`
 * (its last report); `WORKLOG`/`OPEN` items; `CHANNEL`/`MSG` open lead channel messages; `WATCHES`/`ORPHAN-WATCH` live
 * watches whose owner lane is closed; `DAEMON` heartbeat age and `MESSENGER` health; then `BOOT checked` or
 * `BOOT incomplete` (an input could not be read; each such input has its own line) or `BOOT failed` (registry drift).
 * `DRIFT` lines (an open lane whose session is gone; an agent session in the home's seori.group without a lane or role
 * record) fail the boot, one line per problem. Other findings such as a stale heartbeat are reported, not failures:
 * `complete` is false when an input could not be read or the registry drifted.
 */
export async function bootReport(d: Deps): Promise<{ lines: string[]; complete: boolean }> {
  const root = d.store.root;
  const now = d.now();
  const lines: string[] = [];
  let complete = true;
  let drift = 0;
  const failed = (line: string): void => {
    complete = false;
    lines.push(line);
  };

  // The owner profile first: who the lead works for frames everything below it, and it lands in a new lead's context
  // with the boot the [START] line already asks for, with no separate step.
  const owner = ownerProfileLines(root);
  if (owner.readable) lines.push(...owner.lines);
  else for (const line of owner.lines) failed(line);

  let group: string | undefined;
  try {
    group = loadConfig(root).name;
    loadHooks(root);
    lines.push(existsSync(configPath(root)) ? `CONFIG ok ${configPath(root)}` : "CONFIG defaults (no config.json)");
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    failed(`CONFIG invalid: ${e.message}`);
  }
  let messengerSources: string[] = [];
  try {
    messengerSources = loadMessengers(root).map((m) => m.source);
    lines.push(messengerSources.length ? `MESSENGERS ${messengerSources.join(" ")}` : "MESSENGERS none configured");
  } catch (e) {
    failed(`MESSENGERS invalid: ${e instanceof Error ? e.message : String(e)}`);
  }

  const { lanes, unreadable } = scanLanes(root);
  for (const path of unreadable) failed(`LANES unreadable ${path}`);
  const open = lanes.filter((lane) => OPEN_STATUSES.has(lane.status));

  let panes: ListedPane[] | undefined;
  try {
    panes = await listPanes(d);
  } catch (e) {
    failed(`PANES unavailable (${e instanceof Error ? e.message : String(e)})`);
  }
  const byId = new Map((panes ?? []).map((p) => [p.paneId, p]));
  const roles = d.store.roles();
  for (const role of ["lead", "duty"] as const) {
    const ref = roles[role];
    const paneId = ref && refText(ref);
    const label = role.toUpperCase();
    if (!paneId) lines.push(`${label} unregistered`);
    else if (!panes) lines.push(`${label} pane=${paneId} status=unknown`);
    else lines.push(`${label} pane=${paneId} status=${byId.get(paneId)?.status ?? "gone"}`);
  }
  if (panes) {
    const vanished = open.filter((lane) => !byId.has(refText(lane.sessionRef)));
    const owned = new Set([...Object.values(roles).map(refText), ...open.map((lane) => refText(lane.sessionRef))]);
    const unregistered = panes.filter((p) => p.agent !== undefined && !owned.has(p.paneId));
    lines.push(`PANES live=${panes.length} lanesOpen=${open.length} vanished=${vanished.length} unregistered=${unregistered.length}`);
    for (const lane of vanished) {
      // A paused lane whose pane is gone was closed while waiting (a restart closes paused panes too), not failed: the
      // next duty pass marks it lost, and from then on this command resumes it.
      const resume = lane.status === "paused" ? `; it was paused: once duty marks it lost, resume it with: ${startAgain(lane, d.seoriCmd)}` : "";
      lines.push(`VANISHED ${lane.key} pane=${refText(lane.sessionRef)} status=${lane.status}; lane record kept, nothing relaunched${resume}`);
    }
    for (const p of unregistered) lines.push(`UNREGISTERED ${p.paneId} agent=${p.agent} status=${p.status}`);
    const found = await driftCheck({ runtime: d.runtime, open, lanes, roles: Object.values(roles), liveIds: new Set(byId.keys()), group });
    lines.push(...found.lines);
    drift = found.problems;
  }

  for (const lane of open) {
    if (lane.status === "ready") {
      const at = lane.final?.at ?? lane.lastActivityAt;
      lines.push(`READY ${lane.key} since=${iso(at)} waiting=${Math.floor((now - at) / 60_000)}min done=${lane.done ? "signals" : "by-hand"} ${preview(lane.final?.text ?? "")}`);
    }
    if (lane.status === "paused") {
      const pause = lane.log.findLast((entry) => entry.kind === "pause");
      lines.push(`PAUSED ${lane.key} from=${lane.pausedFrom ?? "unknown"}${pause ? ` since=${iso(pause.at)}` : ""}`);
    }
    const last = lane.log.findLast((entry) => entry.kind === "report");
    lines.push(last
      ? `REPORT ${lane.key} status=${lane.status} at=${iso(last.at)} ${preview(last.text)}`
      : `NO-REPORT ${lane.key} status=${lane.status} started=${iso(lane.createdAt)}`);
  }

  try {
    const read = worklogRead(root);
    lines.push(...worklogLines(read.items));
    for (const problem of read.problems) failed(`WORKLOG damaged ${problem}`);
    // A next or note that raced a close was ignored: worth naming, but the record is whole.
    for (const warning of read.warnings) lines.push(`WORKLOG warning ${warning}`);
  } catch (e) {
    failed(`WORKLOG unreadable ${worklogPath(root)} (${e instanceof Error ? e.message : String(e)})`);
  }

  try {
    // Channel's constructor creates lead/; with no lead/ there is no message to list. Other people's open messages are
    // listed too (marked), so the lead still sees them after a restart.
    const states = existsSync(join(root, "lead")) ? new Channel(root).open({ withOthers: true }) : [];
    lines.push(`CHANNEL open=${states.length}`);
    for (const s of states) {
      const flags = [s.uncertain ? "uncertain" : "", s.gaveUp ? "gave-up" : "", s.entered ? "entered" : ""].filter(Boolean);
      const who = s.row.kind === "watch" ? `watch=${s.row.name}` : `from=${s.row.from}${s.row.notOwner ? " (not owner)" : ""}`;
      lines.push(`MSG ${s.row.id} ${s.row.kind} ${who} age=${ageText(now - s.row.at)} deliveries=${s.deliveries}${flags.length ? ` ${flags.join(",")}` : ""} ${preview(s.row.text)}`);
    }
  } catch (e) {
    failed(`CHANNEL unreadable (${e instanceof Error ? e.message : String(e)})`);
  }

  try {
    // WatchStore's constructor creates watches/; with no watches/ there is no watch.
    const watches = existsSync(join(root, "watches")) ? new WatchStore(root).list() : [];
    const live = watches.filter((w) => w.status === "active" || w.status === "muted");
    const laneByKey = new Map(lanes.map((lane) => [lane.key, lane]));
    const orphans = live.flatMap((w) => {
      if (w.owner.kind !== "lane") return [];
      const lane = laneByKey.get(w.owner.key);
      return lane && OPEN_STATUSES.has(lane.status) ? [] : [{ w, key: w.owner.key, laneStatus: lane?.status ?? "missing" }];
    });
    lines.push(`WATCHES live=${live.length} orphaned=${orphans.length}`);
    for (const { w, key, laneStatus } of orphans) {
      lines.push(`ORPHAN-WATCH ${w.id} name=${w.name} owner=lane:${key} lane=${laneStatus} status=${w.status}; stop it with: seori watch stop ${w.id}`);
    }
  } catch (e) {
    failed(`WATCHES unreadable (${e instanceof Error ? e.message : String(e)})`);
  }

  const beat = readJson(heartbeatPath(root)) as { at?: unknown } | "unreadable" | undefined;
  if (beat === undefined) lines.push("DAEMON no heartbeat");
  else if (beat === "unreadable" || typeof beat?.at !== "number") failed(`DAEMON heartbeat unreadable ${heartbeatPath(root)}`);
  else lines.push(`DAEMON heartbeat age=${ageText(now - beat.at)} ${now - beat.at <= HEARTBEAT_STALE_MS ? "fresh" : "stale"}`);

  // Configured messengers, plus any source the daemon left a health file for.
  const messengerDir = join(root, "messenger");
  const healthSources = existsSync(messengerDir)
    ? readdirSync(messengerDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(healthPath(root, e.name))).map((e) => e.name)
    : [];
  for (const source of [...new Set([...messengerSources, ...healthSources])].sort()) {
    const health = readJson(healthPath(root, source)) as { failingSince?: unknown; failures?: unknown; error?: unknown } | "unreadable" | undefined;
    if (health === undefined) lines.push(`MESSENGER ${source} receiving (no failure recorded)`);
    else if (health === "unreadable" || typeof health?.failingSince !== "number") failed(`MESSENGER ${source} health unreadable ${healthPath(root, source)}`);
    else {
      lines.push(`MESSENGER ${source} failing since=${iso(health.failingSince)} failures=${String(health.failures)} error=${JSON.stringify(String(health.error))}`);
    }
  }

  const verdict = !complete ? "incomplete" : drift > 0 ? "failed" : "checked";
  lines.push(`BOOT ${verdict}${drift > 0 ? ` (${drift} drift)` : ""} read-only; nothing restarted, written or stopped`);
  return { lines, complete: complete && drift === 0 };
}
