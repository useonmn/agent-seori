// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adoptLane, syncRegistry } from "../src/adopt-sync.ts";
import { main } from "../src/cli.ts";
import { Refusal, type Deps } from "../src/harness.ts";
import { Runtimes } from "../src/runtime/index.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store.ts";
import { World } from "./fake.ts";
import { rig, terminal } from "./helpers/hc-rig.ts";

// seori adopt registers a running session as a lane; seori sync compares the registry with the seori.group sessions.

const ref = (id: string): SessionRef => ({ runtime: "hc", id });
const agent = (group: string, cwd = "/w") => terminal({ argv: ["omp"], cwd, labels: { "seori.group": group } });
const lane = (key: string, r: SessionRef, status: Lane["status"]): Lane => ({
  key, sessionRef: r, paneId: r.id, tabId: "", brief: `/b/${key}.md`, cwd: "/repo", status, createdAt: 1_000, lastActivityAt: 1_000, nudges: 0,
  log: [{ at: 1_000, kind: "start", text: "brief" }],
});

function setup(initial: Parameters<typeof rig>[0], knobs: Parameters<typeof rig>[2] = {}) {
  const r = rig(initial, {}, knobs);
  const w = new World();
  const d: Deps = { ...w.deps(), runtimes: new Runtimes("hc", () => r.rt) };
  return { r, d };
}

