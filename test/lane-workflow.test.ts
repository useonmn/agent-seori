import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { type Deps, Refusal } from "../src/harness.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import type { Workflow } from "../src/workflow.ts";
import { World } from "./fake.ts";

// A lane's workflow: `seori start --workflow <W>` (or config.json "workflow") puts the workflow and its keyword between
// /goal and the brief in the kickoff, so a host with the omp-ulw extension runs that workflow under omp's native goal.

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
  const KICKOFFS: [Workflow, string][] = [
    ["ulw", "/goal ulw "],
    ["mass-ulw", "/goal mass-ulw workflowz "],
    ["ulw-research", "/goal ulw-research workflowz "],
    ["ulw-plan", "/goal ulw-plan ultrathink "],
    ["ulw-loop", "/goal ulw-loop orchestrate "],
    ["ulw-execute", "/goal ulw-execute orchestrate "],
  ];
  for (const [workflow, prefix] of KICKOFFS) {
    test(`${workflow}: the kickoff is "${prefix}<brief prompt>", STARTUP_OK, the lane keeps it, and its native goal pauses and resumes`, async () => {
      const { w, d, brief, id } = setup();
      w.ompPlugins = ULW_PLUGIN;
      const r = await start(d, brief, "--workflow", workflow);
      expect(r.code).toBe(0);
      expect(r.out[1]).toBe(`STARTUP_OK fix-login ${id}`);
      expect(w.panes.get(id)!.received[0]).toBe(
        `${prefix}Read your brief at ${d.store.briefPath("fix-login")} and execute it. Your lane key is fix-login. ` +
          `The work is finished only when the brief's exit condition holds and you have sent seori ready.`,
      );
      expect(d.store.lane("fix-login")!.workflow).toBe(workflow);
      expect(w.calls.filter((c) => c.cmd === "omp").map((c) => c.argv)).toEqual([["plugin", "list", "--json"]]);
      const pane = w.panes.get(id)!;
      pane.status = "idle";
      pane.screen = ["working on it"];
      pane.onPrompt = (text) => {
        if (text === "/goal pause") pane.screen!.push(" Goal mode paused.");
        if (text === "/goal resume") pane.screen!.push(" Goal mode resumed.");
      };
      const noSleep = { sleep: async () => {} };
      expect((await pauseLane(d, "fix-login", undefined, noSleep)).lines).toEqual(["PAUSED fix-login goal paused"]);
      expect((await resumeLane(d, "fix-login", undefined, noSleep)).lines[0]).toStartWith("RESUMED fix-login");
    });
  }

  test("ulw-plan gets a default token and wall-clock ceiling unless the start or config.json sets them", async () => {
    const { w, d, brief } = setup();
    w.ompPlugins = ULW_PLUGIN;
    await start(d, brief, "--workflow", "ulw-plan");
    expect(d.store.lane("fix-login")!.ceilings).toEqual({ wallMinutes: 60, tokens: 300_000, costUsd: null });
    const out: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void out.push(args.join(" "));
    try {
      await main(["start", "fix-hard", "--brief", brief, "--workspace", "w1", "--force", "--workflow", "ulw-plan", "--token-limit", "500000"], d);
      await main(["start", "fix-ulw", "--brief", brief, "--workspace", "w1", "--force", "--workflow", "ulw"], d);
    } finally {
      console.log = log;
    }
    expect(d.store.lane("fix-hard")!.ceilings).toEqual({ wallMinutes: null, tokens: 500_000, costUsd: null });
    expect(d.store.lane("fix-ulw")!.ceilings).toBeUndefined();
  });

  test("config.json supervision.ulwPlan changes or switches off the ulw-plan defaults; supervision.defaults win", async () => {
    const off = setup({ supervision: { ulwPlan: { tokens: null, wallMinutes: null } } });
    off.w.ompPlugins = ULW_PLUGIN;
    await start(off.d, off.brief, "--workflow", "ulw-plan");
    expect(off.d.store.lane("fix-login")!.ceilings).toBeUndefined();
    const set = setup({ supervision: { defaults: { tokens: 100_000 }, ulwPlan: { wallMinutes: 30 } } });
    set.w.ompPlugins = ULW_PLUGIN;
    await start(set.d, set.brief, "--workflow", "ulw-plan");
    expect(set.d.store.lane("fix-login")!.ceilings).toEqual({ wallMinutes: 30, tokens: 100_000, costUsd: null });
    expect(() => loadConfig(setup({ supervision: { ulwPlan: { tokens: -1 } } }).d.store.root)).toThrow(/supervision.ulwPlan.tokens/);
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
    await expect(start(d, brief, "--workflow", "ulw-bogus")).rejects.toThrow(
      /--workflow must be ulw, mass-ulw, ulw-research, ulw-plan, ulw-loop, ulw-execute or none, got "ulw-bogus"/,
    );
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ workflow: "ulw research" }));
    expect(() => loadConfig(d.store.root)).toThrow(ConfigError);
    expect(() => loadConfig(d.store.root)).toThrow(/workflow must be one of "ulw", "mass-ulw", "ulw-research", "ulw-plan", "ulw-loop", "ulw-execute"/);
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
