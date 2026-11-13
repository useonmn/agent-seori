// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// `seori adopt` registers a session that is already running as a lane; `seori sync` compares the lane registry with the
// live sessions of the home's seori.group group. Neither starts, stops or closes a session.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { KEY_RE, Refusal, reservedKey, type Deps } from "./harness.ts";
import { refText, sameSession } from "./refs.ts";
import { parseRef, type SessionRef } from "./runtime/types.ts";
import type { Lane } from "./store.ts";

const closed = (l: Lane): boolean => l.status === "done" || l.status === "lost";

/**
 * Registers the running session `refArg` as lane `key`. The session must exist and no open lane or role may own it.
 * `brief` (a file) is copied to the lane's brief path; without one the brief is a one-line note. Nothing is typed into
 * the session: an adopted agent already has its work.
 */
export async function adoptLane(d: Deps, key: string, refArg: string, opts: { brief?: string; cwd?: string } = {}): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && !closed(existing)) throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
  const ref = parseRef(refArg);
  if (!ref) throw new Refusal(`${refArg} is not a session ref (w1:p3, herdr:w1:p3 or hc:t7)`);
  const owner = d.store.lanes().find((l) => !closed(l) && sameSession(l.sessionRef, ref));
  if (owner) throw new Refusal(`session ${refText(ref)} already belongs to lane ${owner.key}`);
  const role = Object.entries(d.store.roles()).find(([, r]) => r !== undefined && sameSession(r, ref));
  if (role) throw new Refusal(`session ${refText(ref)} is the ${role[0]} session`);
  if (opts.brief !== undefined && !existsSync(opts.brief)) throw new Refusal(`brief not found: ${opts.brief}`);
  const probe = await d.runtimes.for(ref).probe(ref);
  if (probe.status === "gone") throw new Refusal(`no session ${refText(ref)}`);

  const briefPath = d.store.briefPath(key);
  mkdirSync(dirname(briefPath), { recursive: true });
  if (opts.brief !== undefined) copyFileSync(opts.brief, briefPath);
  else writeFileSync(briefPath, `Adopted session ${refText(ref)}; it was started before seori and has no brief.\n`);
  const now = d.now();
  const lane: Lane = {
    key, sessionRef: ref, paneId: ref.id, tabId: ref.container ?? "", brief: briefPath,
    cwd: resolve(opts.cwd ?? probe.cwd ?? process.cwd()),
    status: "working", createdAt: now, lastActivityAt: now, nudges: 0,
    log: [{ at: now, kind: "start", text: `adopted ${refText(ref)}` }],
  };
  d.store.saveLane(lane);
  return lane;
}

export type SyncResult = {
  /** One line per finding, in order: `LANE`, `LOST`/`VANISHED`, `UNREGISTERED`, `UNKNOWN`. */
  readonly lines: string[];
  /** Lanes marked lost (--write only). */
  readonly lost: string[];
};

const OPEN_RUNNING: ReadonlySet<string> = new Set(["working", "waiting", "paused"]);

/**
 * Registry vs live sessions. An open lane whose session is not in the group's list and whose own probe says `gone` has
 * vanished: with `write`, a working, waiting or paused one is marked lost (the same record duty writes); a ready one
 * keeps its record because its done claim is still to be closed. Agent sessions in the group that no lane or role
 * owns are listed as UNREGISTERED. A lane whose probe fails is UNKNOWN and untouched: a failed read is never `gone`.
 * No session is ever closed or messaged.
 */
export async function syncRegistry(d: Deps, write: boolean): Promise<SyncResult> {
  const lines: string[] = [];
  const lost: string[] = [];
  const lanes = d.store.lanes();
  const rt = d.runtimes.default;
  const live = new Set<string>();
  const owned = new Set<string>([...Object.values(d.store.roles()), ...lanes.map((l) => l.sessionRef)].filter((r): r is SessionRef => r !== undefined).map(refText));
  const unregistered: string[] = [];
  const name = loadConfig(d.store.root).name;
  try {
    for (const g of (await rt.groups()).filter((x) => x.label === name)) {
      for (const s of await rt.list({ group: g.id })) {
        live.add(refText(s.ref));
        if (s.agent !== undefined && !owned.has(refText(s.ref))) {
          unregistered.push(`UNREGISTERED ${refText(s.ref)} agent=${s.agent} status=${s.status ?? "unknown"} (seori adopt <key> --ref ${refText(s.ref)})`);
        }
      }
    }
  } catch (e) {
    lines.push(`UNKNOWN group ${name} could not be listed (${e instanceof Error ? e.message : String(e)})`);
  }

  for (const lane of lanes.filter((l) => !closed(l))) {
    const text = refText(lane.sessionRef);
    if (live.has(text)) {
      lines.push(`LANE ${lane.key} ${text} ${lane.status}`);
      continue;
    }
    let status: string;
    try {
      status = (await d.runtimes.for(lane.sessionRef).probe(lane.sessionRef)).status;
    } catch (e) {
      lines.push(`UNKNOWN lane ${lane.key} session ${text} probe failed (${e instanceof Error ? e.message : String(e)}); untouched`);
      continue;
    }
    if (status !== "gone") {
      lines.push(`LANE ${lane.key} ${text} ${lane.status}`);
      continue;
    }
    if (write && OPEN_RUNNING.has(lane.status)) {
      const now = d.now();
      lane.status = "lost";
      delete lane.pausedFrom;
      lane.log.push({ at: now, kind: "lost", text: "session gone (seori sync)" });
      d.store.saveLane(lane);
      lost.push(lane.key);
      lines.push(`LOST ${lane.key} session ${text} is gone; lane marked lost`);
    } else {
      lines.push(`VANISHED ${lane.key} session ${text} is gone (status=${lane.status})${write ? "; record kept" : "; run seori sync --write to mark it lost"}`);
    }
  }
  lines.push(...unregistered);
  return { lines, lost };
}
