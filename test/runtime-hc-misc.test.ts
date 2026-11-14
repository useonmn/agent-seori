// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { type HcError, hcCall } from "../src/runtime/hc/exec.ts";
import { rig, T1, terminal } from "./helpers/hc-rig.ts";

describe("typed text, shells, keys, read", () => {

  test("typeIntoShell sends into a silent shell without a status gate", async () => {
    const r = rig({ t1: terminal({ status: null, foreground: { name: "zsh", argv: ["-zsh"], pid: 2 } }) });
    expect(await r.rt.typeIntoShell(T1, "ls -la")).toBe(true);
    expect(r.calls().filter((c) => c[0] === "send")).toEqual([["send", "t1", "--", "ls -la"]]);
  });

  test("typeIntoShell refuses when an agent is in front", async () => {
    const r = rig({ t1: terminal() });
    expect(await r.rt.typeIntoShell(T1, "rm -rf x")).toBe(false);
    expect(r.sent()).toEqual([]);
  });

  test("keys map escape to esc in one call", async () => {
    const r = rig({ t1: terminal() });
    await r.rt.keys(T1, ["escape", "enter"]);
    expect(r.calls()).toEqual([["keys", "t1", "esc", "enter"]]);
  });

  test("read asks for history lines and returns the text", async () => {
    const r = rig({ t1: terminal({ screen: "line a\nline b" }) });
    expect(await r.rt.read(T1, 40)).toBe("line a\nline b");
    expect(r.calls()).toEqual([["read", "t1", "--lines", "40"]]);
  });
});

describe("close, list, groups, self", () => {
  test("close kills then removes", async () => {
    const r = rig({ t1: terminal() });
    await r.rt.close(T1);
    expect(r.calls()).toEqual([
      ["kill", "t1"],
      ["rm", "t1"],
    ]);
    expect(r.sleeps).toEqual([]);
    expect(r.terminals()["t1"]).toBeUndefined();
  });

  test("rm answering live is retried every 200 ms until it goes", async () => {
    const r = rig({ t1: terminal() }, {}, { liveAfterKill: 2 });
    await r.rt.close(T1);
    expect(r.calls().filter((c) => c[0] === "rm")).toHaveLength(3);
    expect(r.sleeps).toEqual([200, 200]);
  });

  test("still live after 5 retries is logged, not thrown", async () => {
    const r = rig({ t1: terminal() }, {}, { liveAfterKill: 99 });
    await r.rt.close(T1);
    expect(r.calls().filter((c) => c[0] === "rm")).toHaveLength(6);
    expect(r.sleeps).toEqual([200, 200, 200, 200, 200]);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toContain("t1");
  });

  test("closing a terminal hc no longer knows is a no-op", async () => {
    const r = rig();
    await r.rt.close(T1);
    expect(r.calls()).toEqual([["kill", "t1"]]);
  });

  test("list filters by the seori.group label and keeps only live terminals; only a reporting program is an agent", async () => {
    const r = rig({
      // A shell nothing reports from: hc still names its program as `agent`, which is not an agent session.
      t1: terminal({ labels: { "seori.group": "g1" }, argv: ["env", "bash"], status: null }),
      t2: terminal({ labels: { "seori.group": "g2" } }),
      t3: terminal({ labels: { "seori.group": "g1" }, argv: ["omp"] }),
      t4: terminal({ labels: { "seori.group": "g1" }, state: "finished" }),
    });
    expect(await r.rt.list({ group: "g1" })).toEqual([
      { ref: { runtime: "hc", id: "t1", group: "g1" }, cwd: "/w" },
      { ref: { runtime: "hc", id: "t3", group: "g1" }, cwd: "/w", status: "idle", agent: "omp" },
    ]);
    expect(r.calls()).toEqual([["ls", "--label", "seori.group=g1"]]);
  });

  test("list without a group lists every live terminal", async () => {
    const r = rig({ t1: terminal({ name: "lead" }), t2: terminal({ state: "finished" }) });
    expect(await r.rt.list()).toEqual([{ ref: { runtime: "hc", id: "t1" }, name: "lead", cwd: "/w", status: "idle", agent: "omp" }]);
    expect(r.calls()).toEqual([["ls"]]);
  });

  test("groups are the distinct seori.group labels of live terminals", async () => {
    const r = rig({
      t1: terminal({ labels: { "seori.group": "g1" } }),
      t2: terminal({ labels: { "seori.group": "g1" } }),
      t3: terminal({ labels: { other: "x" } }),
      t4: terminal({ labels: { "seori.group": "g2" } }),
      t5: terminal({ labels: { "seori.group": "g3" }, state: "finished" }),
    });
    expect(await r.rt.groups()).toEqual([
      { id: "g1", label: "g1" },
      { id: "g2", label: "g2" },
    ]);
  });

  test("self comes from HC_TERMINAL_ID", () => {
    expect(rig({}, { HC_TERMINAL_ID: "t9" }).rt.self()).toEqual({ runtime: "hc", id: "t9" });
    expect(rig({}, { HC_TERMINAL_ID: "t1b" }).rt.self()).toEqual({ runtime: "hc", id: "t1b" });
    expect(rig().rt.self()).toBeUndefined();
    expect(rig({}, { HC_TERMINAL_ID: "" }).rt.self()).toBeUndefined();
  });

  test("no agent session file", async () => {
    const r = rig({ t1: terminal() });
    expect(await r.rt.agentSession(T1)).toBeUndefined();
    expect(r.calls()).toEqual([]);
  });
});

