import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EngineDeps, type PaneState, WatchEngine } from "../src/watch/engine.ts";
import { type NewWatch, type Watch, WatchStore } from "../src/watch/store.ts";

/** Polls a condition the engine reaches asynchronously; fails with `what` rather than hanging. */
async function until(what: string, cond: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const FAST = { coalesceMs: 60, filePollMs: 10, fileCoalesceMs: 40, checksPollMs: 10, panePollMs: 10, backoffMs: [10, 20, 30], killGraceMs: 500 };

const engines: WatchEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
});

function setup(overrides: Partial<EngineDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "seori-watch-"));
  const store = new WatchStore(root);
  const clock = { now: 1_000_000 };
  const delivered: { id: string; text: string }[] = [];
  const deps: EngineDeps = {
    now: () => clock.now,
    deliver: async (w, text) => {
      delivered.push({ id: w.id, text });
    },
    gh: async () => ({ code: 1, stdout: "", stderr: "no gh in tests" }),
    paneStatus: async () => "working",
    laneOpen: () => true,
    tickMs: 20,
    timing: FAST,
    ...overrides,
  };
  const engine = (): WatchEngine => {
    const e = new WatchEngine(root, deps);
    engines.push(e);
    return e;
  };
  const add = (input: Omit<NewWatch, "owner"> & { owner?: NewWatch["owner"] }): Watch =>
    store.add({ owner: { kind: "lead" }, ...input }, clock.now);
  const texts = (): string[] => delivered.map((d) => d.text);
  return { root, store, clock, delivered, texts, engine, add };
}

