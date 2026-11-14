import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { canLaunch, canLaunchLine, guardLines, guardStatePath, guardTick, guardVerdict, hostLine, parseDfAvailableKb, readGuardState, sampleHost, type HostSample } from "../src/guard.ts";
import type { Deps } from "../src/harness.ts";
import type { Lane } from "../src/store.ts";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { World, paneRef } from "./fake.ts";

const DF_MAC = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s5    971350180 600000000 104857600    86%    /System/Volumes/Data
`;
const dfOut = (availKb: number): string => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000000000 1 ${availKb} 50% /\n`;
const panesOut = (n: number): string => JSON.stringify({ terminals: Array.from({ length: n }, (_, i) => ({ address: `t${i + 10}`, state: "live" })) });

type Host = { df: ExecResult; panes: ExecResult };

function setup(): { w: World; d: Deps; host: Host; dfArgs: (readonly string[])[] } {
  const w = new World();
  const base = w.deps();
  const host: Host = { df: { code: 0, stdout: dfOut(100 * 1024 * 1024), stderr: "" }, panes: { code: 0, stdout: panesOut(3), stderr: "" } };
  const dfArgs: (readonly string[])[] = [];
  const exec: Exec = async (cmd, argv) => {
    if (cmd === "df") {
      dfArgs.push(argv);
      return host.df;
    }
    if (cmd === "hc" && argv.join(" ") === "--json ls") return host.panes;
    return w.exec(cmd, argv);
  };
  const d: Deps = { ...base, exec, runtime: new HcRuntime(exec, { env: {} }) };
  w.addPane("t1", "idle");
  d.store.setRole("lead", paneRef("t1"));
  return { w, d, host, dfArgs };
}

const sample = (over: Partial<HostSample> = {}): HostSample => ({ loadPct: 10, memFreePct: 50, diskFreeGb: 100, panes: 3, unreadable: [], ...over });

describe("parsing", () => {
  test("df -k -P available column, in KB", () => {
    expect(parseDfAvailableKb(DF_MAC)).toBe(104857600);
    expect(parseDfAvailableKb("garbage")).toBeUndefined();
    expect(parseDfAvailableKb("")).toBeUndefined();
  });
});

