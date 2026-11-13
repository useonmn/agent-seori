import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";
import { dutyTick, ready, report, review, startLane } from "../src/harness.ts";
import { hooksSettled, loadHooks, runHook, substitute } from "../src/hooks.ts";
import { superviseTick } from "../src/supervision.ts";
import { World, herdrRef } from "./fake.ts";

const head = "c".repeat(40);

function setup(hooks?: unknown) {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", herdrRef("w1:p1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix it.");
  if (hooks !== undefined) writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ hooks }));
  w.gh = (argv) => (argv[0] === "pr" && argv[1] === "view" ? { code: 0, stdout: JSON.stringify({ headRefOid: head }) } : { code: 1, stdout: "" });
  return { w, d, lead, brief };
}

const hookCalls = (w: World, cmd: string) => w.calls.filter((c) => c.cmd === cmd);

let stderr: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
function captureStderr(): void {
  stderr = [];
  process.stderr.write = ((s: string | Uint8Array) => (stderr.push(String(s)), true)) as typeof process.stderr.write;
}
afterEach(() => {
  process.stderr.write = realWrite;
  delete process.env["SEORI_PROMPTS_DIR"];
});

describe("config", () => {
  test("no file or no hooks key is no hooks; loadConfig accepts a hooks key", () => {
    const d = new World().deps();
    expect(loadHooks(d.store.root)).toEqual({});
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ name: "x" }));
    expect(loadHooks(d.store.root)).toEqual({});
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ hooks: { onReady: ["notify", "{key}"] } }));
    expect(loadHooks(d.store.root)).toEqual({ onReady: ["notify", "{key}"] });
    expect(loadConfig(d.store.root).name).toBe("seori");
  });

  test.each([
    [{ onReady: "notify" }, "hooks.onReady must be a non-empty array"],
    [{ onReady: [] }, "hooks.onReady must be a non-empty array"],
    [{ onLost: ["a", 1] }, "must contain only strings"],
    [{ onDone: ["a"] }, 'unknown hook "onDone"'],
    [["a"], "hooks must be an object"],
  ])("a malformed hooks value %#  is a ConfigError", (hooks, message) => {
    const d = new World().deps();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ hooks }));
    expect(() => loadHooks(d.store.root)).toThrow(ConfigError);
    expect(() => loadHooks(d.store.root)).toThrow(message);
  });

  test("substitute fills known placeholders per element and leaves others untouched", () => {
    expect(substitute(["x", "{key}:{evidence}", "{sha}", "{text}"], { key: "k", evidence: "e" })).toEqual(["x", "k:e", "{sha}", "{text}"]);
  });
});

