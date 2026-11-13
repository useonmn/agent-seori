// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { Refusal, type Deps } from "./harness.ts";
import { parseRef, type SessionRef } from "./runtime/types.ts";
import { RESERVED_KEYS, type Role } from "./store.ts";

const isRole = (target: string): target is Role => (RESERVED_KEYS as readonly string[]).includes(target);

/**
 * Where a send goes, in this order: an hc ref (`hc:t7`), a role, an open lane key. A lane named `t7` is that lane; the
 * hc terminal t7 is `hc:t7`.
 */
export function resolveTarget(d: Deps, target: string): SessionRef {
  if (target.startsWith("hc:")) {
    const ref = parseRef(target);
    if (ref) return ref;
    throw new Refusal(`${target} is not a session ref (hc:t7)`);
  }
  if (isRole(target)) {
    const ref = d.store.roles()[target];
    if (!ref) throw new Refusal(`no ${target} session registered (seori role ${target} <ref>)`);
    return ref;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") {
    // A lost lane read back from a herdr record keeps the herdr pane id: nothing on hc can take its messages.
    if (parseRef(`hc:${lane.sessionRef.id}`) === undefined) {
      const pane = lane.sessionRef.id ? ` ${lane.sessionRef.id}` : "";
      throw new Refusal(`lane ${target} ran in the herdr pane${pane}; seori runs on hc only, so it cannot take messages`);
    }
    return lane.sessionRef;
  }
  throw new Refusal(`unknown target ${target}: not a session ref, role or open lane`);
}