describe("startAgent", () => {
  test("types the quoted agent command and returns once the agent reports", async () => {
    const r = rig({ t1: terminal({ status: null, foreground: { name: "bash", argv: ["bash"], pid: 3 } }) }, {}, { agentReports: true });
    await r.rt.startAgent(T1, ["--append-system-prompt", "it's me"]);
    expect(r.calls()).toEqual([
      ["send", "t1", "--", `'omp' '--append-system-prompt' 'it'\\''s me'`],
      ["get", "t1"],
    ]);
  });

  test("throws when nothing reports within the timeout", async () => {
    const r = rig({ t1: terminal({ status: null, foreground: { name: "bash", argv: ["bash"], pid: 3 } }) });
    await expect(r.rt.startAgent(T1, [], 1000)).rejects.toThrow(/did not report/);
    expect(r.sleeps).toEqual([500, 500]);
  });

  test("throws when the terminal is gone", async () => {
    const r = rig({ t1: terminal({ status: null, state: "finished" }) });
    await expect(r.rt.startAgent(T1, [])).rejects.toThrow(/gone|finished/);
  });
});

describe("hcCall", () => {
  test("parses hc's error JSON from stderr, hint either at error.hint or error.data.hint", async () => {
    const exec = async () => ({
      code: 3,
      stdout: "",
      stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal", data: { hint: "see ls" } } }),
    });
    const err = await hcCall(exec, ["get", "t5"]).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "not_found", hint: "see ls", reason: "no terminal" });
  });

  test("status_mismatch from the spike: rc 10 with hc's own JSON", async () => {
    const exec = async () => ({
      code: 10,
      stdout: "",
      stderr: JSON.stringify({ error: { hint: "nothing was typed", kind: "status_mismatch", message: "t1 is silent, not idle" } }),
    });
    expect(await hcCall(exec, ["send", "t1", "--if", "idle", "--", "x"]).catch((e: unknown) => e)).toMatchObject({
      kind: "status_mismatch",
      hint: "nothing was typed",
    });
  });

  test("redacts the delivered text; with no JSON the kind falls back to hc's exit-code table", async () => {
    const exec = async () => ({ code: 10, stdout: "", stderr: "boom" });
    const err = (await hcCall(exec, ["send", "t1", "--", "secret text"], { redact: "secret text" }).catch((e: unknown) => e)) as HcError;
    expect(err.kind).toBe("status_mismatch");
    expect(err.argv).toEqual(["--json", "send", "t1", "--", "<text>"]);
    expect(err.message).not.toContain("secret text");
  });
});