describe("lifecycle hooks", () => {
  test("report, ready and a lost pane each run their hook with the lane's values; the command's result is unchanged", async () => {
    const { w, d, lead, brief } = setup({
      onReport: ["h-report", "{key}", "{text}"],
      onReady: ["h-ready", "{key}", "{text}", "{evidence}"],
      onLost: ["h-lost", "{key}", "{text}"],
    });
    const lane = await startLane(d, "busy", brief, { workspace: "w1" });
    await report(d, "busy", "halfway");
    await ready(d, "busy", "all done", ["pr#1", "file"]);
    await hooksSettled(1000);
    expect(hookCalls(w, "h-report")).toEqual([{ cmd: "h-report", argv: ["busy", "halfway"] }]);
    expect(hookCalls(w, "h-ready")).toEqual([{ cmd: "h-ready", argv: ["busy", "all done", "pr#1 file"] }]);
    expect(lead.received.join("\n")).toContain("[READY busy]");

    const second = await startLane(d, "gone", brief, { workspace: "w1" });
    w.panes.delete(second.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "gone", action: "lost" });
    await hooksSettled(1000);
    expect(hookCalls(w, "h-lost")).toEqual([{ cmd: "h-lost", argv: ["gone", "pane disappeared without READY"] }]);
    expect(lane.key).toBe("busy");
  });

  test("a lane paused when its pane vanishes runs onLost too", async () => {
    const { w, d, brief } = setup({ onLost: ["h-lost", "{key}", "{text}"] });
    const lane = await startLane(d, "pz", brief, { workspace: "w1" });
    const rec = d.store.lane("pz")!;
    rec.status = "paused";
    rec.pausedFrom = "working";
    d.store.saveLane(rec);
    w.panes.delete(lane.paneId);
    await superviseTick(d);
    await hooksSettled(1000);
    expect(hookCalls(w, "h-lost")).toEqual([{ cmd: "h-lost", argv: ["pz", "pane disappeared while paused"] }]);
  });

  test("a failing hook writes one stderr line and never changes the result", async () => {
    const { w, d, brief } = setup({ onReport: ["h-report", "{key}"] });
    w.reviewer = () => ({ code: 7, stdout: "", stderr: "boom\nmore" });
    await startLane(d, "busy", brief, { workspace: "w1" });
    captureStderr();
    await report(d, "busy", "x");
    await hooksSettled(1000);
    expect(stderr).toEqual(["seori: hook onReport failed (boom)\n"]);
    expect(d.store.lane("busy")!.log.at(-1)!.kind).toBe("report");
  });

  test("a malformed hooks config in a lifecycle hook is one stderr line, not a thrown error", async () => {
    const { d, brief } = setup({ onReport: "nope" });
    await startLane(d, "busy", brief, { workspace: "w1" });
    captureStderr();
    await report(d, "busy", "x");
    await hooksSettled(1000);
    expect(stderr.join("")).toContain("seori: hook onReport failed (config.json: hooks.onReport must be a non-empty array");
  });

  test("a hook that never finishes does not keep hooksSettled from returning; it is named as timed out", async () => {
    const { w, d } = setup({ onReady: ["slow-hook"] });
    const exec = w.exec;
    const hanging: typeof exec = (cmd, argv) => (cmd === "slow-hook" ? new Promise(() => {}) : exec(cmd, argv));
    captureStderr();
    void runHook({ ...d, exec: hanging }, "onReady", {});
    await hooksSettled(50);
    expect(stderr).toEqual(["seori: hook onReady failed (timed out after 50 ms)\n"]);
  });
});

describe("the reviewer is always omp", () => {
  test("a hooks.reviewCommand key is refused before gh runs, and no other command is executed", async () => {
    const { w, d } = setup({ reviewCommand: ["claude", "-p", "{text}"] });
    expect(() => loadHooks(d.store.root)).toThrow(ConfigError);
    expect(() => loadHooks(d.store.root)).toThrow("config.json: hooks.reviewCommand is not supported: the reviewer is always omp");
    await expect(review(d, "o/r#7")).rejects.toThrow("hooks.reviewCommand is not supported");
    expect(w.calls.map((c) => c.cmd).filter((cmd) => cmd !== "herdr")).toEqual([]);
  });

  test("with lifecycle hooks configured, seori review runs omp with the reviewer argv", async () => {
    const { w, d } = setup({ onReady: ["notify", "{key}"] });
    expect(await review(d, "o/r#7")).toEqual({ verdict: "CLEAR", sha: head });
    const omp = hookCalls(w, "omp");
    expect(omp).toHaveLength(1);
    expect(omp[0]!.argv.slice(0, 4)).toEqual(["-p", "--no-session", "--mode", "json"]);
    expect(hookCalls(w, "notify")).toEqual([]);
  });
});

describe("SEORI_PROMPTS_DIR", () => {
  test("swaps the prompts directory for the reviewer prompt; unset uses the repo's prompts", async () => {
    const { w, d } = setup();
    const dir = mkdtempSync(join(tmpdir(), "seori-prompts-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review.md"), "CUSTOM {{pr}} @ {{sha}}");
    process.env["SEORI_PROMPTS_DIR"] = dir;
    await review(d, "o/r#7");
    expect(hookCalls(w, "omp")[0]!.argv.at(-1)).toBe("CUSTOM o/r#7 @ " + head);
    delete process.env["SEORI_PROMPTS_DIR"];
    await review(d, "o/r#7");
    expect(hookCalls(w, "omp")[1]!.argv.at(-1)).toContain("You are a code reviewer");
  });
});