describe("sampleHost", () => {
  test("reads load per core and memory from Deps.host, disk of $SEORI_HOME, pane count", async () => {
    const { w, d, dfArgs } = setup();
    w.host = { load1: 4, cores: 8, memFreePct: 42 };
    const s = await sampleHost(d);
    expect(s).toEqual({ loadPct: 50, memFreePct: 42, diskFreeGb: 100, panes: 3, unreadable: [] });
    expect(dfArgs).toEqual([["-k", "-P", homedir()]]);
    expect(hostLine(s)).toBe("load 50% per core, memory free 42%, disk free 100 GB, panes 3");
  });

  test("disk is measured where lanes work, not on a small tmpfs $SEORI_HOME", async () => {
    // df -k -P output captured on a Linux box whose /tmp is a 6 GB tmpfs and whose / has ~945 GiB free.
    const DF_TMPFS = "Filesystem     1024-blocks    Used Available Capacity Mounted on\ntmpfs              6093080 1195532   4897548      20% /tmp\n";
    const DF_ROOT = "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sdd        1055762868 10933868 991125528       2% /\n";
    const { w, d } = setup();
    const asked: string[] = [];
    const exec: Exec = async (cmd, argv) => {
      if (cmd !== "df") return d.exec(cmd, argv);
      const path = argv.at(-1) ?? "";
      asked.push(path);
      return { code: 0, stdout: path === d.store.root ? DF_TMPFS : DF_ROOT, stderr: "" };
    };
    const s = await sampleHost({ ...d, exec });
    expect(asked).toEqual([homedir()]);
    expect(s.diskFreeGb).toBeCloseTo(991125528 / 1024 / 1024, 5);
    expect(Math.floor(s.diskFreeGb ?? 0)).toBe(945);
    expect(w).toBeDefined();
  });

  test("open lanes' working directories (a worktree seori gave one, else its cwd) are measured and the least free volume wins; done lanes and missing dirs are skipped", async () => {
    const { d, host, dfArgs } = setup();
    const lane = (key: string, cwd: string, status: Lane["status"]): Lane => ({ key, sessionRef: paneRef(`w1:${key}`), paneId: `w1:${key}`, tabId: "t1", brief: "b", cwd, status, createdAt: 0, lastActivityAt: 0, nudges: 0, log: [] });
    const a = mkdtempSync(join(tmpdir(), "seori-guard-a-"));
    const b = mkdtempSync(join(tmpdir(), "seori-guard-b-"));
    try {
      d.store.saveLane(lane("a", a, "working"));
      d.store.saveLane({ ...lane("b", homedir(), "working"), worktree: b });
      d.store.saveLane(lane("gone", join(a, "missing"), "working"));
      d.store.saveLane(lane("old", homedir(), "done"));
      host.df = { code: 0, stdout: dfOut(30 * 1024 * 1024), stderr: "" };
      const s = await sampleHost(d);
      expect(dfArgs.map((x) => x.at(-1))).toEqual([a, b]);
      expect(s.diskFreeGb).toBe(30);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("an unreadable figure is undefined with its reason, never 0", async () => {
    const { d, host } = setup();
    host.df = { code: 1, stdout: "", stderr: "df: /x: No such file or directory\n" };
    host.panes = { code: 1, stdout: "", stderr: "hc: server not running" };
    const s = await sampleHost(d);
    expect(s.diskFreeGb).toBeUndefined();
    expect(s.panes).toBeUndefined();
    expect(s.unreadable).toEqual([
      "disk free unreadable (df: df: /x: No such file or directory)",
      "panes unreadable (hc ls: hc: server not running)",
    ]);
    expect(hostLine(s)).toContain("disk free unknown, panes unknown");
  });

  test("a session-list failure that is not a tool result keeps its own cause", async () => {
    const { d } = setup();
    Object.assign(d.runtime, { list: async () => Promise.reject(new Error("spawn hc ENOENT")) });
    const s = await sampleHost(d);
    expect(s.panes).toBeUndefined();
    expect(s.unreadable.join("\n")).toContain("spawn hc ENOENT");
  });
});

describe("canLaunch", () => {
  test("ok on a roomy host, even under heavy load", async () => {
    const { w, d } = setup();
    w.host = { load1: 64, cores: 8, memFreePct: 50 };
    const r = await canLaunch(d, DEFAULT_CONFIG);
    expect(r).toEqual({ ok: true, reasons: [] });
    expect(canLaunchLine(r)).toBe("CAN_LAUNCH");
  });

  test("holds on low memory, low disk and too many panes", async () => {
    const { w, d, host } = setup();
    w.host = { load1: 1, cores: 8, memFreePct: 5 };
    host.df = { code: 0, stdout: dfOut(10 * 1024 * 1024), stderr: "" };
    host.panes = { code: 0, stdout: panesOut(31), stderr: "" };
    const r = await canLaunch(d, DEFAULT_CONFIG);
    expect(r.ok).toBe(false);
    expect(canLaunchLine(r)).toBe("HOLD memory free 5% < 10% | disk free 10 GB < 20 GB | panes 31 > 30");
  });

  test("a figure that cannot be read holds nothing, but seori guard still shows it", async () => {
    const { d, host } = setup();
    host.panes = { code: 0, stdout: "oops", stderr: "" };
    expect(await canLaunch(d, DEFAULT_CONFIG)).toEqual({ ok: true, reasons: [] });
    expect((await guardLines(d, DEFAULT_CONFIG))[0]).toContain("panes unknown");
  });
});

describe("guardVerdict", () => {
  const t = DEFAULT_CONFIG.guard;
  test("load alerts above loadAlertPct and clears only under loadOkPct", () => {
    expect(guardVerdict(sample({ loadPct: 150 }), t, false)).toEqual({ loadHigh: false, reasons: [] });
    expect(guardVerdict(sample({ loadPct: 151 }), t, false)).toEqual({ loadHigh: true, reasons: ["load 151% per core > 150%"] });
    expect(guardVerdict(sample({ loadPct: 100 }), t, true)).toEqual({ loadHigh: true, reasons: ["load 100% per core, not yet under 80%"] });
    expect(guardVerdict(sample({ loadPct: 79 }), t, true)).toEqual({ loadHigh: false, reasons: [] });
  });
});

describe("guardTick", () => {
  test("tells the lead once on ALERT and once on CLEAR", async () => {
    const { w, d } = setup();
    expect(await guardTick(d)).toEqual([]);
    expect(readGuardState(d.store.root)?.alerting).toBe(false);

    w.host = { load1: 1, cores: 8, memFreePct: 4 };
    w.clock += 1000;
    expect(await guardTick(d)).toEqual([{ action: "guard-alert", detail: "memory free 4% < 10%" }]);
    expect(w.panes.get("t1")!.received.at(-1)).toContain("[HOST-GUARD ALERT] memory free 4% < 10%");
    const told = w.panes.get("t1")!.received.length;
    expect(await guardTick(d)).toEqual([]);
    expect(w.panes.get("t1")!.received.length).toBe(told);
    expect(readGuardState(d.store.root)).toMatchObject({ alerting: true, since: w.clock, reasons: ["memory free 4% < 10%"] });

    w.host = { load1: 1, cores: 8, memFreePct: 60 };
    const clear = await guardTick(d);
    expect(clear).toEqual([{ action: "guard-clear", detail: "load 13% per core, memory free 60%, disk free 100 GB, panes 3" }]);
    expect(w.panes.get("t1")!.received.at(-1)).toContain("[HOST-GUARD CLEAR] load 13% per core");
    expect(await guardTick(d)).toEqual([]);
  });

  test("load hysteresis: no flapping between loadOkPct and loadAlertPct", async () => {
    const { w, d } = setup();
    w.host = { load1: 16, cores: 8, memFreePct: 50 }; // 200%
    expect((await guardTick(d))[0]?.action).toBe("guard-alert");
    w.host = { load1: 10, cores: 8, memFreePct: 50 }; // 125%
    expect(await guardTick(d)).toEqual([]);
    w.host = { load1: 6, cores: 8, memFreePct: 50 }; // 75%
    expect((await guardTick(d))[0]?.action).toBe("guard-clear");
  });

  test("an alerting figure that turns unreadable keeps the alert: no false CLEAR, no second ALERT", async () => {
    const { w, d, host } = setup();
    host.panes = { code: 0, stdout: panesOut(31), stderr: "" };
    expect((await guardTick(d))[0]?.action).toBe("guard-alert");
    host.panes = { code: 1, stdout: "", stderr: "hc restarting" };
    expect(await guardTick(d)).toEqual([]);
    expect(readGuardState(d.store.root)?.alerting).toBe(true);
    host.panes = { code: 0, stdout: panesOut(1), stderr: "" };
    expect((await guardTick(d))[0]?.action).toBe("guard-clear");
    expect(w.panes.get("t1")!.received.filter((t) => t.includes("HOST-GUARD"))).toHaveLength(2);
  });

  test("a lead that cannot read now gets the alert queued once, never twice", async () => {
    const { w, d } = setup();
    w.host = { load1: 1, cores: 8, memFreePct: 4 };
    w.panes.get("t1")!.status = "working";
    expect((await guardTick(d))[0]?.action).toBe("guard-alert");
    expect(await guardTick(d)).toEqual([]);
    expect(d.store.queued(paneRef("t1")).map((m) => m.text)).toEqual(["[HOST-GUARD ALERT] memory free 4% < 10%"]);
  });

  test("a failed delivery is an event; the alert is kept in the lead inbox and not told again", async () => {
    const { w, d } = setup();
    w.host = { load1: 1, cores: 8, memFreePct: 4 };
    w.panes.delete("t1"); // the lead pane is gone
    const events = await guardTick(d);
    expect(events.map((e) => e.action)).toEqual(["guard-alert", "guard-delivery-failed"]);
    expect(readGuardState(d.store.root)?.alerting).toBe(true);
    expect(await guardTick(d)).toEqual([]);
    expect(d.store.queued(paneRef("t1"))).toHaveLength(1);
  });

  test("a broken config.json is a guard-failed event, not a throw", async () => {
    const { d } = setup();
    writeFileSync(join(d.store.root, "config.json"), "{");
    const events = await guardTick(d);
    expect(events[0]?.action).toBe("guard-failed");
    expect(readGuardState(d.store.root)).toBeUndefined();
  });

  test("a damaged guard.json starts from not alerting", async () => {
    const { w, d } = setup();
    writeFileSync(guardStatePath(d.store.root), "nope");
    w.host = { load1: 1, cores: 8, memFreePct: 4 };
    expect((await guardTick(d))[0]?.action).toBe("guard-alert");
  });
});

describe("guardLines", () => {
  test("prints the reading and the verdict without telling anyone", async () => {
    const { w, d } = setup();
    expect(await guardLines(d, DEFAULT_CONFIG)).toEqual(["HOST load 13% per core, memory free 50%, disk free 100 GB, panes 3", "HOST_GUARD OK"]);
    w.host = { load1: 1, cores: 8, memFreePct: 4 };
    expect((await guardLines(d, DEFAULT_CONFIG))[1]).toBe("HOST_GUARD ALERT memory free 4% < 10%");
    expect(w.panes.get("t1")!.received).toEqual([]);
  });
});
