import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { daemonLoop } from "../src/cli.ts";
import { down, DOWN_GROUPS, recordPath } from "../src/down.ts";
import { type DaemonEvent, daemonLine, daemonLockPath, heartbeatPath, MAX_RESTART_DELAY_MS, readHealth, restartDelay, runDaemon } from "../src/daemon.ts";
import type { InboundMessage, MessengerAdapter, MessengerConfig } from "../src/messenger/adapter.ts";
import { FakeAdapter } from "../src/messenger/fake.ts";
import { noActions } from "./fake.ts";
import { adapterFor } from "../src/messenger/index.ts";
import { type Watch, WatchStore } from "../src/watch/store.ts";

function home(messengers: MessengerConfig[] = []) {
  const root = mkdtempSync(join(tmpdir(), "seori-daemon-"));
  writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers }));
  return root;
}

/** Polls a condition the daemon reaches asynchronously; fails with `what` rather than hanging. */
async function until(what: string, cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function start(root: string, opts: Parameters<typeof runDaemon>[1] = {}) {
  const ac = new AbortController();
  const events: DaemonEvent[] = [];
  const done = runDaemon(root, { restartDelayMs: 5, heartbeatMs: 10, onEvent: (e) => events.push(e), ...opts, signal: ac.signal });
  const stop = async () => {
    ac.abort();
    await done;
  };
  return { events, done, stop, lines: () => events.map(daemonLine) };
}

const fakePoll = (config: MessengerConfig, root: string): MessengerAdapter =>
  config.source === "fake" ? new FakeAdapter(root, { pollMs: 5 }) : adapterFor(config, root);
const fakeIn = (root: string, r: Record<string, unknown>) => {
  mkdirSync(join(root, "messenger", "fake"), { recursive: true });
  appendFileSync(join(root, "messenger", "fake", "in.jsonl"), `${JSON.stringify(r)}\n`);
};
/** A watch command that starts with `echo $$ > pid` wrote the pid of its sh, which the engine spawns and reaps. */
const commandPid = (root: string): number => Number(readFileSync(join(root, "pid"), "utf8").trim());
/** True once `pid` no longer exists (killed and reaped): the command can write nothing more. */
const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};
const msg = (id: string, from = "u1"): InboundMessage => ({ id, source: "x", chat: "c", from, at: 1, text: `text ${id}` });

