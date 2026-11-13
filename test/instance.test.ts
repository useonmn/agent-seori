import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, upCheck } from "../src/cli.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { recordPath } from "../src/down.ts";
import { AGENT_OMP_CONFIG, agentOmpConfig, ompMemoryDb, Refusal, startLane } from "../src/harness.ts";
import { World, herdrRef } from "./fake.ts";

// Several seori instances on one PC, each with its own $SEORI_HOME: its own name (herdr label), one set of panes per
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
  test("config.json name: default seori, any script, and a name herdr could not take as a label is an error", () => {
    const root = mkdtempSync(join(tmpdir(), "seori-name-"));
    expect(loadConfig(root).name).toBe("seori");
    named(root, "바리-2");
    expect(loadConfig(root).name).toBe("바리-2");
    for (const bad of ["", "two words", "-x", "a".repeat(41), 7]) {
      writeFileSync(join(root, "config.json"), JSON.stringify({ name: bad }));
      expect(() => loadConfig(root)).toThrow(ConfigError);
    }
  });

  test("a lane with no workspace to join opens one under the instance's name", async () => {
    const w = new World();
    const d = w.deps();
    named(d.store.root, "seori-two");
    const brief = join(d.store.root, "brief.md");
    writeFileSync(brief, "Do it.");
    const prev = process.env["HERDR_WORKSPACE_ID"];
    delete process.env["HERDR_WORKSPACE_ID"];
    try {
      await startLane(d, "fix", brief);
    } finally {
      if (prev !== undefined) process.env["HERDR_WORKSPACE_ID"] = prev;
    }
    expect(w.calls.find((c) => c.argv[0] === "workspace" && c.argv[1] === "create")!.argv.slice(0, 4)).toEqual(["workspace", "create", "--label", "seori-two"]);
  });
});

describe("seori up, once per home", () => {
  test("opens the workspace under the instance's name; a second up prints ALREADY UP, exits 0 and opens nothing", async () => {
    const w = new World();
    const d = w.deps();
    named(d.store.root, "seori-two");
    w.heartbeat(d.store.root, 0);
    const first = await captureLog(() => main(["up", "--cwd", d.store.root], d));
    expect(first).toEndWith(" name=seori-two");
    expect(w.workspaces).toEqual([{ workspace_id: "w1", label: "seori-two" }]);
    const before = opened(w);
    let code: number | undefined;
    const again = await captureLog(async () => { code = await main(["up", "--cwd", d.store.root], d); });
    expect(code).toBe(0);
    expect(again).toBe(`ALREADY UP name=seori-two home=${d.store.root} lead=${d.store.roles().lead!.id} running=none; nothing opened`);
    expect(opened(w)).toBe(before);
  });

  test("a live loop or daemon of this home counts as up even when its lead pane is gone", async () => {
    const d = new World().deps();
    mkdirSync(join(d.store.root, "run"));
    writeFileSync(recordPath(d.store.root, "daemon-loop"), JSON.stringify({ pid: 4242 }));
    writeFileSync(recordPath(d.store.root, "duty"), JSON.stringify({ pid: 4343 }));
    d.store.setRole("lead", herdrRef("w1:p1"));
    const line = await upCheck(d, "seori", (pid) => pid === 4242);
    expect(line).toStartWith(`ALREADY UP name=seori home=${d.store.root} lead=gone running=daemon-loop; nothing opened`);
    expect(await upCheck(d, "seori", () => false)).toBeUndefined();
  });

  test("another home's workspace under the same name is refused; a stale lead id in another instance's workspace is not this home", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w9:p1", "idle"); // the other instance's lead, whose id this home recorded before a herdr restart
    d.store.setRole("lead", herdrRef("w9:p1"));
    w.workspaces.push({ workspace_id: "w9", label: "bari" });
    expect(await upCheck(d, "seori", () => false)).toBeUndefined();
    w.workspaces.push({ workspace_id: "w3", label: "seori" });
    await expect(upCheck(d, "seori", () => false)).rejects.toThrow(Refusal);
    await expect(upCheck(d, "seori", () => false)).rejects.toThrow(/labelled "seori" \(w3\).*config\.json/);
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
