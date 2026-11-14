// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { bootReport } from "../src/boot.ts";
import type { Deps } from "../src/harness.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store.ts";
import { World } from "./fake.ts";
import { rig, terminal } from "./helpers/hc-rig.ts";

// `seori boot` fails, one DRIFT line per problem, when the lane registry and the live sessions disagree: an open lane
// without a session, or an agent session in the home's seori.group without a lane or role record.

const lane = (key: string, ref: SessionRef, status: Lane["status"]): Lane => ({
  key, sessionRef: ref, paneId: ref.id, tabId: "w1:t1", brief: `/b/${key}.md`, cwd: "/repo", status, createdAt: 1_000, lastActivityAt: 1_000, nudges: 0,
  log: [{ at: 1_000, kind: "start", text: "brief" }],
});
const drift = (lines: readonly string[]): string[] => lines.filter((l) => l.startsWith("DRIFT"));

describe("boot drift on hc", () => {
  function hcSetup(initial: Parameters<typeof rig>[0]): { d: Deps } {
    const r = rig(initial);
    const w = new World();
    return { d: { ...w.deps(), runtime: r.rt } };
  }
  const agent = (group: string) => terminal({ argv: ["omp"], labels: { "seori.group": group } });

  test("an open lane whose terminal is gone, and a terminal labelled seori.group without a record, fail the boot", async () => {
    // t5 is a plain shell in the group (a loop terminal on macOS): hc names its program as agent, but it is no agent session.
    const shell = terminal({ argv: ["sh"], status: null, labels: { "seori.group": "seori" } });
    const { d } = hcSetup({ t1: agent("seori"), t2: agent("seori"), t3: agent("seori"), t4: agent("elsewhere"), t5: shell });
    d.store.setRole("lead", { runtime: "hc", id: "t1" });
    d.store.saveLane(lane("api", { runtime: "hc", id: "t3" }, "working"));
    d.store.saveLane(lane("lost-one", { runtime: "hc", id: "t7" }, "waiting"));
    const r = await bootReport(d);
    expect(drift(r.lines)).toEqual([
      "DRIFT lane lost-one has no session hc:t7 (status=waiting); lane record kept, nothing relaunched",
      "DRIFT session hc:t2 is in group seori but has no lane or role record (agent=omp status=idle); nothing closed",
    ]);
    expect(r.complete).toBe(false);
  });

  test("lanes and roles that match the group's terminals are no drift", async () => {
    const { d } = hcSetup({ t1: agent("seori"), t2: agent("seori") });
    d.store.setRole("lead", { runtime: "hc", id: "t1" });
    d.store.saveLane(lane("api", { runtime: "hc", id: "t2" }, "working"));
    const r = await bootReport(d);
    expect(drift(r.lines)).toEqual([]);
    expect(r.complete).toBe(true);
  });

  test("a probe that fails is named and fails the boot, not called gone", async () => {
    const r = rig({ t1: agent("seori") }, {}, { getError: "unavailable" });
    const w = new World();
    const d: Deps = { ...w.deps(), runtime: r.rt };
    d.store.saveLane(lane("api", { runtime: "hc", id: "t7" }, "working"));
    const out = await bootReport(d);
    const lines = drift(out.lines);
    expect(lines.some((l) => l.startsWith("DRIFT lane api session hc:t7 probe failed ("))).toBe(true);
    expect(lines.some((l) => l.startsWith("DRIFT group seori could not be listed ("))).toBe(true);
    expect(out.complete).toBe(false);
  });
});
