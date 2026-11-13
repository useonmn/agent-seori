import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompProfile, TEST_AGENT_CMD_SWITCH } from "../src/agent/profile.ts";
import { LEAD_EXTENSION, main, usesSystemdUnits } from "../src/cli.ts";
import type { Deps } from "../src/harness.ts";
import { Refusal } from "../src/harness.ts";
import { Runtimes, shq } from "../src/runtime/index.ts";
import {
  homeTag, legacyUnitName, removeUnits, UNIT_KINDS, UnitError, unitFile, unitHome, unitInstance, unitName, unitPath, writeUnits,
} from "../src/systemd.ts";
import { World } from "./fake.ts";
import { rig, terminal } from "./helpers/hc-rig.ts";

// `seori up` / `seori down` on hc: lead and duty terminals in the home's seori.group, the resident processes as
// systemd --user units. A fake hc (test/helpers/fake-hc.ts) and a fake systemctl that records its argv; nothing
// reaches a real hc core or the real user manager.

const CLEARED = ["HC_TERMINAL_ID", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_SESSION", "HC_SOCKET", "SEORI_MODEL", "SEORI_HERDR_SESSION", "SEORI_SYSTEMD_DIR", "SEORI_SYSTEMCTL", "PI_CONFIG_FILES"];
let saved: Record<string, string | undefined> = {};
let unitDir = "";
let ctlLog = "";

beforeEach(() => {
  saved = Object.fromEntries(CLEARED.map((k) => [k, process.env[k]]));
  for (const k of CLEARED) delete process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "seori-fakectl-"));
  unitDir = join(dir, "units");
  ctlLog = join(dir, "systemctl.log");
  writeFileSync(ctlLog, "");
  const ctl = join(dir, "systemctl");
  writeFileSync(ctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ctlLog}'\n`);
  chmodSync(ctl, 0o755);
  process.env["SEORI_SYSTEMD_DIR"] = unitDir;
  process.env["SEORI_SYSTEMCTL"] = ctl;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ctlCalls = (): string[] => readFileSync(ctlLog, "utf8").split("\n").filter(Boolean);

async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

function setup(initial = {}, platform = "linux") {
  const r = rig(initial, {}, { agentReports: true });
  const w = new World();
  const d: Deps = { ...w.deps(), runtimes: new Runtimes("hc", () => r.rt), agent: ompProfile, platform };
  writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ name: "seori-two" }));
  w.heartbeat(d.store.root, 0);
  return { r, d };
}

/** The unit names of the test home: seori-<instance>-<homeTag>-<kind>.service. */
const unitsOf = (home: string): string[] => UNIT_KINDS.map((kind) => `seori-seori-two-${homeTag(home)}-${kind}.service`);