const cmd = (command: string, filter?: string) => ({ kind: "command" as const, command, cwd: tmpdir(), filter });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("command watches", () => {
  test("delivers filtered lines coalesced into one event, prefixed with name and id", async () => {
    const t = setup();
    const w = t.add({ name: "build", source: cmd("echo a; echo noise; echo b; sleep 0.5; echo c; sleep 30", "^[abc]$") });
    t.engine().start();
    await until("two events", () => t.delivered.length >= 2);
    expect(t.texts()).toEqual([`[watch build ${w.id}] a\nb`, `[watch build ${w.id}] c`]);
    expect(t.store.get(w.id)?.wakes.length).toBe(2);
    expect(t.store.get(w.id)?.status).toBe("active");
  });

  test("caps a flood of lines in one batch", async () => {
    const t = setup();
    const w = t.add({ name: "flood", source: cmd("i=0; while [ $i -lt 100 ]; do echo line$i; i=$((i+1)); done; sleep 30") });
    t.engine().start();
    await until("an event", () => t.delivered.length >= 1);
    const text = t.texts()[0] ?? "";
    expect(text.startsWith(`[watch flood ${w.id}] line0\n`)).toBe(true);
    expect(text.split("\n")).toHaveLength(41);
    expect(text.endsWith("(+60 more lines)")).toBe(true);
  });

  test("exit 0 marks the watch done with the last output lines", async () => {
    const t = setup();
    const w = t.add({ name: "job", source: cmd("echo x; echo y") });
    t.engine().start();
    await until("done", () => t.store.get(w.id)?.status === "done");
    await until("final event", () => t.delivered.length === 2);
    expect(t.texts()).toEqual([`[watch job ${w.id}] x\ny`, `[watch job ${w.id}] exited 0\nx\ny`]);
    expect(t.store.get(w.id)?.reason).toBe("exited 0");
  });

  test("a crashing command is restarted with backoff, then stopped", async () => {
    const t = setup();
    const w = t.add({ name: "crash", source: cmd("echo boom; exit 3") });
    t.engine().start();
    await until("stopped", () => t.store.get(w.id)?.status === "stopped");
    await until("final event", () => t.texts().some((x) => x.endsWith("kept crashing (exit 3); stopped")));
    const saved = t.store.get(w.id);
    expect(saved?.restarts).toBe(3);
    expect(saved?.reason).toBe("kept crashing (exit 3)");
    expect(t.texts().filter((x) => x.endsWith("] boom"))).toHaveLength(4);
    const log = readFileSync(t.store.eventsPath(w.id), "utf8");
    expect(log.match(/"ev":"restarted"/g)).toHaveLength(3);
  });

  test("engine stop kills the whole process group and leaves the watch active", async () => {
    const t = setup();
    const pidFile = join(t.root, "bg.pid");
    const w = t.add({ name: "bg", source: cmd(`sleep 30 & echo $! > ${pidFile}; wait`) });
    const e = t.engine();
    e.start();
    await until("background pid", () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(pid)).toBe(true);
    await e.stop();
    await until("background job killed", () => !alive(pid));
    expect(t.store.get(w.id)?.status).toBe("active");
  });

  test("`seori watch stop` (status changed on disk) kills the running command", async () => {
    const t = setup();
    const pidFile = join(t.root, "bg.pid");
    const w = t.add({ name: "bg", source: cmd(`sleep 30 & echo $! > ${pidFile}; wait`) });
    t.engine().start();
    await until("background pid", () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const cur = t.store.get(w.id) as Watch;
    t.store.save({ ...cur, status: "stopped", reason: "stopped by seori watch stop" });
    await until("command killed", () => !alive(pid));
    expect(t.delivered).toEqual([]);
  });
});

describe("file watches", () => {
  test("reports created, modified and deleted", async () => {
    const t = setup();
    const path = join(t.root, "target.txt");
    const w = t.add({ name: "f", source: { kind: "file", path } });
    t.engine().start();
    await until("baseline checkpoint", () => t.store.get(w.id)?.checkpoint !== undefined);
    writeFileSync(path, "1");
    await until("created", () => t.delivered.length === 1);
    writeFileSync(path, "22");
    await until("modified", () => t.delivered.length === 2);
    rmSync(path);
    await until("deleted", () => t.delivered.length === 3);
    expect(t.texts()).toEqual([`[watch f ${w.id}] created ${path}`, `[watch f ${w.id}] modified ${path}`, `[watch f ${w.id}] deleted ${path}`]);
    expect(t.store.get(w.id)?.checkpoint).toEqual({ exists: false });
  });

  test("a change while the daemon was down is reported once", async () => {
    const t = setup();
    const path = join(t.root, "target.txt");
    const w = t.add({ name: "f", source: { kind: "file", path } });
    const first = t.engine();
    first.start();
    await until("baseline checkpoint", () => t.store.get(w.id)?.checkpoint !== undefined);
    await first.stop();
    writeFileSync(path, "while down");
    const second = t.engine();
    second.start();
    await until("created", () => t.delivered.length === 1);
    expect(t.texts()).toEqual([`[watch f ${w.id}] created ${path}`]);
    await second.stop();
    t.engine().start();
    // Asserting an absence: there is no signal to await, so give the real poller (10 ms) several rounds.
    await Bun.sleep(150);
    expect(t.delivered).toHaveLength(1);
  });
});

describe("checks watches", () => {
  test("waits while pending, logs gh errors, then reports the result and finishes", async () => {
    const replies = [
      { code: 1, stdout: "", stderr: "HTTP 502" },
      { code: 8, stdout: JSON.stringify([{ name: "test", bucket: "pending" }]), stderr: "" },
      {
        code: 1,
        stdout: JSON.stringify([
          { name: "test", bucket: "pass" },
          { name: "lint", bucket: "fail" },
          { name: "deploy", bucket: "skipping" },
        ]),
        stderr: "",
      },
    ];
    const calls: string[][] = [];
    const t = setup({
      gh: async (argv) => {
        calls.push(argv);
        return replies[Math.min(calls.length - 1, replies.length - 1)] as { code: number; stdout: string; stderr: string };
      },
    });
    const w = t.add({ name: "ci", source: { kind: "checks", repo: "o/r", number: 7 } });
    t.engine().start();
    await until("done", () => t.store.get(w.id)?.status === "done");
    await until("event", () => t.delivered.length === 1);
    expect(t.texts()).toEqual([`[watch ci ${w.id}] checks finished: pass 1, fail 1, skipped 1 (failing: lint)`]);
    expect(calls[0]).toEqual(["pr", "checks", "7", "--repo", "o/r", "--json", "name,bucket"]);
    expect(calls).toHaveLength(3);
    expect(readFileSync(t.store.eventsPath(w.id), "utf8")).toContain("HTTP 502");
  });
});

describe("pane watches", () => {
  test("finishes when the pane reaches the wanted status", async () => {
    const seq: PaneState[] = ["working", "working", "idle"];
    let i = 0;
    const t = setup({ paneStatus: async () => seq[Math.min(i++, seq.length - 1)] as PaneState });
    const w = t.add({ name: "p", source: { kind: "pane", pane: "p1", status: "idle" } });
    t.engine().start();
    await until("event", () => t.delivered.length === 1);
    expect(t.texts()).toEqual([`[watch p ${w.id}] pane p1 is idle`]);
    expect(t.store.get(w.id)?.status).toBe("done");
  });

  test("a missing pane finishes the watch too", async () => {
    const t = setup({ paneStatus: async () => "gone" });
    const w = t.add({ name: "p", source: { kind: "pane", pane: "p9", status: "blocked" } });
    t.engine().start();
    await until("event", () => t.delivered.length === 1);
    expect(t.texts()).toEqual([`[watch p ${w.id}] pane p9 is gone`]);
  });
});

describe("lifecycle", () => {
  test("an expired watch gets one final event and its runner stops", async () => {
    const t = setup();
    const w = t.add({ name: "slow", source: cmd("sleep 30"), timeoutMs: 1_000 });
    const e = t.engine();
    await e.tick();
    t.clock.now += 1_000;
    await e.tick();
    await e.tick();
    expect(t.store.get(w.id)?.status).toBe("expired");
    expect(t.texts()).toEqual([`[watch slow ${w.id}] expired`]);
  });

  test("a watch whose lane closed is stopped without a delivery", async () => {
    let open = true;
    const t = setup({ laneOpen: (key) => key === "feat" && open });
    const w = t.add({ name: "lw", source: cmd("sleep 30"), owner: { kind: "lane", key: "feat" } });
    const e = t.engine();
    await e.tick();
    expect(t.store.get(w.id)?.status).toBe("active");
    open = false;
    await e.tick();
    const saved = t.store.get(w.id);
    expect(saved?.status).toBe("stopped");
    expect(saved?.reason).toBe("owner lane closed");
    expect(t.delivered).toEqual([]);
  });

  test("the wake budget mutes a chatty watch, counts muted events, and rearm resumes delivery", async () => {
    const t = setup();
    const w = t.add({ name: "chat", source: cmd("i=0; while true; do i=$((i+1)); echo $i; sleep 0.12; done") });
    t.engine().start();
    await until("muted", () => t.store.get(w.id)?.status === "muted");
    await until("muted events", () => (t.store.get(w.id)?.mutedEvents ?? 0) >= 3);
    const texts = t.texts();
    expect(texts).toHaveLength(7);
    expect(texts.slice(0, 6).every((x) => /^\[watch chat \w+\] \d+$/.test(x))).toBe(true);
    expect(texts[6]).toBe(`[watch chat ${w.id}] muted after 6 wakes in 1h; seori watch rearm ${w.id} to resume`);

    // what `seori watch rearm` writes
    const cur = t.store.get(w.id) as Watch;
    t.store.save({ ...cur, status: "active", wakes: [], mutedEvents: 0 });
    await until("delivery resumed", () => t.delivered.length >= 9);
    expect(t.texts().slice(7).every((x) => /^\[watch chat \w+\] \d+$/.test(x))).toBe(true);
  });

  test("wakes older than the window do not count toward the budget", async () => {
    const t = setup();
    const w = t.add({ name: "slowchat", source: cmd("i=0; while true; do i=$((i+1)); echo $i; sleep 0.1; done") });
    const cur = t.store.get(w.id) as Watch;
    t.store.save({ ...cur, wakes: Array.from({ length: 6 }, (_, i) => t.clock.now - 3_600_000 - i) });
    t.engine().start();
    await until("one delivery", () => t.delivered.length >= 1);
    expect(t.store.get(w.id)?.status).toBe("active");
    expect(t.store.get(w.id)?.wakes).toHaveLength(1);
  });

  test("a failing delivery is logged and the engine keeps going", async () => {
    const t = setup({
      deliver: async () => {
        throw new Error("lane unreachable");
      },
    });
    const w = t.add({ name: "job", source: cmd("echo x") });
    t.engine().start();
    await until("done", () => t.store.get(w.id)?.status === "done");
    await until("logged", () => readFileSync(t.store.eventsPath(w.id), "utf8").includes("lane unreachable"));
  });

  test("a HELD delivery counts as a wake, is logged as uncertain, and is not resent", async () => {
    let attempts = 0;
    const t = setup({
      deliver: async () => {
        attempts++;
        throw new Error("HELD: lane busy; message may be in the pane");
      },
    });
    const w = t.add({ name: "job", source: cmd("echo x") });
    t.engine().start();
    await until("done", () => t.store.get(w.id)?.status === "done");
    await until("logged", () => readFileSync(t.store.eventsPath(w.id), "utf8").match(/delivered-uncertain/g)?.length === 2);
    expect(attempts).toBe(2);
    expect(t.store.get(w.id)?.wakes).toHaveLength(2);
  });
});