describe("runDaemon", () => {
  test("stores an owner message from the fake messenger and drops other senders", async () => {
    const root = home([{ source: "fake", owner: "u1" }]);
    fakeIn(root, { msgId: "1", chat: "c", thread: "t", from: "stranger", text: "let me in", at: 3 });
    fakeIn(root, { msgId: "2", chat: "c", thread: "t", from: "u1", text: "hello lead", at: 4 });
    const d = start(root, { adapterFor: fakePoll });
    await until("stored", () => d.events.some((e) => e.ev === "stored"));
    await d.stop();
    expect(new Channel(root).inbound()).toEqual([{ id: "fake:c:2", kind: "messenger", source: "fake", chat: "c", thread: "t", from: "u1", at: 4, text: "hello lead" }]);
    expect(d.lines()).toEqual(["DAEMON dropped fake:c:1 from stranger", "DAEMON stored fake:c:2"]);
    expect(new FakeAdapter(root).offset()).toBe(2);
  });

  test("a message replayed after a crash between append and offset commit is stored once", async () => {
    const root = home([{ source: "x", owner: "u1" }]);
    let attempts = 0;
    // First run: stores the message, then dies before committing. The restart replays the same upstream message.
    const replaying: MessengerAdapter = {
      ...noActions,
      source: "x",
      async receive(signal, onMessage) {
        attempts++;
        await onMessage(msg("x:c:1"));
        if (attempts === 1) throw new Error("crashed before offset commit");
        await onMessage(msg("x:c:2"));
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
      },
      send: async () => ({ messageId: "1" }),
      check: async () => "stub",
    };
    const d = start(root, { adapterFor: () => replaying });
    await until("second message", () => d.events.some((e) => e.ev === "stored" && e.id === "x:c:2"));
    await d.stop();
    expect(new Channel(root).inbound().map((r) => r.id)).toEqual(["x:c:1", "x:c:2"]);
    expect(d.lines()).toEqual([
      "DAEMON stored x:c:1",
      "DAEMON x error: crashed before offset commit; restarting in 5 ms",
      "DAEMON duplicate x:c:1",
      "DAEMON stored x:c:2",
    ]);
  });

  test("a crashing messenger is restarted and does not stop the others", async () => {
    const root = home([{ source: "nosuch", owner: "u1" }, { source: "flaky", owner: "u1" }, { source: "fake", owner: "u1" }]);
    let flakyRuns = 0;
    const flaky: MessengerAdapter = {
      ...noActions,
      source: "flaky",
      async receive(signal, onMessage) {
        if (++flakyRuns < 3) throw new Error(`boom ${flakyRuns}`);
        await onMessage(msg("flaky:c:1"));
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
      },
      send: async () => ({ messageId: "1" }),
      check: async () => "stub",
    };
    fakeIn(root, { msgId: "1", chat: "c", from: "u1", text: "still here" });
    const d = start(root, { adapterFor: (c, r) => (c.source === "flaky" ? flaky : fakePoll(c, r)) });
    await until("both stored", () => ["flaky:c:1", "fake:c:1"].every((id) => d.events.some((e) => e.ev === "stored" && e.id === id)));
    await d.stop();
    expect(flakyRuns).toBe(3);
    expect(d.lines()).toContain("DAEMON flaky error: boom 1; restarting in 5 ms");
    expect(d.lines()).toContain("DAEMON nosuch error: messenger nosuch is not supported; restarting in 5 ms");
    expect(new Channel(root).inbound().map((r) => r.id).sort()).toEqual(["fake:c:1", "flaky:c:1"]);
    // The third run stored a message, so the failure streak ended; the unsupported one is still failing.
    expect(readHealth(root, "flaky")).toBeUndefined();
    expect(readHealth(root, "nosuch")).toMatchObject({ error: "messenger nosuch is not supported" });
    expect(readHealth(root, "fake")).toBeUndefined();
  });

  test("a messenger that keeps failing is restarted less and less often, up to 10 min apart", () => {
    expect([1, 2, 3, 4].map((n) => restartDelay(5_000, n))).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(restartDelay(5_000, 9)).toBe(MAX_RESTART_DELAY_MS);
    expect(restartDelay(5_000, 10_000)).toBe(MAX_RESTART_DELAY_MS);
  });

  test("a message getting through ends a failure streak, and a changed messengers.json starts a fresh one", async () => {
    const root = home([{ source: "flaky", owner: "u1" }]);
    let runs = 0;
    const flaky: MessengerAdapter = {
      ...noActions,
      source: "flaky",
      async receive(signal, onMessage) {
        if (++runs === 1) throw new Error("boom");
        await onMessage(msg("flaky:c:1"));
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
      },
      send: async () => ({ messageId: "1" }),
      check: async () => "stub",
    };
    const d = start(root, { adapterFor: () => flaky });
    await until("stored", () => d.events.some((e) => e.ev === "stored"));
    await d.stop();
    expect(d.lines()).toContain("DAEMON flaky error: boom; restarting in 5 ms");
    expect(readHealth(root, "flaky")).toBeUndefined();

    // A streak left by a daemon running an older messengers.json is dropped by the next daemon on the new file.
    mkdirSync(join(root, "messenger", "flaky"), { recursive: true });
    writeFileSync(join(root, "messenger", "flaky", "health.json"), JSON.stringify({ failingSince: 1, lastAt: 1, error: "old", failures: 9, config: "older" }));
    const quiet: MessengerAdapter = { ...flaky, receive: (signal) => new Promise<void>((r) => signal.addEventListener("abort", () => r())) };
    const d2 = start(root, { adapterFor: () => quiet });
    await until("old streak dropped", () => readHealth(root, "flaky") === undefined);
    await d2.stop();
  });

  test("a second daemon is refused while the first holds the lock and starts once it is gone", async () => {
    const root = home();
    const first = start(root);
    await until("lock", () => existsSync(daemonLockPath(root)));
    await expect(runDaemon(root, { onEvent: () => {} })).rejects.toThrow(`another seori daemon is running for ${root} (pid ${process.pid})`);
    await first.stop();
    expect(existsSync(daemonLockPath(root))).toBe(false);

    // A lock left by a dead process on this host is taken over.
    const dead = Bun.spawnSync([process.execPath, "-e", ""]).pid;
    writeFileSync(daemonLockPath(root), JSON.stringify({ pid: dead, host: hostname(), at: 1 }));
    const second = start(root);
    await until("lock taken over", () => JSON.parse(readFileSync(daemonLockPath(root), "utf8")).pid === process.pid);
    await second.stop();
    expect(existsSync(daemonLockPath(root))).toBe(false);
  });

  test("rewrites the heartbeat while running and keeps running with no messengers", async () => {
    const root = home();
    let clock = 1_000;
    // The heartbeat timer, driven by hand: `tick` is the beat, `stopped` records that the daemon cancelled it.
    const timer = { tick: undefined as (() => void) | undefined, stopped: false };
    const every = (tick: () => void) => {
      timer.tick = tick;
      return () => void (timer.stopped = true);
    };
    const d = start(root, { now: () => clock, every });
    const beat = () => JSON.parse(readFileSync(heartbeatPath(root), "utf8")) as { at: number; pid: number };
    expect(beat()).toEqual({ at: 1_000, pid: process.pid });
    clock = 2_000;
    timer.tick!();
    expect(beat()).toEqual({ at: 2_000, pid: process.pid });
    expect(d.lines()).toEqual([`DAEMON no messengers configured; add one to ${join(root, "messengers.json")} (heartbeat and watches only)`]);
    expect(timer.stopped).toBe(false);
    await d.stop();
    expect(timer.stopped).toBe(true);
  });

  test("returns stopped when its signal aborts, and config-changed when messengers.json changes", async () => {
    const root = home();
    const d = start(root);
    await until("heartbeat", () => existsSync(heartbeatPath(root)));
    await d.stop();
    expect(await d.done).toBe("stopped");

    // Created after start (the README's natural order): the daemon must exit so the restart loop loads it.
    rmSync(join(root, "messengers.json"));
    const e = start(root);
    await until("heartbeat", () => e.lines().length > 0);
    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: "u1" }] }));
    expect(await e.done).toBe("config-changed");
    expect(e.lines().at(-1)).toBe(`DAEMON ${join(root, "messengers.json")} changed; exiting so it is started again with the new config`);
    expect(existsSync(daemonLockPath(root))).toBe(false);
  });

  test("runs the watch engine while it runs and stops it (and the watch's command) when it stops", async () => {
    const root = home();
    const w = new WatchStore(root).add({
      name: "ticker",
      source: { kind: "command", command: "echo $$ > pid; while :; do echo tick; sleep 0.05; done", cwd: root, filter: "tick" },
      owner: { kind: "lead" },
    }, Date.now());
    const delivered: [Watch, string][] = [];
    const d = start(root, { watch: { tickMs: 20, deliver: async (watch, text) => void delivered.push([watch, text]) } });
    await until("a delivered watch event", () => delivered.length > 0, 5_000);
    expect(delivered[0]![0].id).toBe(w.id);
    expect(delivered[0]![1]).toStartWith(`[watch ticker ${w.id}] `);
    const pid = commandPid(root);
    expect(gone(pid)).toBe(false);
    await d.stop();
    expect(gone(pid)).toBe(true);
    expect(existsSync(daemonLockPath(root))).toBe(false);
  });

  test("an invalid messengers.json is reported and the daemon runs its watches without messengers", async () => {
    const root = home();
    writeFileSync(join(root, "messengers.json"), "{ not json");
    new WatchStore(root).add({ name: "ticker", source: { kind: "command", command: "while :; do echo tick; sleep 0.05; done", cwd: root }, owner: { kind: "lead" } }, Date.now());
    const delivered: string[] = [];
    const d = start(root, { watch: { tickMs: 20, deliver: async (_w, text) => void delivered.push(text) } });
    await until("a delivered watch event", () => delivered.length > 0, 5_000);
    expect(existsSync(heartbeatPath(root))).toBe(true);
    expect(d.events[0]).toMatchObject({ ev: "error", source: "messengers.json" });
    expect(d.lines()[0]).toEndWith("; running without messengers (heartbeat and watches only) until the file changes");
    // Fixing the file restarts the daemon on it, like any config change.
    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [] }));
    expect(await d.done).toBe("config-changed");
  });
});

