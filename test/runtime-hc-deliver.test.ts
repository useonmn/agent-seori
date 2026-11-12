// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import type { DeliverOutcome } from "../src/runtime/types.ts";
import type { FakeKnobs } from "./helpers/fake-hc.ts";
import { rig, T1, terminal } from "./helpers/hc-rig.ts";

const sends = (calls: readonly string[][]) => calls.filter((c) => c[0] === "send");
const reads = (calls: readonly string[][]) => calls.filter((c) => c[0] === "read");
const screen = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "screens", `${name}.txt`), "utf8");
const omoWorking = (name?: string) =>
  terminal({ status: { state: "working", app: "omo" }, ...(name === undefined ? {} : { screen: screen(name) }) });

describe("deliver", () => {
  test("idle: send --if idle once, delivered with hc's turn and started", async () => {
    const r = rig({ t1: terminal() });
    expect(await r.rt.deliver(T1, "hello")).toEqual({ kind: "delivered", turn: 3, started: true });
    expect(sends(r.calls())).toEqual([["send", "t1", "--if", "idle", "--", "hello"]]);
    expect(r.sent()).toEqual([{ id: "t1", text: "hello" }]);
  });

  test("done: a plain send (the agent finished its turn and waits)", async () => {
    const r = rig({ t1: terminal({ status: { state: "done", app: "omo" } }) });
    expect((await r.rt.deliver(T1, "next")).kind).toBe("delivered");
    expect(sends(r.calls())).toEqual([["send", "t1", "--", "next"]]);
  });

  test("started:false is still delivered; started:null leaves started out", async () => {
    const a = rig({ t1: terminal() }, {}, { started: false });
    expect(await a.rt.deliver(T1, "x")).toEqual({ kind: "delivered", turn: 3, started: false });
    const b = rig({ t1: terminal() }, {}, { started: null });
    expect(await b.rt.deliver(T1, "x")).toEqual({ kind: "delivered", turn: 3 });
  });

  test.each([
    ["silent shell in front", terminal({ status: null, foreground: { name: "bash", argv: ["bash"], pid: 1 } }), { kind: "no-agent" }],
    [
      "shell in front while the agent last reported idle (suspended agent)",
      terminal({ foreground: { name: "zsh", argv: ["-zsh"], pid: 1 } }),
      { kind: "no-agent" },
    ],
    ["finished", terminal({ state: "finished" }), { kind: "no-agent" }],
    ["blocked without force", terminal({ status: { state: "blocked" } }), { kind: "not-ready", status: "blocked" }],
    ["error", terminal({ status: { state: "error" } }), { kind: "not-ready", status: "unknown" }],
  ] as const)("pre-probe %s: no send at all", async (_, term, want) => {
    const r = rig({ t1: term });
    expect(await r.rt.deliver(T1, "secret text")).toEqual(want);
    expect(sends(r.calls())).toEqual([]);
  });

  test("working under the default when=idle: hc refuses with status_mismatch (rc 10), nothing typed, not-ready", async () => {
    const r = rig({ t1: terminal({ status: { state: "working", app: "omo" } }) });
    expect(await r.rt.deliver(T1, "x")).toEqual({ kind: "not-ready", status: "working" });
    expect(sends(r.calls())).toEqual([["send", "t1", "--if", "idle", "--", "x"]]);
    expect(r.sent()).toEqual([]);
  });

  test.each(["idle", "any"] as const)("a silent program under when=%s is held as unknown, no send at all", async (when) => {
    const r = rig({ t1: terminal({ status: null, foreground: { name: "node", argv: ["node"], pid: 1 } }) });
    expect(await r.rt.deliver(T1, "x", { when })).toEqual({ kind: "not-ready", status: "unknown" });
    expect(sends(r.calls())).toEqual([]);
  });

  test("when=working sends --if working", async () => {
    const r = rig({ t1: terminal({ status: { state: "working", app: "omo" }, screen: screen("omo-turn") }) });
    expect((await r.rt.deliver(T1, "/goal pause", { when: "working" })).kind).toBe("delivered");
    expect(sends(r.calls())).toEqual([["send", "t1", "--if", "working", "--", "/goal pause"]]);
  });

  test("when=any sends with no status gate", async () => {
    const r = rig({ t1: terminal({ status: { state: "working", app: "omo" } }) });
    expect((await r.rt.deliver(T1, "x", { when: "any" })).kind).toBe("delivered");
    expect(sends(r.calls())).toEqual([["send", "t1", "--", "x"]]);
  });

  test("force types into a blocked agent with --force", async () => {
    const r = rig({ t1: terminal({ status: { state: "blocked", app: "omo" } }) });
    expect((await r.rt.deliver(T1, "y", { when: "any", force: true })).kind).toBe("delivered");
    expect(sends(r.calls())).toEqual([["send", "t1", "--force", "--", "y"]]);
  });

  test.each([
    ["status_mismatch", "not-ready"],
    ["blocked", "not-ready"],
    ["not_found", "no-agent"],
    ["finished", "no-agent"],
    ["unavailable", "ambiguous"],
  ] as const)("send answering %s -> %s", async (kind, want) => {
    const r = rig({ t1: terminal() }, {}, { sendError: kind });
    expect((await r.rt.deliver(T1, "secret text")).kind).toBe(want);
    expect(r.sent()).toEqual([]);
  });

  test("not-ready after a refused send carries the status hc reports now", async () => {
    const r = rig({ t1: terminal() }, {}, { sendError: "blocked" });
    expect(await r.rt.deliver(T1, "x")).toEqual({ kind: "not-ready", status: "blocked" });
  });

  test.each<[string, FakeKnobs]>([
    ["a non-JSON failure", { sendGarbled: true }],
    ["an unavailable core", { sendError: "unavailable" }],
  ])("%s is ambiguous and never carries the text", async (_, knobs) => {
    const r = rig({ t1: terminal() }, {}, knobs);
    const out: DeliverOutcome = await r.rt.deliver(T1, "secret text");
    if (out.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${out.kind}`);
    expect(out.detail.length).toBeGreaterThan(0);
    expect(out.detail).not.toContain("secret text");
    expect(String(out.failure instanceof Error ? out.failure.message : out.failure)).not.toContain("secret text");
  });

  test("a runner that throws mid-send is ambiguous and never carries the text", async () => {
    const get = { state: "live", status: { app: "omo", state: "idle" }, foreground: { name: "omo", argv: ["omo"], pid: 1 } };
    const rt = new HcRuntime(async (_cmd, argv) => {
      if (argv[1] === "send") throw new Error("broken pipe while sending secret text");
      return { code: 0, stdout: JSON.stringify(get), stderr: "" };
    });
    const out = await rt.deliver(T1, "secret text");
    expect(out.kind).toBe("ambiguous");
    expect(JSON.stringify(out)).not.toContain("secret text");
  });
});

describe("probe: the screen check when omo says working", () => {
  test("working with omo's idle input on screen (live monitors between turns) probes idle", async () => {
    const r = rig({ t1: omoWorking("omo-idle-live-monitors") });
    expect((await r.rt.probe(T1)).status).toBe("idle");
    expect(reads(r.calls())).toEqual([["read", "t1", "--lines", "30"]]);
  });

  test.each(["omo-turn", "omo-dialog", "omo-draft"])("working with %s on screen stays working", async (name) => {
    const r = rig({ t1: omoWorking(name) });
    expect((await r.rt.probe(T1)).status).toBe("working");
  });

  test("a failed screen read stays working (doubt never reads as idle)", async () => {
    const r = rig({ t1: omoWorking("omo-idle-live-monitors") }, {}, { readError: "unavailable" });
    expect((await r.rt.probe(T1)).status).toBe("working");
  });

  test("an empty screen stays working", async () => {
    const r = rig({ t1: omoWorking() });
    expect((await r.rt.probe(T1)).status).toBe("working");
  });

  test("any word other than working is taken as reported, with no screen read", async () => {
    for (const state of ["idle", "done", "blocked"] as const) {
      const r = rig({ t1: terminal({ status: { state, app: "omo" }, screen: screen("omo-turn") }) });
      expect((await r.rt.probe(T1)).status).toBe(state);
      expect(reads(r.calls())).toEqual([]);
    }
  });

  test("a shell in front is never read as idle, whatever the screen shows", async () => {
    const r = rig({
      t1: terminal({
        status: { state: "working", app: "omo" },
        foreground: { name: "zsh", argv: ["-zsh"], pid: 1 },
        screen: screen("omo-idle-live-monitors"),
      }),
    });
    const p = await r.rt.probe(T1);
    expect(p.status).toBe("working");
    expect(p.shellInFront).toBe(true);
    expect(reads(r.calls())).toEqual([]);
  });
});

describe("deliver: idle read off the screen while hc still says working", () => {
  test("sends with --if working, so the compare-and-send matches hc's own word, and lands", async () => {
    const r = rig({ t1: omoWorking("omo-idle-live-monitors") });
    expect((await r.rt.deliver(T1, "[READY] lane")).kind).toBe("delivered");
    expect(sends(r.calls())).toEqual([["send", "t1", "--if", "working", "--", "[READY] lane"]]);
  });

  test("hc refusing the send (omo moved between probe and send) stays not-ready and types nothing", async () => {
    const r = rig({ t1: omoWorking("omo-idle-live-monitors") }, {}, { sendError: "status_mismatch" });
    expect((await r.rt.deliver(T1, "secret text")).kind).toBe("not-ready");
    expect(r.sent()).toEqual([]);
  });

  test("a turn on screen keeps the --if idle gate, which hc refuses while working", async () => {
    const r = rig({ t1: omoWorking("omo-turn") });
    expect(await r.rt.deliver(T1, "x")).toEqual({ kind: "not-ready", status: "working" });
    expect(sends(r.calls())).toEqual([["send", "t1", "--if", "idle", "--", "x"]]);
    expect(r.sent()).toEqual([]);
  });
});
