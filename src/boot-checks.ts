// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// The boot check a fresh lead cannot make by itself: the lane registry and the runtime's live sessions disagree. Each
// finding is one `DRIFT` line and fails `seori boot`.
import type { Runtimes } from "./runtime/registry.ts";
import type { SessionRef, SessionRuntime } from "./runtime/types.ts";
import type { Lane } from "./store.ts";
import { refText } from "./refs.ts";

const key = (ref: SessionRef): string => `${ref.runtime}:${ref.id}`;

/**
 * Record without session: open lanes the session list no longer shows and the runtime's own probe reports `gone` (a live
 * lane costs no extra call; a failed probe is named and counts as drift).
 * Session without record: agent sessions in the home's group (hc: the `seori.group` label value, herdr: the workspace
 * labelled so) that no lane record (any status) and no role owns. Shells (the daemon and loop panes) are not agents and
 * are not flagged. A group that cannot be listed is named and counts as drift.
 */
export async function driftCheck(input: {
  readonly runtimes: Runtimes;
  readonly open: readonly Lane[];
  readonly lanes: readonly Lane[];
  readonly roles: readonly SessionRef[];
  /** refText of every session the default runtime listed. */
  readonly liveIds: ReadonlySet<string>;
  readonly group: string | undefined;
}): Promise<{ readonly lines: string[]; readonly problems: number }> {
  const { runtimes, open, lanes, roles, liveIds, group } = input;
  const lines: string[] = [];

  for (const lane of open) {
    if (liveIds.has(refText(lane.sessionRef))) continue;
    try {
      if ((await runtimes.for(lane.sessionRef).probe(lane.sessionRef)).status === "gone") {
        lines.push(`DRIFT lane ${lane.key} has no session ${refText(lane.sessionRef)} (status=${lane.status}); lane record kept, nothing relaunched`);
      }
    } catch (e) {
      lines.push(`DRIFT lane ${lane.key} session ${refText(lane.sessionRef)} probe failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  if (group !== undefined) {
    const rt: SessionRuntime = runtimes.default;
    const owned = new Set([...roles, ...lanes.map((l) => l.sessionRef)].map(key));
    try {
      const ids = (await rt.groups()).filter((g) => g.label === group).map((g) => g.id);
      for (const id of ids) {
        for (const s of await rt.list({ group: id })) {
          if (s.agent !== undefined && !owned.has(key(s.ref))) {
            lines.push(`DRIFT session ${refText(s.ref)} is in group ${group} but has no lane or role record (agent=${s.agent} status=${s.status ?? "unknown"}); nothing closed`);
          }
        }
      }
    } catch (e) {
      lines.push(`DRIFT group ${group} could not be listed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { lines, problems: lines.length };
}
