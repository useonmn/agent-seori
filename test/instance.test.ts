import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAD_START_LINE, main, up, upCheck } from "../src/cli.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { recordPath } from "../src/down.ts";
import { AGENT_OMP_CONFIG, agentOmpConfig, ompMemoryDb, Refusal, startLane } from "../src/harness.ts";
import { World, paneRef } from "./fake.ts";

// Several seori instances on one PC, each with its own $SEORI_HOME: its own name (seori.group label), one set of panes per
// home, and its own omp memory.

const named = (root: string, name: string) => writeFileSync(join(root, "config.json"), JSON.stringify({ name }));

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

const opened = (w: World) => w.calls.filter((c) => ["create", "split", "start", "run"].includes(String(c.argv[1]))).length;

describe("instance name", () => {
  test("config.json name: default seori, any script, and a name that needs quoting as a label is an error", () => {
    const root = mkdtempSync(join(tmpdir(), "seori-name-"));
    expect(loadConfig(root).name).toBe("seori");
    named(root, "바리-2");
    expect(loadConfig(root).name).toBe("바리-2");
    for (const bad of ["", "two words", "-x", "a".repeat(41), 7]) {
      writeFileSync(join(root, "config.json"), JSON.stringify({ name: bad }));
      expect(() => loadConfig(root)).toThrow(ConfigError);
    }
  });

  test("a config.json from before talking with others was removed still loads; its keys are ignored", () => {
    const root = mkdtempSync(join(tmpdir(), "seori-legacy-"));
    writeFileSync(join(root, "config.json"), JSON.stringify({ name: "seori", talkWithOthers: false, agentTurnLimit: 6, trusted: [{ source: "slack", id: "U1" }] }));
    expect(loadConfig(root).name).toBe("seori");
  });

  test("a lane's terminal is labelled with the instance's name as its group", async () => {
    const w = new World();
    const d = w.deps();
    named(d.store.root, "seori-two");
    const brief = join(d.store.root, "brief.md");
    writeFileSync(brief, "Do it.");
    const lane = await startLane(d, "fix", brief);
    expect(w.panes.get(lane.sessionRef.id)!.labels["seori.group"]).toBe("seori-two");
  });
});

describe("seori up, once per home", () => {
  test("opens the terminals under the instance's name; a second up prints ALREADY UP, exits 0 and opens nothing", async () => {
    const w = new World();
    const d = { ...w.deps(), platform: "darwin" }; // terminals, not systemd units
    named(d.store.root, "seori-two");
    w.heartbeat(d.store.root, 0);
    const first = await captureLog(() => main(["up", "--cwd", d.store.root], d));
    expect(first).toEndWith(" name=seori-two");
    expect(new Set([...w.panes.values()].map((p) => p.labels["seori.group"]))).toEqual(new Set(["seori-two"]));
    const before = opened(w);
    let code: number | undefined;
    const again = await captureLog(async () => { code = await main(["up", "--cwd", d.store.root], d); });
    expect(code).toBe(0);
    expect(again).toBe(`ALREADY UP name=seori-two home=${d.store.root} lead=hc:${d.store.roles().lead!.id} running=none; nothing opened`);
    expect(opened(w)).toBe(before);
  });

  test("a live unit set with its lead pane gone reopens the missing lead and duty panes, and touches no unit", async () => {
    const w = new World();
    const d = w.deps();
    mkdirSync(join(d.store.root, "run"));
    // The units are really running: their records name this process, which is alive by definition.
    writeFileSync(recordPath(d.store.root, "daemon-loop"), JSON.stringify({ pid: process.pid }));
    writeFileSync(recordPath(d.store.root, "duty"), JSON.stringify({ pid: process.pid }));
    // What a reboot leaves: the units come back, the panes do not (and the remembered ids are from the old core).
    d.store.setRole("lead", paneRef("t1"));
    d.store.setRole("duty", paneRef("t2"));
    const plan = await upCheck(d, "seori");
    expect(plan.kind).toBe("panes");
    expect(plan.kind === "panes" ? plan.missing : []).toEqual(["lead", "duty"]);
    const panesBefore = w.panes.size;
    // The roles the reopened lead's `seori boot` would find when it is told to run it.
    let dutyAtStart: string | undefined;
    const deliver = d.runtime.deliver.bind(d.runtime);
    d.runtime.deliver = async (ref, text, opts) => {
      if (text === LEAD_START_LINE) dutyAtStart = d.store.roles().duty?.id;
      return deliver(ref, text, opts);
    };
    const line = await captureLog(() => up(d, undefined));
    expect(line).toStartWith("REOPENED lead,duty lead=hc:t");
    // The start line waits for the reopened duty pane, so the boot does not report it unregistered.
    expect(dutyAtStart).toBe(d.store.roles().duty!.id);
    expect(dutyAtStart).not.toBe("t2");
    expect(line).toMatch(/running=[a-z,-]*daemon-loop/);
    expect(line).toMatch(/running=[a-z,-]*duty/);
    // Exactly the two missing panes were opened, and the roles now name the new ones.
    expect(w.panes.size).toBe(panesBefore + 2);
    expect(d.store.roles().lead!.id).not.toBe("t1");
    expect(d.store.roles().duty!.id).not.toBe("t2");
    // With the lead pane live again, the same command opens nothing: no duplicate lead.
    const panesAfter = w.panes.size;
    expect(await captureLog(() => up(d, undefined))).toStartWith("ALREADY UP");
    expect(w.panes.size).toBe(panesAfter);
  });

  test("a home with a live lead but no live duty reopens only the duty pane", async () => {
    const w = new World();
    const d = w.deps();
    d.store.setRole("lead", paneRef("t1"));
    d.store.setRole("duty", paneRef("t2"));
    const lead = w.addPane("t1", "idle");
    const before = opened(w);
    const line = await captureLog(() => up(d, undefined));
    expect(line).toStartWith("REOPENED duty lead=hc:t1 duty=hc:t");
    expect(opened(w)).toBe(before + 1);
    expect(d.store.roles().lead!.id).toBe("t1");
    // The live lead is not new: it gets no start line (it would boot and announce a restart that did not happen).
    expect(lead.received).not.toContain(LEAD_START_LINE);
  });

  test("another home's terminals under the same name are refused; a stale lead id in another instance's group is not this home", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("t9", "idle", { "seori.group": "bari" }); // the other instance's lead, whose id this home recorded before an hc restart
    d.store.setRole("lead", paneRef("t9"));
    expect((await upCheck(d, "seori", () => false)).kind).toBe("fresh");
    w.addPane("t3", "idle", { "seori.group": "seori" });
    await expect(upCheck(d, "seori", () => false)).rejects.toThrow(Refusal);
    await expect(upCheck(d, "seori", () => false)).rejects.toThrow(/labelled seori\.group="seori" \(seori\).*config\.json/);
  });
});

describe("omp memory per home", () => {
  test("every home but ~/.seori points mnemopi.dbPath into itself; ~/.seori keeps omp's own memory", () => {
    const home = join(tmpdir(), "owner", ".seori");
    expect(agentOmpConfig(home, home)).toBe(AGENT_OMP_CONFIG);
    const other = join(tmpdir(), "owner", "seori-two");
    const parsed = Bun.YAML.parse(agentOmpConfig(other, home)) as { startup: { setupWizard: boolean }; mnemopi: { dbPath: string } };
    expect(parsed).toEqual({ startup: { setupWizard: false }, mnemopi: { dbPath: ompMemoryDb(other) } });
    expect(ompMemoryDb(other)).toStartWith(other);
  });
});
