import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { type Deps, type DutyEvent, tellLead } from "./harness.ts";
import { refText } from "./refs.ts";
import type { Probe, SessionRef } from "./runtime/index.ts";
import type { LaneStatus } from "./store.ts";

// Pane health, each duty pass: an agent that left its pane (a shell is in front: omp exited, crashed or was suspended
// with Ctrl+Z) and an agent session in the group that nothing owns. Neither changes a pane state the rest of duty
// reads: a dead lane keeps its record, so the lead can restart it, and an unowned session is never closed.

/** How many passes in a row a pane must show a shell before it is told: one read can catch omp between two runs. */
export const DEAD_AFTER_PASSES = 2;
/**
 * How long an agent session must stay unowned before it is told. `seori start` opens the terminal and starts omp before
 * the lane is recorded, and the hourly loop does the same, so a fresh lane is unowned for its first minute or two.
 */
export const UNOWNED_AFTER_MS = 5 * 60_000;
/** A pass this soon after the last one that saw the pane (a `seori duty --once` beside the loop) does not count again. */
export const MIN_PASS_GAP_MS = 30_000;

/** Lanes whose agent is expected to be in front: running, or paused (a resume needs the agent). */
const AGENT_EXPECTED: ReadonlySet<LaneStatus> = new Set(["working", "waiting", "paused"]);
/** Lanes that still own their pane, as `seori boot` counts them: every lane not done and not lost. */
const CLOSED: ReadonlySet<LaneStatus> = new Set(["done", "lost"]);

/**
 * No agent in front of a live pane: it exited (nothing reports a status, and a shell leads: `shell`) or it was suspended
 * with Ctrl+Z (hc still reports its last word, idle, while the shell leads). For an agent still reporting, a foreground
 * that could not be read is not taken for a shell.
 */
export const agentGone = (p: Probe): boolean =>
  p.status === "shell" || (p.status !== "gone" && p.shellInFront && p.foreground !== undefined);

/** One spell per pane id: when it began, when it was last counted, on how many passes, and when the lead was told. */
type Spell = { kind: "dead" | "unowned"; since: number; seen: number; passes: number; told?: number };
type PaneState = Record<string, Spell>;

const statePath = (root: string): string => join(root, "duty", "panes.json");

function readState(root: string): PaneState {
  const path = statePath(root);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as PaneState) : {};
  } catch {
    // A torn or damaged state file only costs the current spells: they are counted again from the next pass.
    return {};
  }
}

