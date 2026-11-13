// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { bootReport } from "../src/boot.ts";
import type { Deps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { Herdr } from "../src/runtime/herdr/client.ts";
import { Runtimes, defaultRuntimes } from "../src/runtime/index.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store.ts";
import { World, herdrRef } from "./fake.ts";
import { rig, terminal } from "./helpers/hc-rig.ts";

// `seori boot` fails, one DRIFT line per problem, when the lane registry and the live sessions disagree: an open lane
// without a session, or an agent session in the home's seori.group without a lane or role record.

const lane = (key: string, ref: SessionRef, status: Lane["status"]): Lane => ({
  key, sessionRef: ref, paneId: ref.id, tabId: "w1:t1", brief: `/b/${key}.md`, cwd: "/repo", status, createdAt: 1_000, lastActivityAt: 1_000, nudges: 0,
  log: [{ at: 1_000, kind: "start", text: "brief" }],
});
const drift = (lines: readonly string[]): string[] => lines.filter((l) => l.startsWith("DRIFT"));

/** World whose `pane list` reports every pane in workspace w1, labelled "seori" like the default home name. */
function herdrSetup(): { w: World; d: Deps } {
  const w = new World();
  w.workspaces = [{ workspace_id: "w1", label: "seori" }];
  const exec: Exec = async (cmd, argv) => {
    if (cmd === "herdr" && argv[0] === "pane" && argv[1] === "list") {
      const panes = [...w.panes].map(([id, p]) => ({
        pane_id: id, workspace_id: id.split(":")[0], tab_id: `${id.split(":")[0]}:t1`,
        agent: p.status === "shell" ? null : "omp", agent_status: p.status,
      }));
      return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
    }
    return w.exec(cmd, argv);
  };
  return { w, d: { ...w.deps(), exec, runtimes: defaultRuntimes(new Herdr(exec, "")) } };
}

describe("boot drift on herdr", () => {
  test("a registered lead, lane and shell pane are no drift: the boot is checked", async () => {
    const { w, d } = herdrSetup();
    w.addPane("w1:p1", "idle");
    w.addPane("w1:p2", "working");
    w.addPane("w1:p3", "shell"); // a loop pane: no agent, no record needed
    d.store.setRole("lead", herdrRef("w1:p1"));
    d.store.saveLane(lane("api", herdrRef("w1:p2"), "working"));
    const r = await bootReport(d);
    expect(drift(r.lines)).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.lines.at(-1)).toBe("BOOT checked read-only; nothing restarted, written or stopped");
  });

  test("an open lane without a session and an agent in the group without a record each fail the boot", async () => {
    const { w, d } = herdrSetup();
    w.addPane("w1:p1", "idle");
    w.addPane("w1:p9", "working"); // no lane, no role
    d.store.setRole("lead", herdrRef("w1:p1"));
    d.store.saveLane(lane("api", herdrRef("w1:p4"), "working"));
    d.store.saveLane(lane("old", herdrRef("w1:p5"), "done")); // closed: its missing session is no drift
    const r = await bootReport(d);
    expect(drift(r.lines)).toEqual([
      "DRIFT lane api has no session w1:p4 (status=working); lane record kept, nothing relaunched",
      "DRIFT session w1:p9 is in group seori but has no lane or role record (agent=omp status=working); nothing closed",
    ]);
    expect(r.complete).toBe(false);
    expect(r.lines.at(-1)).toBe("BOOT failed (2 drift) read-only; nothing restarted, written or stopped");
  });

  test("a workspace with another label is not this home's group", async () => {
    const { w, d } = herdrSetup();
    w.workspaces = [{ workspace_id: "w1", label: "someone-else" }];
    w.addPane("w1:p9", "working");
    const r = await bootReport(d);
    expect(drift(r.lines)).toEqual([]);
    expect(r.complete).toBe(true);
  });
});

describe("boot drift on hc", () => {
  function hcSetup(initial: Parameters<typeof rig>[0]): { d: Deps } {
    const r = rig(initial);
    const w = new World();
    return { d: { ...w.deps(), runtimes: new Runtimes("hc", () => r.rt) } };
  }
  const agent = (group: string) => terminal({ argv: ["omp"], labels: { "seori.group": group } });

  test("an open lane whose terminal is gone, and a terminal labelled seori.group without a record, fail the boot", async () => {
    const { d } = hcSetup({ t1: agent("seori"), t2: agent("seori"), t3: agent("seori"), t4: agent("elsewhere") });
    d.store.setRole("lead", { runtime: "hc", id: "t1" });
    d.store.saveLane(lane("api", { runtime: "hc", id: "t3" }, "working"));
    d.store.saveLane(lane("lost-one", { runtime: "hc", id: "t7" }, "waiting"));
    const r = await bootReport(d);
    expect(drift(r.lines)).toEqual([
      "DRIFT lane lost-one has no session hc:t7 (status=waiting); lane record kept, nothing relaunched",
      "DRIFT session hc:t2 is in group seori but has no lane or role record (agent=omp status=unknown); nothing closed",
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
    const d: Deps = { ...w.deps(), runtimes: new Runtimes("hc", () => r.rt) };
    d.store.saveLane(lane("api", { runtime: "hc", id: "t7" }, "working"));
    const out = await bootReport(d);
    const lines = drift(out.lines);
    expect(lines.some((l) => l.startsWith("DRIFT lane api session hc:t7 probe failed ("))).toBe(true);
    expect(lines.some((l) => l.startsWith("DRIFT group seori could not be listed ("))).toBe(true);
    expect(out.complete).toBe(false);
  });
});
