// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { joinWrapped } from "../src/runtime/hc/deliver.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import type { DeliverOutcome } from "../src/runtime/types.ts";
import type { FakeKnobs } from "./helpers/fake-hc.ts";
import { rig, T1, terminal } from "./helpers/hc-rig.ts";

const sends = (calls: readonly string[][]) => calls.filter((c) => c[0] === "send");

describe("deliver", () => {
  test("idle: send --if idle once, delivered with hc's turn and started", async () => {
    const r = rig({ t1: terminal() });
    expect(await r.rt.deliver(T1, "hello")).toEqual({ kind: "delivered", turn: 3, started: true });
    expect(sends(r.calls())).toEqual([["send", "t1", "--if", "idle", "--", "hello"]]);
    expect(r.sent()).toEqual([{ id: "t1", text: "hello" }]);
  });

  test("done: a plain send (the agent finished its turn and waits)", async () => {
    const r = rig({ t1: terminal({ status: { state: "done", app: "omp" } }) });
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
    const r = rig({ t1: terminal({ status: { state: "working", app: "omp" } }) });
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
    const r = rig({ t1: terminal({ status: { state: "working", app: "omp" } }) });
    expect((await r.rt.deliver(T1, "/goal pause", { when: "working" })).kind).toBe("delivered");
    expect(sends(r.calls())).toEqual([["send", "t1", "--if", "working", "--", "/goal pause"]]);
  });

  test("when=any sends with no status gate", async () => {
    const r = rig({ t1: terminal({ status: { state: "working", app: "omp" } }) });
    expect((await r.rt.deliver(T1, "x", { when: "any" })).kind).toBe("delivered");
    expect(sends(r.calls())).toEqual([["send", "t1", "--", "x"]]);
  });

  test("force types into a blocked agent with --force", async () => {
    const r = rig({ t1: terminal({ status: { state: "blocked", app: "omp" } }) });
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
    const get = { state: "live", status: { app: "omp", state: "idle" }, foreground: { name: "omp", argv: ["omp"], pid: 1 } };
    const rt = new HcRuntime(async (_cmd, argv) => {
      if (argv[1] === "send") throw new Error("broken pipe while sending secret text");
      return { code: 0, stdout: JSON.stringify(get), stderr: "" };
    });
    const out = await rt.deliver(T1, "secret text");
    expect(out.kind).toBe("ambiguous");
    expect(JSON.stringify(out)).not.toContain("secret text");
  });
});

describe("joinWrapped and the unwrapped read", () => {
  test("a row as wide as the terminal was cut inside a word: joined to the next row as is", () => {
    expect(joinWrapped("abcdefghij\nklm\nnext", 10)).toBe("abcdefghijklm\nnext");
  });

  test("a row one cell short was cut at a space hc dropped: joined with that space put back", () => {
    expect(joinWrapped("Error: rate\nlimited", 12)).toBe("Error: rate limited");
  });

  test("a shorter row ends its line; a row of wide characters counts two cells each", () => {
    expect(joinWrapped("short\nline", 10)).toBe("short\nline");
    // five CJK characters fill ten cells: wrapped. Counted as five characters the row would end its line.
    expect(joinWrapped("\u4e00\u4e8c\u4e09\u56db\u4e94\nNo API key", 10)).toBe("\u4e00\u4e8c\u4e09\u56db\u4e94No API key");
    // four of them fill eight of ten cells: one short of cols - 1, so the line ends there
    expect(joinWrapped("\u4e00\u4e8c\u4e09\u56db\nnext", 10)).toBe("\u4e00\u4e8c\u4e09\u56db\nnext");
  });

  test("read with unwrapped asks hc for the terminal's cols and joins rows that wide; a plain read leaves rows alone", async () => {
    const screen = `${"x".repeat(199)}\nlimit reached\n> `;
    const r = rig({ t1: terminal({ screen }) });
    expect(await r.rt.read(T1, 40)).toBe(screen);
    expect(r.calls().filter((c) => c[0] === "get")).toEqual([]);
    expect(await r.rt.read(T1, 40, { unwrapped: true })).toBe(`${"x".repeat(199)} limit reached\n> `);
    expect(r.calls().filter((c) => c[0] === "get")).toEqual([["get", "t1"]]);
  });
});