function writeState(root: string, state: PaneState): void {
  const path = statePath(root);
  mkdirSync(join(root, "duty"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/** The spell after this pass: a new one, the same (a pass too soon after the last), or one pass further. */
function nextSpell(prev: Spell | undefined, kind: Spell["kind"], now: number): Spell {
  if (prev === undefined || prev.kind !== kind) return { kind, since: now, seen: now, passes: 1 };
  if (now - prev.seen < MIN_PASS_GAP_MS) return prev;
  return { ...prev, seen: now, passes: prev.passes + 1 };
}

// hc commands take the bare terminal id (`t5`); `hc:t5` is seori's ref text, which `seori adopt --ref` reads.
export const deadLaneText = (key: string, ref: SessionRef): string =>
  `[DEAD ${key}] pane ${refText(ref)} shows a shell on ${DEAD_AFTER_PASSES} duty passes in a row: the lane's agent exited or ` +
  `was suspended, so nothing is typed there and no nudge goes out. Read the pane (hc read ${ref.id}); to bring the lane ` +
  `back, close the pane (hc kill ${ref.id}: the next duty pass marks the lane lost) and start it again with its brief`;

export const deadDutyText = (ref: SessionRef): string =>
  `[DEAD duty] the duty pane ${refText(ref)} shows a shell on ${DEAD_AFTER_PASSES} duty passes in a row: its agent exited or ` +
  `was suspended. Read the pane (hc read ${ref.id}), then close it (hc kill ${ref.id}) and run seori up, which reopens only ` +
  `the missing duty pane`;

export const unownedText = (ref: SessionRef, agent: string, minutes: number): string =>
  `[UNREGISTERED ${refText(ref)}] an ${agent} session in this seori group has had no lane and no role for ${minutes} min, ` +
  `so nothing supervises it: seori adopt <key> --ref ${refText(ref)} to make it a lane, or close it (hc kill ${ref.id})`;

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

/**
 * The pane-health pass. A pane's spell starts when it is first seen in that state and ends (its entry is dropped) on
 * the first pass it is not, so a later spell is told again. The lead is told once per spell, and only while a lead is
 * recorded (with none, the spell waits for one); the mark is saved before the message goes out, so a failed delivery
 * is never repeated every minute (tellLead queues it first).
 */
export async function panesTick(d: Deps): Promise<DutyEvent[]> {
  if (d.store.stop("duty")) return [];
  const root = d.store.root;
  const before = readState(root);
  const state: PaneState = {};
  const events: DutyEvent[] = [];
  const now = d.now();
  const due: { pane: string; text: string; event: DutyEvent }[] = [];
  const lanes = d.store.lanes();
  const roles = d.store.roles();
  const canTell = roles.lead !== undefined;
  // One list of the group: the agent sessions nothing owns, and the panes a lane or role record may still name. A
  // failed list keeps the unowned spells as they were and tells none of them.
  const owned = new Set([...Object.values(roles), ...lanes.filter((l) => !CLOSED.has(l.status)).map((l) => l.sessionRef)].map(refText));
  let inGroup: Set<string> | undefined;
  try {
    const sessions = await d.runtime.list({ group: loadConfig(root).name });
    inGroup = new Set(sessions.map((s) => refText(s.ref)));
    for (const s of sessions) {
      const pane = refText(s.ref);
      if (s.agent === undefined || owned.has(pane)) continue;
      const spell = nextSpell(before[pane], "unowned", now);
      state[pane] = spell;
      if (canTell && spell.told === undefined && now - spell.since >= UNOWNED_AFTER_MS) {
        spell.told = now;
        due.push({ pane, text: unownedText(s.ref, s.agent, Math.floor((now - spell.since) / 60_000)), event: { pane, action: "unregistered" } });
      }
    }
  } catch (e) {
    for (const [pane, spell] of Object.entries(before)) if (spell.kind === "unowned") state[pane] = spell;
    events.push({ action: "panes-failed", detail: firstLine(e) });
  }

  // Dead agents: probed one by one, since only a probe tells a shell in front from an agent that never reported. A
  // record naming a terminal outside the group (an id reused after an hc restart) is not this home's pane to report.
  const watched: { ref: SessionRef; key?: string }[] = [
    ...lanes.filter((l) => AGENT_EXPECTED.has(l.status)).map((l) => ({ ref: l.sessionRef, key: l.key })),
    ...(roles.duty ? [{ ref: roles.duty }] : []),
  ];
  for (const { ref, key } of watched) {
    const pane = refText(ref);
    if (inGroup !== undefined && !inGroup.has(pane)) continue;
    try {
      if (!agentGone(await d.runtime.probe(ref))) continue;
    } catch (e) {
      // An unreadable pane neither starts nor ends a spell.
      if (before[pane]?.kind === "dead") state[pane] = before[pane]!;
      events.push({ pane, action: "panes-failed", detail: firstLine(e) });
      continue;
    }
    const spell = nextSpell(before[pane], "dead", now);
    state[pane] = spell;
    if (canTell && spell.told === undefined && spell.passes >= DEAD_AFTER_PASSES) {
      spell.told = now;
      due.push(key === undefined
        ? { pane, text: deadDutyText(ref), event: { pane, action: "dead" } }
        : { pane, text: deadLaneText(key, ref), event: { lane: key, pane, action: "dead" } });
    }
  }

  writeState(root, state);
  for (const { pane, text, event } of due) {
    // The spell is marked told either way: tellLead queues the message before it tries the lead pane.
    events.push(event);
    try {
      await tellLead(d, text, "duty");
    } catch (e) {
      events.push({ pane, action: "panes-delivery-failed", detail: firstLine(e) });
    }
  }
  return events;
}
