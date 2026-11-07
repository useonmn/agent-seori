import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS_MAX_BYTES, WatchStore } from "../src/watch/store.ts";

function setup() {
  const store = new WatchStore(mkdtempSync(join(tmpdir(), "seori-watch-store-")));
  const w = store.add({ owner: { kind: "lead" }, source: { kind: "file", path: "/tmp/x" } }, 1_000);
  const lockPath = join(store.dir, `${w.id}.json.lock`);
  return { store, w, lockPath };
}

describe("WatchStore.update", () => {
  test("saves what fn returns, skips the write when fn returns the same object, and releases its lock", () => {
    const { store, w, lockPath } = setup();
    const saved = store.update(w.id, (cur) => ({ ...cur, restarts: 2 }));
    expect(saved?.restarts).toBe(2);
    expect(store.get(w.id)?.restarts).toBe(2);
    const before = statSync(join(store.dir, `${w.id}.json`)).mtimeMs;
    expect(store.update(w.id, (cur) => cur)?.restarts).toBe(2);
    expect(statSync(join(store.dir, `${w.id}.json`)).mtimeMs).toBe(before);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("returns undefined when the watch file is gone", () => {
    const { store } = setup();
    expect(store.update("wnope", (cur) => cur)).toBeUndefined();
  });

  test("waits for another process's lock and then applies the change on the fresh copy", () => {
    const { store, w, lockPath } = setup();
    // Another process (a live pid on this host) holds the lock and has written its change (muted); it releases at 200 ms.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, host: hostname(), at: Date.now() }));
      spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").rmSync(${JSON.stringify(lockPath)}, { force: true }), 200)`], { stdio: "ignore" });
      store.save({ ...w, status: "muted" });
      const started = Date.now();
      const saved = store.update(w.id, (cur) => ({ ...cur, mutedEvents: cur.mutedEvents + 1 }));
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      expect(saved?.status).toBe("muted");
      expect(saved?.mutedEvents).toBe(1);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  test("gives up with an error while a live process keeps holding the lock", () => {
    const { store, w, lockPath } = setup();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, host: hostname(), at: Date.now() }));
      expect(() => store.update(w.id, (cur) => ({ ...cur, restarts: 1 }))).toThrow(/locked/);
      expect(store.get(w.id)?.restarts).toBe(0);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  test("takes over a lock left by a dead process", () => {
    const { store, w, lockPath } = setup();
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12_345, host: hostname(), at: Date.now() }));
    expect(store.update(w.id, (cur) => ({ ...cur, restarts: 1 }))?.restarts).toBe(1);
  });
});

describe("WatchStore.appendEvent", () => {
  test("rotates the events log to .1 once it passes EVENTS_MAX_BYTES", () => {
    const { store, w } = setup();
    const path = store.eventsPath(w.id);
    writeFileSync(path, `${"x".repeat(EVENTS_MAX_BYTES)}\n`);
    store.appendEvent(w.id, { ev: "seen", text: "after" });
    expect(statSync(`${path}.1`).size).toBe(EVENTS_MAX_BYTES + 1);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify({ ev: "seen", text: "after" })}\n`);
  });
});
