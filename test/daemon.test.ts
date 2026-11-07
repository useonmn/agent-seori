import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { daemonLoop } from "../src/cli.ts";
import { type DaemonEvent, daemonLine, daemonLockPath, heartbeatPath, runDaemon } from "../src/daemon.ts";
import type { InboundMessage, MessengerAdapter, MessengerConfig } from "../src/messenger/adapter.ts";
import { FakeAdapter } from "../src/messenger/fake.ts";
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
      source: "x",
      async receive(signal, onMessage) {
        attempts++;
        await onMessage(msg("x:c:1"));
        if (attempts === 1) throw new Error("crashed before offset commit");
        await onMessage(msg("x:c:2"));
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
      },
      send: async () => ({ messageId: "1" }),
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
    const root = home([{ source: "telegram", owner: "u1" }, { source: "flaky", owner: "u1" }, { source: "fake", owner: "u1" }]);
    let flakyRuns = 0;
    const flaky: MessengerAdapter = {
      source: "flaky",
      async receive(signal, onMessage) {
        if (++flakyRuns < 3) throw new Error(`boom ${flakyRuns}`);
        await onMessage(msg("flaky:c:1"));
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
      },
      send: async () => ({ messageId: "1" }),
    };
    fakeIn(root, { msgId: "1", chat: "c", from: "u1", text: "still here" });
    const d = start(root, { adapterFor: (c, r) => (c.source === "flaky" ? flaky : fakePoll(c, r)) });
    await until("both stored", () => ["flaky:c:1", "fake:c:1"].every((id) => d.events.some((e) => e.ev === "stored" && e.id === id)));
    await d.stop();
    expect(flakyRuns).toBe(3);
    expect(d.lines()).toContain("DAEMON flaky error: boom 1; restarting in 5 ms");
    expect(d.lines()).toContain("DAEMON telegram error: messenger telegram is not supported yet (real adapters come in a later stage); restarting in 5 ms");
    expect(new Channel(root).inbound().map((r) => r.id).sort()).toEqual(["fake:c:1", "flaky:c:1"]);
  });

  test("a second daemon is refused while the first holds the lock and starts once it is gone", async () => {
    const root = home();
    const first = start(root);
    await until("lock", () => existsSync(daemonLockPath(root)));
    await expect(runDaemon(root, { onEvent: () => {} })).rejects.toThrow(`another seori daemon is running for ${root} (pid ${process.pid})`);
    await first.stop();
    expect(existsSync(daemonLockPath(root))).toBe(false);

    // A lock left by a dead process on this host is taken over.
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(daemonLockPath(root), JSON.stringify({ pid: dead, host: hostname(), at: 1 }));
    const second = start(root);
    await until("lock taken over", () => JSON.parse(readFileSync(daemonLockPath(root), "utf8")).pid === process.pid);
    await second.stop();
    expect(existsSync(daemonLockPath(root))).toBe(false);
  });

  test("rewrites the heartbeat while running and keeps running with no messengers", async () => {
    const root = home();
    let clock = 1_000;
    const d = start(root, { now: () => clock++ });
    const beat = () => JSON.parse(readFileSync(heartbeatPath(root), "utf8")) as { at: number; pid: number };
    await until("heartbeat", () => existsSync(heartbeatPath(root)));
    const firstAt = beat().at;
    await until("heartbeat advances", () => beat().at > firstAt + 2);
    expect(beat().pid).toBe(process.pid);
    expect(d.lines()).toEqual([`DAEMON no messengers configured; add one to ${join(root, "messengers.json")} (heartbeat and watches only)`]);
    await d.stop();
    const stoppedAt = beat().at;
    await Bun.sleep(30); // proving the absence of further beats needs real time to pass
    expect(beat().at).toBe(stoppedAt);
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
      source: { kind: "command", command: "while :; do echo tick; echo x >> beats; sleep 0.05; done", cwd: root, filter: "tick" },
      owner: { kind: "lead" },
    }, Date.now());
    const delivered: [Watch, string][] = [];
    const d = start(root, { watch: { tickMs: 20, deliver: async (watch, text) => void delivered.push([watch, text]) } });
    await until("a delivered watch event", () => delivered.length > 0, 5_000);
    expect(delivered[0]![0].id).toBe(w.id);
    expect(delivered[0]![1]).toStartWith(`[watch ticker ${w.id}] `);
    await d.stop();
    const beats = () => readFileSync(join(root, "beats"), "utf8").length;
    const atStop = beats();
    await Bun.sleep(300); // proving the command no longer runs needs real time to pass
    expect(beats()).toBe(atStop);
    expect(existsSync(daemonLockPath(root))).toBe(false);
  });
});

describe("seori daemon process", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const LOOP = daemonLoop(`bun ${CLI}`);
  const pidOf = (root: string): number => (JSON.parse(readFileSync(heartbeatPath(root), "utf8")) as { pid: number }).pid;

  test("SIGTERM to the daemon stops seori up's restart loop with a status of 128 or more", async () => {
    const root = home();
    const sh = Bun.spawn(["sh", "-c", LOOP], { env: { ...process.env, SEORI_HOME: root }, stdout: "ignore", stderr: "ignore" });
    await until("daemon heartbeat", () => existsSync(heartbeatPath(root)), 10_000);
    process.kill(pidOf(root), "SIGTERM");
    expect(await sh.exited).toBeGreaterThanOrEqual(128);
    expect(existsSync(daemonLockPath(root))).toBe(false); // stopped cleanly before the re-raise
  }, 15_000);

  test("a daemon that crashed (SIGKILL) is started again by the loop", async () => {
    const root = home();
    const sh = Bun.spawn(["sh", "-c", LOOP], { env: { ...process.env, SEORI_HOME: root }, stdout: "ignore", stderr: "ignore" });
    try {
      await until("daemon heartbeat", () => existsSync(heartbeatPath(root)), 10_000);
      const first = pidOf(root);
      process.kill(first, "SIGKILL");
      await until("a second daemon", () => existsSync(heartbeatPath(root)) && pidOf(root) !== first, 20_000);
      expect(sh.exitCode).toBeNull();
    } finally {
      sh.kill("SIGKILL");
    }
  }, 30_000);

  test("a changed messengers.json makes the restart loop start a new daemon", async () => {
    const root = home();
    const sh = Bun.spawn(["sh", "-c", LOOP], { env: { ...process.env, SEORI_HOME: root }, stdout: "ignore", stderr: "ignore" });
    try {
      await until("daemon heartbeat", () => existsSync(heartbeatPath(root)), 10_000);
      const first = pidOf(root);
      writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: "u1" }] }));
      await until("a second daemon", () => existsSync(heartbeatPath(root)) && pidOf(root) !== first, 20_000);
      expect(sh.exitCode).toBeNull();
      process.kill(pidOf(root), "SIGTERM");
      expect(await sh.exited).toBeGreaterThanOrEqual(128);
    } finally {
      sh.kill("SIGKILL");
    }
  }, 30_000);
});