describe("unit files", () => {
  test("a unit runs seori under bun with its home, restarts on failure and is wanted by default.target", () => {
    const spec = {
      instance: "seori-two",
      home: "/h/seori two",
      cwd: "/h/seori two",
      bun: "/b/bun",
      cli: "/s/src/cli.ts",
      env: { PATH: "/b:/home/u/.omp/agent/kill-guard/1:/usr/bin:/mnt/c/WINDOWS", SEORI_MODEL: "m%1", HC_TERMINAL_ID: "t9", HC_SCOPE: "x", XDG_RUNTIME_DIR: "/run/user/1000" },
    };
    expect(unitFile(spec, "daemon")).toBe(
      [
        "[Unit]",
        "Description=seori seori-two messenger daemon (SEORI_HOME=/h/seori two)",
        "",
        "[Service]",
        "Type=simple",
        'Environment="SEORI_HOME=/h/seori two"',
        'Environment="SEORI_RUNTIME=hc"',
        'Environment="PATH=/b:/usr/bin"',
        'Environment="SEORI_MODEL=m%%1"',
        'Environment="XDG_RUNTIME_DIR=/run/user/1000"',
        "WorkingDirectory=/h/seori two",
        'ExecStart="/b/bun" "/s/src/cli.ts" "daemon-loop"',
        "Restart=on-failure",
        "RestartSec=2",
        "SuccessExitStatus=130 143",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    expect(unitFile(spec, "duty")).toContain('ExecStart="/b/bun" "/s/src/cli.ts" "duty" "--interval" "60"\n');
    expect(unitFile(spec, "hourly")).toContain('ExecStart="/b/bun" "/s/src/cli.ts" "loop"\n');
    expect(unitFile({ ...spec, cli: '/a"$b\\c' }, "hourly")).toContain('"/a\\"$$b\\\\c"');
    // systemd expands $ in ExecStart= only: Environment= values keep a single $
    const dollar = unitFile({ ...spec, home: "/h/$x", env: { SEORI_MODEL: "a$b", PATH: "/p$1" } }, "daemon");
    expect(dollar).toContain('\nEnvironment="SEORI_HOME=/h/$x"\n');
    expect(dollar).toContain('\nEnvironment="SEORI_MODEL=a$b"\n');
    expect(dollar).toContain('\nEnvironment="PATH=/p$1"\n');
    expect(dollar).not.toContain("Environment=\"SEORI_MODEL=a$$b\"");
    expect(unitFile({ ...spec, cwd: "/h/100%" }, "daemon")).toContain("\nWorkingDirectory=/h/100%%\n");
  });

  test("unit PATH drops session-only wrapper dirs and Windows drives mounted under /mnt", () => {
    expect(unitPath("/b:/home/u/.omp/agent/kill-guard/5:/usr/bin::/mnt/c/WINDOWS:/bin")).toBe("/b:/usr/bin:/bin");
    expect(unitPath("")).toBe("");
  });

  test("removing units tolerates units that never loaded, and still disables and removes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seori-units-"));
    const spec = { instance: "x", home: "/h", cwd: "/h", bun: "/b/bun", cli: "/s/cli.ts", env: {} };
    const names = writeUnits(dir, spec);
    const calls: string[] = [];
    const ctl = async (args: readonly string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "stop") throw new Error("systemctl --user stop failed (5): Failed to stop a.service: Unit a.service not loaded.");
    };
    expect(await removeUnits(dir, "x", "/h", UNIT_KINDS, ctl)).toHaveLength(3);
    expect(calls).toEqual([`stop ${names.join(" ")}`, `disable ${names.join(" ")}`, "daemon-reload"]);
    expect(readdirSync(dir)).toEqual([]);
    const failing = async (args: readonly string[]) => {
      if (args[0] === "stop") throw new Error("systemctl --user stop failed (1): Access denied");
    };
    writeUnits(dir, spec);
    await expect(removeUnits(dir, "x", "/h", UNIT_KINDS, failing)).rejects.toThrow(/Access denied/);
  });

  test("unit names: seori-<instance>-<8 hex of the home>-<kind>.service; bytes systemd does not allow are escaped", () => {
    const tag = homeTag("/h/a");
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    expect(unitName("seori", "/h/a", "daemon")).toBe(`seori-seori-${tag}-daemon.service`);
    // stable for the same resolved home, different for another home with the same instance name
    expect(unitName("seori", "/h/a/", "daemon")).toBe(unitName("seori", "/h/x/../a", "daemon"));
    expect(unitName("seori", "/h/b", "daemon")).not.toBe(unitName("seori", "/h/a", "daemon"));
    expect(unitInstance("바리-2")).toBe("\\xeb\\xb0\\x94\\xeb\\xa6\\xac-2");
    expect(unitName("a b/c", "/h/a", "duty")).toBe(`seori-a\\x20b\\x2fc-${tag}-duty.service`);
    expect(legacyUnitName("seori", "duty")).toBe("seori-seori-duty.service");
  });

  test("a line break in an env value, SEORI_HOME or the cwd is refused, not written into a unit", () => {
    const spec = { instance: "x", home: "/h", cwd: "/h", bun: "/b/bun", cli: "/s/cli.ts", env: {} };
    const cases: [Partial<typeof spec> & { env?: Record<string, string> }, string][] = [
      [{ env: { SEORI_MODEL: "m\nExecStartPre=/bin/evil" } }, "SEORI_MODEL"],
      [{ env: { PATH: "/b\r/c" } }, "PATH"],
      [{ home: "/h\n[Service]" }, "SEORI_HOME"],
      [{ cwd: "/h\nExecStart=/bin/evil" }, "the working directory"],
      [{ cwd: "/h\r" }, "the working directory"],
    ];
    for (const [over, what] of cases) {
      const bad = { ...spec, ...over };
      expect(() => unitFile(bad, "daemon")).toThrow(UnitError);
      expect(() => unitFile(bad, "daemon")).toThrow(`seori: cannot write the systemd units: ${what} contains a line break (\\n or \\r)`);
      const dir = mkdtempSync(join(tmpdir(), "seori-units-"));
      expect(() => writeUnits(dir, bad)).toThrow(UnitError);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("SEORI_AGENT_CMD reaches a unit only when it is omp; the test-only switch never does", () => {
    const spec = { instance: "x", home: "/h", cwd: "/h", bun: "/b/bun", cli: "/s/cli.ts", env: {} };
    expect(unitFile({ ...spec, env: { SEORI_AGENT_CMD: "/opt/bin/omp" } }, "duty")).toContain('\nEnvironment="SEORI_AGENT_CMD=/opt/bin/omp"\n');
    const fake = unitFile({ ...spec, env: { SEORI_AGENT_CMD: "/t/fake-omp.ts", [TEST_AGENT_CMD_SWITCH]: "1" } }, "duty");
    expect(fake).not.toContain("SEORI_AGENT_CMD");
    expect(fake).not.toContain(TEST_AGENT_CMD_SWITCH);
  });

  test("two homes with one instance name get separate units; a unit of another home under this home's name is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "seori-units-"));
    const a = { instance: "seori", home: "/h/a", cwd: "/h/a", bun: "/b/bun", cli: "/s/cli.ts", env: {} };
    const b = { ...a, home: "/h/b", cwd: "/h/b" };
    const namesA = writeUnits(dir, a);
    const namesB = writeUnits(dir, b);
    expect(readdirSync(dir).sort()).toEqual([...namesA, ...namesB].sort());
    expect(namesA.map((n) => unitHome(dir, n))).toEqual(["/h/a", "/h/a", "/h/a"]);
    expect(namesB.map((n) => unitHome(dir, n))).toEqual(["/h/b", "/h/b", "/h/b"]);
    expect(writeUnits(dir, a)).toEqual(namesA); // rewriting a home's own units is fine
    // a file under home a's name that runs home b (hand-edited, or a hash collision) is never overwritten
    writeFileSync(join(dir, namesA[0]!), unitFile(b, "daemon"));
    expect(() => writeUnits(dir, a)).toThrow(UnitError);
    expect(() => writeUnits(dir, a)).toThrow(`seori: the systemd unit ${namesA[0]} in ${dir} runs SEORI_HOME=/h/b, not /h/a; run seori down there first`);
    expect(readFileSync(join(dir, namesA[0]!), "utf8")).toBe(unitFile(b, "daemon"));
  });

  test("removing units also removes this home's units of the old naming scheme, never another home's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seori-units-"));
    const spec = { instance: "seori", home: "/h/$a", cwd: "/h/$a", bun: "/b/bun", cli: "/s/cli.ts", env: {} };
    // the old scheme wrote seori-<instance>-<kind>.service and escaped $ as $$ in Environment= too
    const legacy = (home: string) => unitFile({ ...spec, home }, "daemon").replace(/\$/g, "$$$$");
    writeFileSync(join(dir, legacyUnitName("seori", "daemon")), legacy("/h/$a"));
    writeFileSync(join(dir, legacyUnitName("seori", "duty")), legacy("/h/$a/"));
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "other", legacyUnitName("seori", "daemon")), legacy("/h/other"));
    writeFileSync(join(dir, legacyUnitName("seori", "hourly")), legacy("/h/other"));
    const current = writeUnits(dir, spec);
    const calls: string[] = [];
    const lines = await removeUnits(dir, "seori", spec.home, UNIT_KINDS, async (args) => void calls.push(args.join(" ")));
    const removed = [...current, legacyUnitName("seori", "daemon"), legacyUnitName("seori", "duty")];
    expect(calls).toEqual([`stop ${removed.join(" ")}`, `disable ${removed.join(" ")}`, "daemon-reload"]);
    expect(lines).toHaveLength(5);
    expect(readdirSync(dir).sort()).toEqual(["other", legacyUnitName("seori", "hourly")].sort());
  });
});

