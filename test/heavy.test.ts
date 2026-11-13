import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type SeoriConfig } from "../src/config.ts";
import { acquireHeavySlot, heavyDir, runHeavy, takeSlot } from "../src/heavy.ts";

const config = (slots: number, maxLoadPct = 80): SeoriConfig => ({ ...DEFAULT_CONFIG, heavy: { slots, maxLoadPct } });
const home = (): string => mkdtempSync(join(tmpdir(), "seori-heavy-"));
const lock = (root: string, n: number, pid: number): void => {
  mkdirSync(heavyDir(root), { recursive: true });
  writeFileSync(join(heavyDir(root), `${n}.lock`), JSON.stringify({ pid, host: hostname(), at: Date.now() }));
};
/** A pid that has exited: a finished child's. */
const deadPid = (): number => {
  const p = Bun.spawnSync([process.execPath, "-e", ""]);
  return p.pid;
};

describe("slots", () => {
  test("takes the first free slot and frees it", () => {
    const root = home();
    const a = takeSlot(root, 2, Date.now())!;
    const b = takeSlot(root, 2, Date.now())!;
    expect([a.n, b.n]).toEqual([1, 2]);
    expect(takeSlot(root, 2, Date.now())).toBeUndefined();
    a.release();
    expect(existsSync(join(heavyDir(root), "1.lock"))).toBe(false);
    expect(takeSlot(root, 2, Date.now())?.n).toBe(1);
  });

  test("a slot held by a dead pid is taken over", () => {
    const root = home();
    lock(root, 1, deadPid());
    const s = takeSlot(root, 1, Date.now());
    expect(s?.n).toBe(1);
    expect(JSON.parse(readFileSync(join(heavyDir(root), "1.lock"), "utf8")).pid).toBe(process.pid);
  });

  test("waits while load is high, then while every slot is busy, telling each reason once", async () => {
    const root = home();
    lock(root, 1, process.pid); // a live holder
    const loads = [95, 95, 10, 10, 10];
    const lines: string[] = [];
    let sleeps = 0;
    const slot = await acquireHeavySlot(root, "build", {
      config: config(1),
      load: () => loads.shift() ?? 10,
      onWait: (l) => lines.push(l),
      sleep: async (ms) => {
        expect(ms).toBe(5);
        sleeps++;
        if (sleeps === 4) writeFileSync(join(heavyDir(root), "1.lock"), JSON.stringify({ pid: deadPid(), host: hostname(), at: Date.now() }));
      },
      pollMs: 5,
    });
    expect(slot.n).toBe(1);
    expect(sleeps).toBe(4);
    expect(lines).toEqual(["HEAVY build waiting: load 95% per core, not under 80%", "HEAVY build waiting: all 1 heavy slot(s) busy"]);
    slot.release();
  });
});

describe("runHeavy", () => {
  test("runs the command, returns its exit code and frees the slot", async () => {
    const root = home();
    expect(await runHeavy(root, "t", [process.execPath, "-e", "process.exit(3)"], { config: config(1), load: () => 0 })).toBe(3);
    expect(existsSync(join(heavyDir(root), "1.lock"))).toBe(false);
    expect(await runHeavy(root, "t", [process.execPath, "-e", ""], { config: config(1), load: () => 0 })).toBe(0);
  });

  test("a command killed by a signal reports 128 + the signal number", async () => {
    expect(await runHeavy(home(), "t", [process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'], { config: config(1), load: () => 0 })).toBe(143);
  });

  test("an unknown load holds nothing: only the slots limit heavy commands", async () => {
    const root = home();
    const lines: string[] = [];
    const slot = await acquireHeavySlot(root, "build", { config: config(1), load: () => undefined, onWait: (l) => lines.push(l), sleep: async () => {} });
    expect(slot.n).toBe(1);
    expect(lines).toEqual([]);
    slot.release();
  });

  test("a command that cannot start is an error and frees the slot", async () => {
    const root = home();
    await expect(runHeavy(root, "t", ["/nonexistent/seori-cmd"], { config: config(1), load: () => 0 })).rejects.toThrow("cannot run /nonexistent/seori-cmd");
    expect(existsSync(join(heavyDir(root), "1.lock"))).toBe(false);
  });

  test("no command is an error", async () => {
    await expect(runHeavy(home(), "t", [], { config: config(1) })).rejects.toThrow("heavy needs a command after --");
  });
});
