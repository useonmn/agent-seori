import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLane } from "../src/done-flow.ts";
import { hooksSettled } from "../src/hooks.ts";
import type { Lane } from "../src/store.ts";
import { World } from "./fake.ts";

const assistant = (totalTokens: number, cost: number) =>
  JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 2, totalTokens, cost: { total: cost } } } });

/** A herdr lane `fix-a` in w1:p5 whose omp session file holds `lines` (none: no session path reported). */
function setup(lines?: string[], hooks?: unknown) {
  const w = new World();
  const d = w.deps();
  const pane = w.addPane("w1:p5", "idle");
  pane.agent = "omp";
  if (lines) {
    const path = join(d.store.root, "session.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    pane.session = path;
  }
  if (hooks !== undefined) writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ hooks }));
  const lane: Lane = {
    key: "fix-a", sessionRef: { runtime: "herdr", id: "w1:p5", container: "w1:t5" }, paneId: "w1:p5", tabId: "w1:t5", brief: "/dev/null",
    cwd: "/repo", status: "ready", createdAt: 7, lastActivityAt: 7, nudges: 0, log: [],
  };
  d.store.saveLane(lane);
  const ledger = (): unknown[] => {
    const path = join(d.store.root, "cost.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const hookCalls = () => w.calls.filter((c) => c.cmd === "record-cost").map((c) => c.argv);
  return { w, d, lane, ledger, hookCalls };
}

describe("cost recorded when a lane closes", () => {
  test("the lane's tokens and cost go to cost.jsonl once, read before its session closes", async () => {
    const { w, d, lane, ledger } = setup([assistant(100, 0.25), assistant(50, 0.5)]);
    w.clock = 9_000;
    await closeLane(d, lane, "closed by lead");
    expect(w.panes.has("w1:p5")).toBe(false);
    expect(ledger()).toEqual([{ key: "fix-a", closeKey: "fix-a@7", tokens: 150, costUsd: 0.75, at: 9_000 }]);
    // A retried close of the same lane records nothing more.
    await closeLane(d, d.store.lane("fix-a")!, "closed by lead");
    expect(ledger()).toHaveLength(1);
  });

  test("usage that cannot be read is recorded as null, never 0, and runs no hook", async () => {
    const { d, lane, ledger, hookCalls } = setup(undefined, { recordCost: ["record-cost", "{key}"] });
    await closeLane(d, lane, "closed by lead");
    await hooksSettled(1000);
    expect(ledger()).toEqual([{ key: "fix-a", closeKey: "fix-a@7", tokens: null, costUsd: null, at: 1_000_000 }]);
    expect(hookCalls()).toEqual([]);
  });

  test("hooks.recordCost, when configured, runs once with the reading; none is configured by default", async () => {
    const off = setup([assistant(10, 0.1)]);
    await closeLane(off.d, off.lane, "closed by lead");
    await hooksSettled(1000);
    expect(off.hookCalls()).toEqual([]);
    const on = setup([assistant(10, 0.125)], { recordCost: ["record-cost", "{key}", "{tokens}", "{cost}", "{closeKey}"] });
    await closeLane(on.d, on.lane, "closed by lead");
    await closeLane(on.d, on.d.store.lane("fix-a")!, "closed by lead");
    await hooksSettled(1000);
    expect(on.hookCalls()).toEqual([["fix-a", "10", "0.125", "fix-a@7"]]);
  });
});
