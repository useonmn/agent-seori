import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DAEMON_SLOW_MS, DAEMON_START_MS, heartbeatSince } from "../src/cli.ts";
import { heartbeatPath } from "../src/daemon.ts";
import { down, recordPath, running, stopPath } from "../src/down.ts";

const home = () => mkdtempSync(join(tmpdir(), "seori-down-"));
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function until(what: string, cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

describe("seori down", () => {
  test("ends a running duty loop between ticks: exit 0, its record gone", async () => {
    const root = home();
    const duty = Bun.spawn([process.execPath, CLI, "duty", "--interval", "3600"], {
      env: { ...process.env, SEORI_HOME: root, PATH: dirname(process.execPath) }, stdout: "pipe", stderr: "ignore",
    });
    try {
      await until("the duty record", () => existsSync(recordPath(root, "duty")), 15_000);
      const r = await down(root, ["duty"]);
      expect(r).toEqual({ ok: true, lines: [`STOPPED duty pid=${duty.pid}`] });
      expect(await duty.exited).toBe(0);
      expect(await new Response(duty.stdout).text()).toContain("DUTY ended by seori down");
      expect(existsSync(recordPath(root, "duty"))).toBe(false);
      expect(existsSync(stopPath(root, "duty"))).toBe(false);
    } finally {
      duty.kill("SIGKILL");
    }
  }, 30_000);

  test("nothing running, or a record whose pid has exited: NOT RUNNING, the stale record removed", async () => {
    const root = home();
    mkdirSync(join(root, "run"), { recursive: true });
    writeFileSync(recordPath(root, "loop"), JSON.stringify({ pid: 424242, startedAt: 1 }));
    const r = await down(root, ["duty", "loop"], { alive: () => false });
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(["NOT RUNNING duty", "NOT RUNNING loop (removed the record of pid 424242, which has exited)"]);
    expect(existsSync(recordPath(root, "loop"))).toBe(false);
    expect(existsSync(stopPath(root, "loop"))).toBe(false);
  });

  test("a process that does not end in time: STILL RUNNING after the wait (fake clock), request kept", async () => {
    const root = home();
    mkdirSync(join(root, "run"), { recursive: true });
    writeFileSync(recordPath(root, "daemon"), JSON.stringify({ pid: 4242, startedAt: 1 }));
    let clock = 0;
    const r = await down(root, ["daemon"], { alive: () => true, now: () => clock, sleep: async (ms) => void (clock += ms), waitMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toStartWith("STILL RUNNING daemon pid=4242 after 30 s");
    expect(clock).toBe(30_000);
    expect(existsSync(stopPath(root, "daemon"))).toBe(true);
  });

  test("a stop request left for an earlier pid never stops a process started later", async () => {
    const root = home();
    mkdirSync(join(root, "run"), { recursive: true });
    writeFileSync(stopPath(root, "loop"), JSON.stringify({ pid: 1111, at: 1 }));
    // The stop-request poll, driven by hand: `check` is one poll, `stopped` records that release() cancelled it.
    const poll = { check: undefined as (() => void) | undefined, stopped: false };
    const every = (check: () => void) => {
      poll.check = check;
      return () => void (poll.stopped = true);
    };
    const me = running(root, "loop", 2222, () => 5, 10, every);
    try {
      expect(existsSync(stopPath(root, "loop"))).toBe(false);
      writeFileSync(stopPath(root, "loop"), JSON.stringify({ pid: 1111, at: 2 }));
      poll.check!();
      expect(me.stopped.aborted).toBe(false);
      writeFileSync(stopPath(root, "loop"), JSON.stringify({ pid: 2222, at: 3 }));
      poll.check!();
      expect(me.stopped.aborted).toBe(true);
    } finally {
      me.release();
    }
    expect(poll.stopped).toBe(true);
    expect(existsSync(recordPath(root, "loop"))).toBe(false);
    expect(existsSync(stopPath(root, "loop"))).toBe(false);
  });
});

describe("seori up waits for the daemon's first heartbeat", () => {
  const fakeClock = () => {
    const c = { t: 1_000, sleeps: 0 };
    return { c, now: () => c.t, sleep: async (ms: number) => void ((c.t += ms), c.sleeps++) };
  };

  test("a first heartbeat after 20 s (slower than the old 15 s limit) still counts; the slow start is told once", async () => {
    const root = home();
    const { c, now, sleep } = fakeClock();
    let slow = 0;
    const since = c.t;
    const done = heartbeatSince(root, since, {
      now, onSlow: () => slow++,
      sleep: async (ms) => {
        await sleep(ms);
        if (c.t - since >= 20_000 && !existsSync(heartbeatPath(root))) {
          mkdirSync(join(root, "messenger"), { recursive: true });
          writeFileSync(heartbeatPath(root), JSON.stringify({ at: c.t, pid: 1 }));
        }
      },
    });
    expect(await done).toBe(true);
    expect(c.t - since).toBe(20_000);
    expect(slow).toBe(1);
  });

  test("no heartbeat, or only one older than the start: false once DAEMON_START_MS has passed by the clock", async () => {
    const root = home();
    mkdirSync(join(root, "messenger"), { recursive: true });
    writeFileSync(heartbeatPath(root), JSON.stringify({ at: 10, pid: 1 }));
    const { c, now, sleep } = fakeClock();
    let slow = 0;
    expect(await heartbeatSince(root, c.t, { now, sleep, onSlow: () => slow++ })).toBe(false);
    expect(c.t - 1_000).toBe(DAEMON_START_MS);
    expect(slow).toBe(1);
    expect(DAEMON_START_MS).toBeGreaterThan(DAEMON_SLOW_MS);
  });

  test("a heartbeat already there from this start returns at once, without sleeping or telling", async () => {
    const root = home();
    mkdirSync(join(root, "messenger"), { recursive: true });
    writeFileSync(heartbeatPath(root), JSON.stringify({ at: 1_000, pid: 1 }));
    const { c, now, sleep } = fakeClock();
    let slow = 0;
    expect(await heartbeatSince(root, 1_000, { now, sleep, onSlow: () => slow++ })).toBe(true);
    expect(c.sleeps).toBe(0);
    expect(slow).toBe(0);
  });
});
