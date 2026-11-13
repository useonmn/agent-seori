import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { type Deps, Refusal } from "../src/harness.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { World } from "./fake.ts";

// A lane's workflow: `seori start --workflow ulw` (or config.json "workflow") puts the word between /goal and the brief
// in the kickoff, so a host with the omp-ulw extension runs the lane as ULW while omp's native goal stays the same.

const ULW_PLUGIN = { npm: [{ name: "omp-ulw", version: "0.1.0", enabled: true }], marketplace: [] };

function setup(config?: Record<string, unknown>) {
  const w = new World();
  const d = w.deps();
  w.addPane("w1:p1", "idle");
  d.store.setRole("lead", { runtime: "herdr", id: "w1:p1" });
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  if (config) writeFileSync(join(d.store.root, "config.json"), JSON.stringify(config));
  const id = `w1:p${w.next + 1}`;
  return { w, d, brief, id };
}

async function start(d: Deps, brief: string, ...extra: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  try {
    const code = await main(["start", "fix-login", "--brief", brief, "--workspace", "w1", "--force", ...extra], d);
    return { code, out };
  } finally {
    console.log = log;
  }
}

describe("seori start --workflow", () => {
  test("ulw: the kickoff is /goal ulw <brief prompt>, the startup verdict is STARTUP_OK and the lane keeps its workflow", async () => {
    const { w, d, brief, id } = setup();
    w.ompPlugins = ULW_PLUGIN;
    const r = await start(d, brief, "--workflow", "ulw");
    expect(r.code).toBe(0);
    expect(r.out[1]).toBe(`STARTUP_OK fix-login ${id}`);
    expect(w.panes.get(id)!.received[0]).toStartWith(`/goal ulw Read your brief at ${d.store.briefPath("fix-login")} and execute it.`);
    expect(d.store.lane("fix-login")!.workflow).toBe("ulw");
    expect(w.calls.filter((c) => c.cmd === "omp").map((c) => c.argv)).toEqual([["plugin", "list", "--json"]]);
  });

  test("unset: the kickoff is stock omp goal mode, exactly as before, and omp's plugins are not asked", async () => {
    const { w, d, brief, id } = setup();
    const r = await start(d, brief);
    expect(r.out[1]).toBe(`STARTUP_OK fix-login ${id}`);
    expect(w.panes.get(id)!.received[0]).toBe(
      `/goal Read your brief at ${d.store.briefPath("fix-login")} and execute it. Your lane key is fix-login. ` +
        `The work is finished only when the brief's exit condition holds and you have sent seori ready.`,
    );
    expect("workflow" in d.store.lane("fix-login")!).toBe(false);
    expect(w.calls.filter((c) => c.cmd === "omp")).toEqual([]);
  });

  test("config.json workflow is the default; --workflow none starts one lane in stock goal mode", async () => {
    const { w, d, brief, id } = setup({ workflow: "ulw" });
    w.ompPlugins = ULW_PLUGIN;
    expect(loadConfig(d.store.root).workflow).toBe("ulw");
    await start(d, brief);
    expect(w.panes.get(id)!.received[0]).toStartWith("/goal ulw Read your brief at ");
    const other = `w1:p${w.next + 1}`;
    const out: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void out.push(args.join(" "));
    try {
      await main(["start", "fix-other", "--brief", brief, "--workspace", "w1", "--force", "--workflow", "none"], d);
    } finally {
      console.log = log;
    }
    expect(w.panes.get(other)!.received[0]).toStartWith("/goal Read your brief at ");
    expect("workflow" in d.store.lane("fix-other")!).toBe(false);
  });

  test("an unknown workflow is refused, on the command line and in config.json, naming the allowed ones", async () => {
    const { w, d, brief } = setup();
    w.ompPlugins = ULW_PLUGIN;
    await expect(start(d, brief, "--workflow", "mass-ulw")).rejects.toThrow(/--workflow must be ulw or none, got "mass-ulw"/);
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ workflow: "ulw research" }));
    expect(() => loadConfig(d.store.root)).toThrow(ConfigError);
    expect(() => loadConfig(d.store.root)).toThrow(/workflow must be "ulw"/);
    expect(w.panes.size).toBe(1);
  });

  test("without omp-ulw enabled the start is refused before any pane opens, saying how to fix it", async () => {
    const { w, d, brief } = setup();
    w.ompPlugins = { npm: [{ name: "omp-ulw", version: "0.1.0", enabled: false }], marketplace: [] };
    await expect(start(d, brief, "--workflow", "ulw")).rejects.toThrow(/omp-ulw extension is not enabled.*github\.com\/dbc-hbin\/omp-ulw/);
    w.ompPlugins = { npm: [], marketplace: [] };
    await expect(start(d, brief, "--workflow", "ulw")).rejects.toThrow(Refusal);
    w.ompPlugins = undefined;
    await expect(start(d, brief, "--workflow", "ulw")).rejects.toThrow(/could not list omp's plugins/);
    expect(w.panes.size).toBe(1);
    expect(d.store.lane("fix-login")).toBeUndefined();
  });

  test("pause and resume work on a ulw lane: the native goal is paused and resumed as on any lane", async () => {
    const { w, d, brief, id } = setup();
    w.ompPlugins = ULW_PLUGIN;
    await start(d, brief, "--workflow", "ulw");
    const pane = w.panes.get(id)!;
    pane.status = "idle";
    pane.screen = ["working on it"];
    pane.onPrompt = (text) => {
      if (text === "/goal pause") pane.screen!.push(" Goal mode paused.");
      if (text === "/goal resume") pane.screen!.push(" Goal mode resumed.");
    };
    const noSleep = { sleep: async () => {} };
    expect((await pauseLane(d, "fix-login", "owner said wait", noSleep)).lines).toEqual(["PAUSED fix-login goal paused"]);
    expect(d.store.lane("fix-login")!.status).toBe("paused");
    expect((await resumeLane(d, "fix-login", undefined, noSleep)).lines[0]).toStartWith("RESUMED fix-login");
    expect(d.store.lane("fix-login")!.status).toBe("working");
    expect(pane.received.slice(1)).toEqual(["/goal pause", "/goal resume"]);
  });
});