describe("seori up on hc", () => {
  test("opens lead and duty terminals in the home's group, records them, writes and starts the units", async () => {
    const { r, d } = setup();
    const root = d.store.root;
    const UNITS = unitsOf(root);
    const out = await captureLog(() => main(["up"], d));
    expect(out).toBe(`UP lead=hc:t1 duty=hc:t2 units=${UNITS.join(",")} home=${root} name=seori-two`);
    // omp's settings: agent-omp.yml for every agent, lead-omp.yml after it for the lead only
    const agentOmp = join(root, "prompts", "agent-omp.yml");
    const leadConfig = `PI_CONFIG_FILES=${agentOmp}:${join(root, "prompts", "lead-omp.yml")}`;
    const opened = r.calls().filter((c) => c[0] === "run" || c[0] === "send");
    expect(opened).toEqual([
      [
        "run", "--bg", "--no-parent", "--no-notify",
        "--label", "seori.group=seori-two", "--label", "seori.role=lead", "--label", "seori.name=seori-two",
        "--cwd", root, "--name", "seori-two", "--", "env", `SEORI_HOME=${root}`, "SEORI_CMD=seori", leadConfig, "sh",
      ],
      ["send", "t1", "--", ["omp", "-e", LEAD_EXTENSION, "--append-system-prompt", join(root, "prompts", "lead.md")].map(shq).join(" ")],
      [
        "run", "--bg", "--no-parent", "--no-notify",
        "--label", "seori.group=seori-two", "--label", "seori.role=duty", "--label", "seori.name=seori-two-duty",
        "--cwd", root, "--name", "seori-two-duty", "--", "env", `SEORI_HOME=${root}`, `PI_CONFIG_FILES=${agentOmp}`, "sh",
      ],
      ["send", "t2", "--", ["omp", "--append-system-prompt", join(root, "prompts", "duty.md")].map(shq).join(" ")],
    ]);
    expect(d.store.roles()).toEqual({ lead: { runtime: "hc", id: "t1" }, duty: { runtime: "hc", id: "t2" } });
    expect(readdirSync(unitDir).sort()).toEqual(UNITS);
    const spec = { instance: "seori-two", home: root, cwd: root, bun: process.execPath, cli: join(import.meta.dir, "..", "src", "cli.ts"), env: process.env };
    expect(readFileSync(join(unitDir, UNITS[0]!), "utf8")).toBe(unitFile(spec, "daemon"));
    expect(readFileSync(join(unitDir, UNITS[1]!), "utf8")).toBe(unitFile(spec, "duty"));
    expect(readFileSync(join(unitDir, UNITS[2]!), "utf8")).toBe(unitFile(spec, "hourly"));
    expect(ctlCalls()).toEqual(["--user daemon-reload", `--user enable --now ${UNITS[0]}`, `--user enable --now ${UNITS[1]} ${UNITS[2]}`]);
  });

  test("--cwd starts the agents and the units there", async () => {
    const { r, d } = setup();
    const UNITS = unitsOf(d.store.root);
    const cwd = mkdtempSync(join(tmpdir(), "seori-upcwd-"));
    await captureLog(() => main(["up", "--cwd", cwd], d));
    const runs = r.calls().filter((c) => c[0] === "run");
    expect(runs.map((c) => c[c.indexOf("--cwd") + 1])).toEqual([cwd, cwd]);
    expect(readFileSync(join(unitDir, UNITS[0]!), "utf8")).toContain(`WorkingDirectory=${cwd}\n`);
  });

  test("a second up prints ALREADY UP and opens nothing; down stops, disables and removes the units and closes the group", async () => {
    const { r, d } = setup({ t1: terminal({ labels: { "seori.group": "other" } }) });
    const UNITS = unitsOf(d.store.root);
    await captureLog(() => main(["up"], d));
    const [hcBefore, ctlBefore] = [r.calls().length, ctlCalls().length];
    let code: number | undefined;
    const again = await captureLog(async () => { code = await main(["up"], d); });
    expect(code).toBe(0);
    expect(again).toBe(`ALREADY UP name=seori-two home=${d.store.root} lead=hc:t2 running=none; nothing opened`);
    expect(r.calls().slice(hcBefore).filter((c) => c[0] === "run" || c[0] === "send")).toEqual([]);
    expect(ctlCalls().length).toBe(ctlBefore);

    const down = await captureLog(async () => { code = await main(["down"], d); });
    expect(code).toBe(0);
    expect(ctlCalls().slice(ctlBefore)).toEqual([`--user stop ${UNITS.join(" ")}`, `--user disable ${UNITS.join(" ")}`, "--user daemon-reload"]);
    expect(readdirSync(unitDir)).toEqual([]);
    expect(down.split("\n").filter((l) => l.startsWith("CLOSED"))).toEqual(["CLOSED hc:t2 (seori.group=seori-two)", "CLOSED hc:t3 (seori.group=seori-two)"]);
    // Only this home's terminals: the other group's terminal is left alone.
    expect(Object.keys(r.terminals())).toEqual(["t1"]);

    const third = await captureLog(() => main(["up"], d));
    expect(third).toStartWith("UP lead=hc:t4 duty=hc:t5 ");
  });

  test("down with one group stops only that unit and closes no terminal", async () => {
    const { r, d } = setup();
    const UNITS = unitsOf(d.store.root);
    await captureLog(() => main(["up"], d));
    const before = ctlCalls().length;
    await captureLog(() => main(["down", "loop"], d));
    expect(ctlCalls().slice(before)).toEqual([`--user stop ${UNITS[2]}`, `--user disable ${UNITS[2]}`, "--user daemon-reload"]);
    expect(readdirSync(unitDir).sort()).toEqual(UNITS.slice(0, 2));
    expect(Object.keys(r.terminals()).sort()).toEqual(["t1", "t2"]);
  });

  test("down migrates: it removes this home's units of the old naming scheme too", async () => {
    const { d } = setup();
    const root = d.store.root;
    const old = UNIT_KINDS.map((kind) => legacyUnitName("seori-two", kind));
    const spec = { instance: "seori-two", home: root, cwd: root, bun: "/b/bun", cli: "/s/cli.ts", env: {} };
    mkdirSync(unitDir, { recursive: true });
    UNIT_KINDS.forEach((kind, i) => writeFileSync(join(unitDir, old[i]!), unitFile(spec, kind)));
    const out = await captureLog(() => main(["down"], d));
    expect(ctlCalls()).toEqual([`--user stop ${old.join(" ")}`, `--user disable ${old.join(" ")}`, "--user daemon-reload"]);
    expect(out.split("\n").filter((l) => l.startsWith("STOPPED UNIT"))).toHaveLength(3);
    expect(readdirSync(unitDir)).toEqual([]);
  });

  test("up refuses a cwd with a line break before it opens a terminal or writes a unit", async () => {
    const { r, d } = setup();
    const cwd = join(mkdtempSync(join(tmpdir(), "seori-upcwd-")), "a\nExecStartPre=x");
    mkdirSync(cwd);
    await expect(main(["up", "--cwd", cwd], d)).rejects.toThrow(UnitError);
    expect(r.calls().filter((c) => c[0] === "run")).toEqual([]);
    expect(existsSync(unitDir) ? readdirSync(unitDir) : []).toEqual([]);
    expect(ctlCalls()).toEqual([]);
  });

  test("down on a home that has no units runs no systemctl", async () => {
    const { d } = setup();
    await captureLog(() => main(["down"], d));
    expect(ctlCalls()).toEqual([]);
    expect(existsSync(unitDir)).toBe(false);
  });

  test("only Linux uses systemd units; macOS keeps the resident processes in terminals", () => {
    const { d } = setup();
    expect(usesSystemdUnits({ ...d, platform: "linux" })).toBe(true);
    expect(usesSystemdUnits({ ...d, platform: "darwin" })).toBe(false);
    expect(usesSystemdUnits({ ...d, platform: undefined })).toBe(process.platform === "linux");
  });

  test("on macOS up opens daemon, duty loop and hourly loop terminals in the group and touches no systemd", async () => {
    const { r, d } = setup({}, "darwin");
    const root = d.store.root;
    const out = await captureLog(() => main(["up"], d));
    expect(out).toBe(`UP lead=hc:t1 duty=hc:t2 loop=hc:t3 hourly=hc:t4 daemon=hc:t5 home=${root} name=seori-two`);
    const runs = r.calls().filter((c) => c[0] === "run");
    expect(runs.map((c) => c.find((a) => String(a).startsWith("seori.role=")))).toEqual(
      ["seori.role=lead", "seori.role=duty", "seori.role=duty-loop", "seori.role=hourly-loop", "seori.role=daemon"],
    );
    for (const c of runs) expect(c).toContain("seori.group=seori-two");
    const started = r.calls().filter((c) => c[0] === "send" && ["t3", "t4", "t5"].includes(String(c[1])));
    expect(started).toEqual([
      ["send", "t5", "--", "seori daemon-loop"],
      ["send", "t3", "--", "seori duty --interval 60"],
      ["send", "t4", "--", "seori loop"],
    ]);
    expect(existsSync(unitDir)).toBe(false);
    expect(ctlCalls()).toEqual([]);

    const down = await captureLog(() => main(["down"], d));
    expect(ctlCalls()).toEqual([]);
    expect(down.split("\n").filter((l) => l.startsWith("CLOSED"))).toHaveLength(5);
    expect(Object.keys(r.terminals())).toEqual([]);
  });

  test("terminals in the home's group without a live lead or process are refused, not joined", async () => {
    const { r, d } = setup({ t1: terminal({ labels: { "seori.group": "seori-two" } }) });
    await expect(main(["up"], d)).rejects.toThrow(Refusal);
    await expect(main(["up"], d)).rejects.toThrow(/seori\.group="seori-two" \(seori-two\) are open, but this home .* has no live lead/);
    expect(r.calls().filter((c) => c[0] === "run")).toEqual([]);
    expect(ctlCalls()).toEqual([]);
  });
});
