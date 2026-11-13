import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPath, running } from "../src/down.ts";
import { Refusal } from "../src/harness.ts";

const home = () => mkdtempSync(join(tmpdir(), "seori-duty-single-"));
const noTick = (): (() => void) => () => {};
const start = (root: string, pid: number) => running(root, "duty", pid, () => 5, 10, noTick);
const recorded = (root: string): number => (JSON.parse(readFileSync(recordPath(root, "duty"), "utf8")) as { pid: number }).pid;
/** A pid that has exited: spawnSync returns after the child is reaped. */
const deadPid = (): number => Bun.spawnSync(["true"]).pid;

describe("one duty loop per home", () => {
  test("a second duty loop refuses while the first is alive, naming its pid", () => {
    const root = home();
    // process.pid stands in for the live first loop; 2222 is the second one.
    const first = start(root, process.pid);
    expect(() => start(root, 2222)).toThrow(Refusal);
    expect(() => start(root, 2222)).toThrow(String(process.pid));
    expect(recorded(root)).toBe(process.pid);
    first.release();
  });

  test("a record of a dead pid is replaced", () => {
    const root = home();
    const dead = deadPid();
    start(root, dead);
    const second = start(root, 2222);
    expect(recorded(root)).toBe(2222);
    second.release();
  });

  test("a record written before this boot is replaced even when its pid is alive", () => {
    const root = home();
    // running() creates the run dir; a throwaway start makes it.
    const probe = start(root, process.pid);
    probe.release();
    writeFileSync(recordPath(root, "duty"), JSON.stringify({ pid: process.pid, startedAt: 1 }));
    utimesSync(recordPath(root, "duty"), 1, 1);
    const second = start(root, 2222);
    expect(recorded(root)).toBe(2222);
    second.release();
  });

  test("restarting under the same pid is not a refusal", () => {
    const root = home();
    start(root, process.pid);
    const again = start(root, process.pid);
    expect(recorded(root)).toBe(process.pid);
    again.release();
  });
});
