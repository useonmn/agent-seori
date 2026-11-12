import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { canLaunch, canLaunchLine, guardLines, guardStatePath, guardTick, guardVerdict, hostLine, parseDfAvailableKb, parsePaneCount, readGuardState, sampleHost, type HostSample } from "../src/guard.ts";
import type { Deps } from "../src/harness.ts";
import type { ExecResult } from "../src/herdr.ts";
import { World } from "./fake.ts";

const DF_MAC = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s5    971350180 600000000 104857600    86%    /System/Volumes/Data
`;
const dfOut = (availKb: number): string => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000000000 1 ${availKb} 50% /\n`;
const panesOut = (n: number): string => JSON.stringify({ id: "cli:pane:list", result: { panes: Array.from({ length: n }, (_, i) => ({ pane_id: `w1:p${i}` })) } });

type Host = { df: ExecResult; panes: ExecResult };

function setup(): { w: World; d: Deps; host: Host; dfArgs: (readonly string[])[] } {
  const w = new World();
  const base = w.deps();
  const host: Host = { df: { code: 0, stdout: dfOut(100 * 1024 * 1024), stderr: "" }, panes: { code: 0, stdout: panesOut(3), stderr: "" } };
  const dfArgs: (readonly string[])[] = [];
  const d: Deps = {
    ...base,
    exec: async (cmd, argv) => {
      if (cmd === "df") {
        dfArgs.push(argv);
        return host.df;
      }
      if (cmd === "herdr" && argv.slice(-2).join(" ") === "pane list") return host.panes;
      return w.exec(cmd, argv);
    },
  };
  w.addPane("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
  return { w, d, host, dfArgs };
}

const sample = (over: Partial<HostSample> = {}): HostSample => ({ loadPct: 10, memFreePct: 50, diskFreeGb: 100, panes: 3, unreadable: [], ...over });

describe("parsing", () => {
  test("df -k -P available column, in KB", () => {
    expect(parseDfAvailableKb(DF_MAC)).toBe(104857600);
    expect(parseDfAvailableKb("garbage")).toBeUndefined();
    expect(parseDfAvailableKb("")).toBeUndefined();
  });
  test("herdr pane list counts result.panes", () => {
    expect(parsePaneCount(panesOut(4))).toBe(4);
    expect(parsePaneCount("{}")).toBeUndefined();
    expect(parsePaneCount("not json")).toBeUndefined();
  });
});

describe("sampleHost", () => {
  test("reads load per core and memory from Deps.host, disk of $SEORI_HOME, pane count", async () => {
    const { w, d, dfArgs } = setup();
    w.host = { load1: 4, cores: 8, memFreePct: 42 };
    const s = await sampleHost(d);
    expect(s).toEqual({ loadPct: 50, memFreePct: 42, diskFreeGb: 100, panes: 3, unreadable: [] });
    expect(dfArgs).toEqual([["-k", "-P", d.store.root]]);
    expect(hostLine(s)).toBe("load 50% per core, memory free 42%, disk free 100 GB, panes 3");
  });

  test("an unreadable figure is undefined with its reason, never 0", async () => {
    const { d, host } = setup();
    host.df = { code: 1, stdout: "", stderr: "df: /x: No such file or directory\n" };
    host.panes = { code: 1, stdout: "", stderr: "herdr: server not running" };
    const s = await sampleHost(d);
    expect(s.diskFreeGb).toBeUndefined();
    expect(s.panes).toBeUndefined();
    expect(s.unreadable).toEqual([
      "disk free unreadable (df: df: /x: No such file or directory)",
      "panes unreadable (herdr pane list: herdr: server not running)",
    ]);
    expect(hostLine(s)).toContain("disk free unknown, panes unknown");
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
    expect(w.panes.get("w1:p1")!.received.at(-1)).toContain("[HOST-GUARD ALERT] memory free 4% < 10%");
    const told = w.panes.get("w1:p1")!.received.length;
    expect(await guardTick(d)).toEqual([]);
    expect(w.panes.get("w1:p1")!.received.length).toBe(told);
    expect(readGuardState(d.store.root)).toMatchObject({ alerting: true, since: w.clock, reasons: ["memory free 4% < 10%"] });

    w.host = { load1: 1, cores: 8, memFreePct: 60 };
    const clear = await guardTick(d);
    expect(clear).toEqual([{ action: "guard-clear", detail: "load 13% per core, memory free 60%, disk free 100 GB, panes 3" }]);
    expect(w.panes.get("w1:p1")!.received.at(-1)).toContain("[HOST-GUARD CLEAR] load 13% per core");
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
    host.panes = { code: 0, stdout: JSON.stringify({ result: { panes: Array.from({ length: 31 }, (_, i) => ({ pane_id: `w1:p${i}` })) } }), stderr: "" };
    expect((await guardTick(d))[0]?.action).toBe("guard-alert");
    host.panes = { code: 1, stdout: "", stderr: "herdr restarting" };
    expect(await guardTick(d)).toEqual([]);
    expect(readGuardState(d.store.root)?.alerting).toBe(true);
    host.panes = { code: 0, stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p1" }] } }), stderr: "" };
    expect((await guardTick(d))[0]?.action).toBe("guard-clear");
    expect(w.panes.get("w1:p1")!.received.filter((t) => t.includes("HOST-GUARD"))).toHaveLength(2);
  });

  test("a lead that cannot read now gets the alert queued once, never twice", async () => {
    const { w, d } = setup();
    w.host = { load1: 1, cores: 8, memFreePct: 4 };
    w.panes.get("w1:p1")!.status = "working";
    expect((await guardTick(d))[0]?.action).toBe("guard-alert");
    expect(await guardTick(d)).toEqual([]);
    expect(d.store.queued("w1:p1").map((m) => m.text)).toEqual(["[HOST-GUARD ALERT] memory free 4% < 10%"]);
  });

  test("a failed delivery is an event; the alert is kept in the lead inbox and not told again", async () => {
    const { w, d } = setup();
    w.host = { load1: 1, cores: 8, memFreePct: 4 };
    w.panes.delete("w1:p1"); // the lead pane is gone
    const events = await guardTick(d);
    expect(events.map((e) => e.action)).toEqual(["guard-alert", "guard-delivery-failed"]);
    expect(readGuardState(d.store.root)?.alerting).toBe(true);
    expect(await guardTick(d)).toEqual([]);
    expect(d.store.queued("w1:p1")).toHaveLength(1);
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
    expect(w.panes.get("w1:p1")!.received).toEqual([]);
  });
});