async function run(argv: string[], d: Deps): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { code: await main(argv, d), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

describe("seori adopt", () => {
  test("registers a running hc session as a working lane, copies the brief and types nothing", async () => {
    const { r, d } = setup({ t2: agent("seori", "/repo/api") });
    const brief = join(d.store.root, "src-brief.md");
    writeFileSync(brief, "fix the api\n");
    const l = await adoptLane(d, "api", "hc:t2", { brief });
    expect(l).toMatchObject({ key: "api", status: "working", sessionRef: ref("t2"), paneId: "t2", cwd: "/repo/api" });
    expect(d.store.lane("api")?.sessionRef).toEqual(ref("t2"));
    expect(readFileSync(l.brief, "utf8")).toBe("fix the api\n");
    expect(l.log[0]?.text).toBe("adopted hc:t2");
    expect(r.sent()).toEqual([]);
  });

  test("without --brief the brief is a note, and --cwd overrides the session's cwd", async () => {
    const { d } = setup({ t2: agent("seori") });
    const l = await adoptLane(d, "api", "hc:t2", { cwd: "/elsewhere" });
    expect(l.cwd).toBe("/elsewhere");
    expect(readFileSync(l.brief, "utf8")).toContain("no brief");
  });

  test("refuses a bad key, a reserved key, a bad ref, a missing brief and a missing session", async () => {
    const { d } = setup({ t2: agent("seori") });
    await expect(adoptLane(d, "X", "hc:t2")).rejects.toThrow(Refusal);
    await expect(adoptLane(d, "lead", "hc:t2")).rejects.toThrow(/reserved/);
    await expect(adoptLane(d, "api", "t2")).rejects.toThrow(/not a session ref/);
    await expect(adoptLane(d, "api", "hc:t2", { brief: "/no/such/brief.md" })).rejects.toThrow(/brief not found/);
    await expect(adoptLane(d, "api", "hc:t9")).rejects.toThrow(/no session hc:t9/);
    expect(d.store.lane("api")).toBeUndefined();
  });

  test("refuses a session another open lane or a role owns, and a key that is already open", async () => {
    const { d } = setup({ t1: agent("seori"), t2: agent("seori"), t3: agent("seori") });
    d.store.setRole("lead", ref("t1"));
    d.store.saveLane(lane("api", ref("t2"), "working"));
    await expect(adoptLane(d, "other", "hc:t1")).rejects.toThrow(/lead session/);
    await expect(adoptLane(d, "other", "hc:t2")).rejects.toThrow(/belongs to lane api/);
    await expect(adoptLane(d, "api", "hc:t3")).rejects.toThrow(/already open/);
  });

  test("a closed lane's key and session can be adopted again", async () => {
    const { d } = setup({ t2: agent("seori") });
    d.store.saveLane(lane("api", ref("t2"), "lost"));
    expect((await adoptLane(d, "api", "hc:t2")).status).toBe("working");
  });

  test("the CLI prints ADOPTED and requires --ref", async () => {
    const { d } = setup({ t2: agent("seori") });
    const out = await run(["adopt", "api", "--ref", "hc:t2"], d);
    expect(out.code).toBe(0);
    expect(out.out).toStartWith("ADOPTED api pane=hc:t2 brief=");
    await expect(run(["adopt", "web"], d)).rejects.toThrow(/--ref/);
  });
});

describe("seori sync", () => {
  test("a registry that matches the group is only listed, with and without --write", async () => {
    const { d } = setup({ t1: agent("seori"), t2: agent("seori") });
    d.store.setRole("lead", ref("t1"));
    d.store.saveLane(lane("api", ref("t2"), "working"));
    for (const write of [false, true]) {
      expect((await syncRegistry(d, write)).lines).toEqual(["LANE api hc:t2 working"]);
    }
    expect(d.store.lane("api")?.status).toBe("working");
  });

  test("a vanished lane is reported read-only, and marked lost with a log entry by --write", async () => {
    const { d } = setup({ t1: agent("seori") });
    d.store.setRole("lead", ref("t1"));
    d.store.saveLane(lane("api", ref("t7"), "working"));
    d.store.saveLane(lane("slow", ref("t8"), "paused"));
    const dry = await syncRegistry(d, false);
    expect(dry.lines.every((l) => l.startsWith("VANISHED "))).toBe(true);
    expect(dry.lost).toEqual([]);
    expect(d.store.lane("api")?.status).toBe("working");

    const written = await syncRegistry(d, true);
    expect(written.lost.sort()).toEqual(["api", "slow"]);
    expect(written.lines[0]).toBe("LOST api session hc:t7 is gone; lane marked lost");
    const api = d.store.lane("api")!;
    expect(api.status).toBe("lost");
    expect(api.log.at(-1)).toMatchObject({ kind: "lost", text: "session gone (seori sync)" });
    expect(d.store.lane("slow")).toMatchObject({ status: "lost" });
    expect(d.store.lane("slow")?.pausedFrom).toBeUndefined();
  });

  test("a ready lane and closed lanes keep their records even when the session is gone", async () => {
    const { d } = setup({ t1: agent("seori") });
    d.store.setRole("lead", ref("t1"));
    d.store.saveLane(lane("rdy", ref("t7"), "ready"));
    d.store.saveLane(lane("fin", ref("t8"), "done"));
    const r = await syncRegistry(d, true);
    expect(r.lines).toEqual(["VANISHED rdy session hc:t7 is gone (status=ready); record kept"]);
    expect(d.store.lane("rdy")?.status).toBe("ready");
    expect(d.store.lane("fin")?.status).toBe("done");
  });

  test("an agent session in the group without a record is UNREGISTERED and is never closed", async () => {
    const { r, d } = setup({ t1: agent("seori"), t2: agent("seori"), t3: agent("elsewhere") });
    d.store.setRole("lead", ref("t1"));
    const res = await syncRegistry(d, true);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toStartWith("UNREGISTERED hc:t2 agent=omp");
    expect(res.lines[0]).toContain("seori adopt <key> --ref hc:t2");
    expect(Object.keys(r.terminals()).sort()).toEqual(["t1", "t2", "t3"]);
    expect(r.calls().some((c) => c[0] === "close" || c[0] === "kill")).toBe(false);
  });

  test("a failed read is never gone: unreadable group and failed probe leave the lanes untouched", async () => {
    const { d } = setup({ t1: agent("seori") }, { getError: "unavailable" });
    d.store.saveLane(lane("api", ref("t7"), "working"));
    const res = await syncRegistry(d, true);
    expect(res.lost).toEqual([]);
    expect(res.lines.some((l) => l.startsWith("UNKNOWN group seori could not be listed ("))).toBe(true);
    expect(res.lines.some((l) => l.startsWith("UNKNOWN lane api session hc:t7 probe failed ("))).toBe(true);
    expect(d.store.lane("api")?.status).toBe("working");
  });

  test("the CLI takes --write", async () => {
    const { d } = setup({ t1: agent("seori") });
    d.store.saveLane(lane("api", ref("t7"), "working"));
    expect((await run(["sync"], d)).out).toStartWith("VANISHED api");
    expect(d.store.lane("api")?.status).toBe("working");
    expect((await run(["sync", "--write"], d)).out).toStartWith("LOST api");
    expect(d.store.lane("api")?.status).toBe("lost");
  });
});
