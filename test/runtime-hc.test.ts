// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { HcError } from "../src/runtime/hc/exec.ts";
import { parseProbe } from "../src/runtime/hc/probe.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createArgv, MESSENGER_TOKEN_ENV, slugName } from "../src/runtime/hc/sessions.ts";
import type { SessionRole } from "../src/runtime/types.ts";
import { homeTag } from "../src/systemd.ts";
import { openSession } from "../src/runtime/types.ts";
import { lane, rig, SH, T1, terminal } from "./helpers/hc-rig.ts";

const UNSET = MESSENGER_TOKEN_ENV.flatMap((k) => ["-u", k]);

describe("create / start / createGroup", () => {
  test("create argv is exact: --json, background, no parent, no notes, seori labels, cwd, slug name, env then the shell", async () => {
    const r = rig({}, SH);
    const ref = await r.rt.create(lane);
    expect(ref).toEqual({ runtime: "hc", id: "t1", group: "g1" });
    expect(r.rawCalls()).toEqual([
      ["--json", "ls"],
      [
        "--json",
        "run",
        "--bg",
        "--no-parent",
        "--no-notify",
        "--label",
        "seori.group=g1",
        "--label",
        "seori.role=lane",
        "--label",
        "seori.name=Lane K",
        "--label",
        "seori.lane=Lane K",
        "--cwd",
        "/w",
        "--name",
        "lane-k",
        "--",
        "env",
        ...UNSET,
        "A=1",
        "B=it's a b",
        "/bin/zsh",
      ],
    ]);
    expect(r.terminals()["t1"]?.labels).toEqual({
      "seori.group": "g1",
      "seori.role": "lane",
      "seori.name": "Lane K",
      "seori.lane": "Lane K",
    });
  });

  test("no group labels seori.group=seori; a non-lane role has no seori.lane label; no SHELL runs sh", async () => {
    const r = rig();
    const ref = await r.rt.create({ name: "lead", cwd: "/r", env: {}, role: "lead", container: "workspace-root" });
    expect(ref).toEqual({ runtime: "hc", id: "t1", group: "seori" });
    expect(r.calls()[1]).toEqual([
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--label",
      "seori.group=seori",
      "--label",
      "seori.role=lead",
      "--label",
      "seori.name=lead",
      "--cwd",
      "/r",
      "--name",
      "lead",
      "--",
      "env",
      ...UNSET,
      "sh",
    ]);
    expect(r.calls().flat().some((a) => a.startsWith("dori."))).toBe(false);
  });

  test("an agent terminal unsets the messenger tokens before its shell; the daemon and duty loop terminals keep them", () => {
    const TOKENS = [
      "SEORI_TELEGRAM_TOKEN", "SEORI_DISCORD_TOKEN", "SEORI_SLACK_BOT_TOKEN", "SEORI_SLACK_APP_TOKEN", "SEORI_SLACK_USER_TOKEN", "SEORI_SLACK_COOKIE",
    ];
    const argv = (role: SessionRole) => createArgv({ name: "x", cwd: "/w", env: { SEORI_LANE: "x" }, role, container: "tab" }, "sh", undefined);
    const unset = (a: string[]) => a.flatMap((v, i) => (v === "-u" ? [a[i + 1] ?? ""] : []));
    for (const role of ["lane", "lead", "duty", "hourly-loop"] as const) {
      const a = argv(role);
      expect(unset(a).sort()).toEqual([...TOKENS].sort());
      const env = a.indexOf("env");
      expect(a.slice(env + 1 + 2 * TOKENS.length)).toEqual(["SEORI_LANE=x", "sh"]);
    }
    for (const role of ["daemon", "duty-loop"] as const) expect(unset(argv(role))).toEqual([]);
  });

  test("the unset list is every token variable the messenger adapters read", () => {
    const dir = join(import.meta.dir, "..", "src", "messenger");
    const read = new Set(readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").match(/SEORI_[A-Z_]*(TOKEN|COOKIE)\b/g) ?? []));
    const unset: string[] = [...MESSENGER_TOKEN_ENV];
    expect(unset.sort()).toEqual([...read].sort());
  });

  test("a spec with a home labels the terminal seori.home=<homeTag>", async () => {
    const r = rig();
    await r.rt.create({ ...lane, home: "/h/a" });
    expect(r.terminals()["t1"]?.labels["seori.home"]).toBe(homeTag("/h/a"));
  });

  test("list with homes reads each terminal's seori.home label; without it no hc get is made", async () => {
    const r = rig({
      t1: terminal({ labels: { "seori.group": "g", "seori.home": homeTag("/h/a") } }),
      t2: terminal({ labels: { "seori.group": "g" } }),
    });
    const listed = await r.rt.list({ group: "g", homes: true });
    expect(listed.map((s) => [s.ref.id, s.home])).toEqual([["t1", homeTag("/h/a")], ["t2", undefined]]);
    const before = r.calls().length;
    expect((await r.rt.list({ group: "g" })).map((s) => s.home)).toEqual([undefined, undefined]);
    expect(r.calls().slice(before).filter((c) => c[0] === "get")).toEqual([]);
  });

  test("start sends the command into the shell with no status gate", async () => {
    const r = rig({ t1: terminal({ status: null }) });
    await r.rt.start(T1, "omp --x 'a b'");
    expect(r.calls()).toEqual([["send", "t1", "--", "omp --x 'a b'"]]);
  });

  test("openSession is create then start", async () => {
    const r = rig({}, SH);
    expect(await openSession(r.rt, lane, "omp")).toEqual({ runtime: "hc", id: "t1", group: "g1" });
    expect(r.calls().map((c) => c[0])).toEqual(["ls", "run", "send"]);
    expect(r.calls()[2]).toEqual(["send", "t1", "--", "omp"]);
  });

  test("createGroup returns the label and makes no call", async () => {
    const r = rig();
    expect(await r.rt.createGroup("abcd1234", "/w")).toBe("abcd1234");
    expect(r.calls()).toEqual([]);
  });

  test("a live terminal holding the slug drops --name (hc names are unique among live terminals)", async () => {
    const r = rig({ t1: terminal({ name: "lane-k" }) });
    expect(await r.rt.create(lane)).toEqual({ runtime: "hc", id: "t2", group: "g1" });
    expect(r.calls()[1]).not.toContain("--name");
  });

  test("a finished terminal with the same name does not block the name", async () => {
    const r = rig({ t1: terminal({ name: "lane-k", state: "finished" }) });
    await r.rt.create(lane);
    expect(r.calls()[1]).toContain("--name");
  });

  test("a name taken between ls and run is retried once without --name", async () => {
    const r = rig({}, {}, { nameTaken: true });
    expect(await r.rt.create(lane)).toEqual({ runtime: "hc", id: "t1", group: "g1" });
    expect(r.calls().filter((c) => c[0] === "run").map((c) => c.includes("--name"))).toEqual([true, false]);
  });

  test("an env key that is not a shell name is refused before anything runs", async () => {
    const r = rig();
    await expect(r.rt.create({ ...lane, env: { "-i": "x" } })).rejects.toThrow(/-i/);
    expect(r.calls().some((c) => c[0] === "run")).toBe(false);
  });

  test("addresses past t9 are base 36 and come back as is", async () => {
    const init = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${(i + 1).toString(36)}`, terminal({ state: "finished" })]));
    const r = rig(init);
    expect((await r.rt.create(lane)).id).toBe("tb");
  });
});

describe("slugName", () => {
  test.each([
    ["Lane K", "lane-k"],
    ["a.b_c-d", "a.b_c-d"],
    ["x".repeat(40), "x".repeat(32)],
    ["", undefined],
    ["-_.lead", "lead"],
    ["t7", undefined],
    ["T12", undefined],
    ["t7x", "t7x"],
    ["---", undefined],
  ] as const)("%p -> %p", (name, want) => {
    expect(slugName(name)).toBe(want);
  });
});

describe("probe", () => {
  test.each([
    [
      "idle",
      terminal(),
      { status: "idle", agent: "omp", pgid: 4242, rootPid: 900, turn: 3, title: "omp lane", cwd: "/w", shellInFront: false },
    ],
    ["working", terminal({ status: { state: "working", app: "omp" } }), { status: "working", agent: "omp" }],
    ["blocked", terminal({ status: { state: "blocked", app: "omp" } }), { status: "blocked" }],
    ["done", terminal({ status: { state: "done", app: "omp" } }), { status: "done" }],
    ["error (no seori word for it)", terminal({ status: { state: "error", app: "omp" } }), { status: "unknown" }],
    [
      "silent shell",
      terminal({ status: null, foreground: { name: "bash", argv: ["bash"], pid: 7 } }),
      { status: "shell", agent: "bash", pgid: 7, shellInFront: true },
    ],
    [
      "silent program",
      terminal({ status: null, foreground: { name: "node", argv: ["node", "x.js"], pid: 8 } }),
      { status: "unknown", agent: "node", shellInFront: false },
    ],
    ["no foreground reported", terminal({ status: null, foreground: null }), { status: "shell", shellInFront: true }],
    ["finished", terminal({ state: "finished" }), { status: "gone" }],
    ["unknown word", terminal({ status: { state: "thinking" } }), { status: "unknown", agent: "omp" }],
  ] as const)("%s", async (_, t, want) => {
    const r = rig({ t1: t });
    expect(await r.rt.probe(T1)).toMatchObject(want);
  });

  test("a terminal hc does not know is gone", async () => {
    const r = rig();
    expect(await r.rt.probe(T1)).toEqual({ status: "gone", shellInFront: false });
    expect(await r.rt.status(T1)).toBe("gone");
  });

  test("any other get failure throws an HcError carrying hc's kind and hint", async () => {
    const r = rig({ t1: terminal() }, {}, { getError: "unavailable" });
    const err = await r.rt.probe(T1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HcError);
    expect(err).toMatchObject({ kind: "unavailable", hint: "hint for unavailable" });
  });

  test("status is one get, no screen read", async () => {
    const r = rig({ t1: terminal({ status: { state: "working", app: "omp" }, screen: "x" }) });
    expect(await r.rt.status(T1)).toBe("working");
    expect(r.calls()).toEqual([["get", "t1"]]);
  });

  test("parseProbe reads hc 0.1.20's get shape (the bash terminal of the spike)", () => {
    const live = {
      address: "t1",
      argv: ["env", "FOO=1", "bash"],
      cwd: "/tmp/work",
      foreground: { argv: ["bash"], cwd: "/tmp/work", name: "bash", pid: 54839 },
      labels: { "seori.group": "test" },
      pid: 54839,
      state: "live",
      status: null,
      status_ms: null,
      title: "user@host: /tmp/work",
      turn: 0,
    };
    expect(parseProbe(live)).toEqual({
      status: "shell",
      agent: "bash",
      pgid: 54839,
      rootPid: 54839,
      turn: 0,
      title: "user@host: /tmp/work",
      cwd: "/tmp/work",
      shellInFront: true,
      foreground: [{ name: "bash", argv: ["bash"], pid: 54839 }],
    });
  });

  test("parseProbe reads omp's status object {app,state}", () => {
    const omp = {
      state: "live",
      status: { app: "omp", state: "idle" },
      foreground: { argv: ["/opt/omp/bin/omp"], name: "omp", pid: 9 },
      turn: 1,
    };
    expect(parseProbe(omp)).toMatchObject({ status: "idle", agent: "omp", turn: 1, shellInFront: false });
  });
});