describe("the daemon restart loop (daemonLoop)", () => {
  const run = async (statuses: number[], stopAfter = Infinity) => {
    let started = 0;
    const slept: number[] = [];
    const status = await daemonLoop(
      async () => statuses[started++] ?? 0,
      () => started >= stopAfter,
      async (ms) => void slept.push(ms),
    );
    return { status, started, slept };
  };

  test("a crash or a config change starts the daemon again after a second; Ctrl-C (130) or SIGTERM (143) ends it", async () => {
    expect(await run([1, 137, 0, 129, 130])).toEqual({ status: 130, started: 5, slept: [1000, 1000, 1000, 1000] });
    expect(await run([143])).toEqual({ status: 143, started: 1, slept: [] });
  });

  test("a loop told to stop (its own Ctrl-C, SIGTERM or a seori down request) starts no new daemon", async () => {
    expect(await run([1, 1, 1], 2)).toEqual({ status: 1, started: 2, slept: [1000] });
  });
});

describe("seori daemon process", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const env = (root: string) => ({ ...process.env, SEORI_HOME: root });
  const loop = (root: string) => Bun.spawn([process.execPath, CLI, "daemon-loop"], { env: env(root), stdout: "ignore", stderr: "ignore" });
  const pidOf = (root: string): number => (JSON.parse(readFileSync(heartbeatPath(root), "utf8")) as { pid: number }).pid;
  /** Kills the loop and, and the daemon it started too (killing the loop leaves its child running). */
  const killAll = (sh: ReturnType<typeof loop>, root: string) => {
    sh.kill("SIGKILL");
    try {
      process.kill(pidOf(root), "SIGKILL");
    } catch {
      // already gone
    }
  };

  test("SIGTERM to the daemon stops seori up's restart loop with a status of 128 or more", async () => {
    const root = home();
    const sh = loop(root);
    await until("daemon heartbeat", () => existsSync(heartbeatPath(root)), 10_000);
    process.kill(pidOf(root), "SIGTERM");
    expect(await sh.exited).toBeGreaterThanOrEqual(128);
    expect(existsSync(daemonLockPath(root))).toBe(false); // stopped cleanly before the re-raise
  }, 15_000);

  // The stop that needs no signal.
  test("seori down stops the restart loop and its daemon cleanly: status 143, watch command and lock gone", async () => {
    const root = home();
    new WatchStore(root).add({
      name: "beats",
      source: { kind: "command", command: "echo $$ > pid; while :; do echo x >> beats; sleep 0.05; done", cwd: root, filter: "never" },
      owner: { kind: "lead" },
    }, Date.now());
    const sh = loop(root);
    try {
      await until("the watch command running", () => existsSync(join(root, "beats")), 15_000);
      await until("both records", () => existsSync(recordPath(root, "daemon-loop")) && existsSync(recordPath(root, "daemon")), 10_000);
      const r = await down(root, DOWN_GROUPS["daemon"]!);
      expect(r.ok).toBe(true);
      expect(r.lines.map((l) => l.split(" pid=")[0])).toEqual(["STOPPED daemon-loop", "STOPPED daemon"]);
      expect(await sh.exited).toBe(143);
      expect(existsSync(daemonLockPath(root))).toBe(false);
      expect(existsSync(recordPath(root, "daemon"))).toBe(false);
      // The daemon releases its record only after its engine stopped and reaped the command's sh.
      expect(gone(commandPid(root))).toBe(true);
    } finally {
      killAll(sh, root);
    }
  }, 40_000);

  test("a daemon that crashed (SIGKILL) is started again by the loop", async () => {
    const root = home();
    const sh = loop(root);
    try {
      await until("daemon heartbeat", () => existsSync(heartbeatPath(root)), 10_000);
      const first = pidOf(root);
      process.kill(first, "SIGKILL");
      await until("a second daemon", () => existsSync(heartbeatPath(root)) && pidOf(root) !== first, 20_000);
      expect(sh.exitCode).toBeNull();
    } finally {
      killAll(sh, root);
    }
  }, 30_000);

  test("SIGHUP (its pane closed) stops the daemon cleanly, watch commands included, with status 129", async () => {
    const root = home();
    new WatchStore(root).add({
      name: "beats",
      source: { kind: "command", command: "echo $$ > pid; while :; do echo x >> beats; sleep 0.05; done", cwd: root, filter: "never" },
      owner: { kind: "lead" },
    }, Date.now());
    const daemon = Bun.spawn([process.execPath, CLI, "daemon"], { env: env(root), stdout: "ignore", stderr: "ignore" });
    try {
      await until("the watch command running", () => existsSync(join(root, "beats")), 10_000);
      daemon.kill("SIGHUP");
      expect(await daemon.exited).toBe(129);
      expect(existsSync(daemonLockPath(root))).toBe(false);
      expect(gone(commandPid(root))).toBe(true);
    } finally {
      daemon.kill("SIGKILL");
    }
  }, 15_000);

  test("a SIGHUP sent while the restart loop lives restarts the daemon", async () => {
    const root = home();
    const sh = loop(root);
    try {
      await until("daemon heartbeat", () => existsSync(heartbeatPath(root)), 10_000);
      const first = pidOf(root);
      process.kill(first, "SIGHUP");
      await until("a second daemon", () => existsSync(heartbeatPath(root)) && pidOf(root) !== first, 20_000);
      expect(sh.exitCode).toBeNull();
    } finally {
      killAll(sh, root);
    }
  }, 30_000);

  test("a changed messengers.json makes the restart loop start a new daemon", async () => {
    const root = home();
    const sh = loop(root);
    try {
      await until("daemon heartbeat", () => existsSync(heartbeatPath(root)), 10_000);
      const first = pidOf(root);
      writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: "u1" }] }));
      await until("a second daemon", () => existsSync(heartbeatPath(root)) && pidOf(root) !== first, 20_000);
      expect(sh.exitCode).toBeNull();
      process.kill(pidOf(root), "SIGTERM");
      expect(await sh.exited).toBeGreaterThanOrEqual(128);
    } finally {
      killAll(sh, root);
    }
  }, 30_000);
});
