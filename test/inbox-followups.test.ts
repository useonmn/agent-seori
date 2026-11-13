import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { main } from "../src/cli.ts";
import { dutyTick, flushInbox, send } from "../src/harness.ts";
import { INBOX_LOCK_STALE_MS } from "../src/store.ts";
import { World, paneRef } from "./fake.ts";

// #108: follow-ups to #89 (PR 102).

const NOT_READY = '{"error":{"code":"agent_not_ready"}}';

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", paneRef("t1"));
  const pane = w.addPane("t2", "idle");
  const count = (id: string, group: string, verb: string) =>
    w.calls.filter((c) => c.argv[0] === group && c.argv[1] === verb && c.argv[2] === id).length;
  const notices = () => lead.received.filter((m) => m.startsWith("[DELIVERY-AMBIGUOUS hc:t2]"));
  return { w, d, lead, pane, count, notices };
}

async function captureIo(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  try {
    return { code: await run(), out: out.join("\n") };
  } finally {
    console.log = log;
  }
}

describe("releasing held entries: seori inbox list | ack | resend (#108 2)", () => {
  function heldInbox(s: ReturnType<typeof setup>) {
    const long = `SECRET "quoted"\n${"x".repeat(100)}`;
    s.d.store.saveInbox(paneRef("t2"), [
      { at: 0, from: "lane-a", text: long, attempt: { at: 1, state: "ambiguous", detail: "timeout" } },
      { at: 120_000, from: "duty", text: "plain" },
    ]);
    return long;
  }

  test("list prints index, state, sender and queued time, and at most the first 60 characters JSON-escaped", async () => {
    const s = setup();
    const long = heldInbox(s);
    const r = await captureIo(() => main(["inbox", "list", "hc:t2"], s.d));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `1 held from lane-a queued 1970-01-01T00:00:00.000Z ${JSON.stringify(long.slice(0, 60))}...`,
      `2 queued from duty queued 1970-01-01T00:02:00.000Z "plain"`,
    ]);
    expect(r.out).not.toContain("x".repeat(61));
  });

  test("ack drops the held entry and nothing else; a role name resolves to its pane", async () => {
    const s = setup();
    heldInbox(s);
    s.d.store.setRole("duty", paneRef("t2"));
    const r = await captureIo(() => main(["inbox", "ack", "duty", "1"], s.d));
    expect(r).toEqual({ code: 0, out: "ACKED hc:t2 1" });
    expect(s.d.store.queued(paneRef("t2")).map((m) => m.text)).toEqual(["plain"]);
  });

  test("ack and resend refuse an entry that is not held, and an index out of range", async () => {
    const s = setup();
    heldInbox(s);
    await expect(main(["inbox", "ack", "hc:t2", "2"], s.d)).rejects.toThrow(/not held/);
    await expect(main(["inbox", "resend", "hc:t2", "2"], s.d)).rejects.toThrow(/not held/);
    await expect(main(["inbox", "ack", "hc:t2", "4"], s.d)).rejects.toThrow(/no entry 4/);
    await expect(main(["inbox", "ack", "hc:t2", "x"], s.d)).rejects.toThrow(/no entry/);
    expect(s.d.store.queued(paneRef("t2"))).toHaveLength(2);
  });

  test("resend clears the attempt, and the next flush delivers it exactly once", async () => {
    const s = setup();
    s.d.store.saveInbox(paneRef("t2"), [{ at: 0, from: "cli", text: "again", attempt: { at: 1, state: "ambiguous", detail: "timeout" } }]);
    expect(await dutyTick(s.d)).toContainEqual(expect.objectContaining({ pane: "hc:t2", action: "delivery-ambiguous" }));
    expect(s.pane.received).toEqual([]);
    const r = await captureIo(() => main(["inbox", "resend", "hc:t2", "1"], s.d));
    expect(r.out).toBe("RELEASED hc:t2 1: the next flush delivers it");
    expect(s.d.store.queued(paneRef("t2"))).toEqual([{ at: 0, from: "cli", text: "again" }]);
    expect(await dutyTick(s.d)).toEqual([{ pane: "hc:t2", action: "flushed" }]);
    expect(await dutyTick(s.d)).toEqual([]);
    expect(s.pane.received).toEqual(["again"]);
  });

  test("a gone pane with only held entries reports inbox-target-gone, not delivery-ambiguous", async () => {
    const s = setup();
    s.d.store.saveInbox(paneRef("t2"), [{ at: 0, from: "cli", text: "held", attempt: { at: 1, state: "ambiguous" } }]);
    s.w.panes.delete("t2");
    expect(await dutyTick(s.d)).toEqual([{ pane: "hc:t2", action: "inbox-target-gone" }]);
  });
});

describe("one flush per pane (#108 3)", () => {
  const lockPath = (s: ReturnType<typeof setup>) => `${s.d.store.inboxPath(paneRef("t2"))}.lock`;

  test("while another flush holds the pane's lock, flushInbox returns queued and delivers nothing", async () => {
    const s = setup();
    s.pane.status = "working";
    await send(s.d, "hc:t2", "once", "cli");
    s.pane.status = "idle";
    const release = s.d.store.lockInbox(paneRef("t2"), s.w.clock)!;
    expect(release).toBeDefined();
    expect(await flushInbox(s.d, paneRef("t2"))).toBe("queued");
    expect(await dutyTick(s.d)).toEqual([]);
    expect(s.pane.received).toEqual([]);
    expect(s.d.store.queued(paneRef("t2"))).toHaveLength(1);
    release();
    expect(await flushInbox(s.d, paneRef("t2"))).toBe("delivered");
    expect(s.pane.received).toEqual(["once"]);
    expect(existsSync(lockPath(s))).toBe(false);
  });

  test("two concurrent flushInbox calls: the second, started while the first is inside, returns queued; one delivery", async () => {
    const s = setup();
    s.pane.status = "working";
    await send(s.d, "hc:t2", "once", "cli");
    s.pane.status = "idle";
    let second: Promise<string> | undefined;
    // The first flush's `pane get` starts the second flush: both are in flight at the same time, with no timing.
    s.w.getHook.set("t2", (n) => { if (n === 2) second = flushInbox(s.d, paneRef("t2")); });
    const first = await flushInbox(s.d, paneRef("t2"));
    expect(second).toBeDefined();
    expect([first, await second]).toEqual(["delivered", "queued"]);
    expect(s.count("t2", "--json", "send")).toBe(1);
    expect(s.pane.received).toEqual(["once"]);
  });

  test("a lock held by a dead pid on this host, or older than 60 s from another host, is taken over", async () => {
    const s = setup();
    const exited = Bun.spawn([process.execPath, "-e", ""]);
    await exited.exited;
    for (const stale of [
      { pid: 1, host: "other-host", at: s.w.clock - INBOX_LOCK_STALE_MS - 1 },
      { pid: exited.pid, host: hostname(), at: s.w.clock },
    ]) {
      s.d.store.enqueue(paneRef("t2"), { at: s.w.clock, from: "cli", text: `m${stale.host === "other-host" ? 1 : 2}` });
      writeFileSync(lockPath(s), JSON.stringify(stale));
      expect(await flushInbox(s.d, paneRef("t2"))).toBe("delivered");
      expect(existsSync(lockPath(s))).toBe(false);
    }
    expect(s.pane.received).toEqual(["m1", "m2"]);
  });

  test("a fresh lock on another host, or a live pid on this host however old its lock, is not taken over", async () => {
    const s = setup();
    s.d.store.enqueue(paneRef("t2"), { at: s.w.clock, from: "cli", text: "wait" });
    for (const live of [
      { pid: 1, host: "other-host", at: s.w.clock },
      { pid: process.pid, host: hostname(), at: s.w.clock - 1000 },
      // A live flush stuck in a slow hc call for longer than the stale age still owns the pane.
      { pid: process.pid, host: hostname(), at: s.w.clock - INBOX_LOCK_STALE_MS - 60_000 },
    ]) {
      writeFileSync(lockPath(s), JSON.stringify(live));
      expect(await flushInbox(s.d, paneRef("t2"))).toBe("queued");
    }
    expect(s.pane.received).toEqual([]);
  });

  test("the lock is released when the flush throws, and ack refuses while a flush holds it", async () => {
    const s = setup();
    s.d.store.saveInbox(paneRef("t2"), [{ at: 0, from: "cli", text: "held", attempt: { at: 1, state: "ambiguous" } }]);
    const release = s.d.store.lockInbox(paneRef("t2"), s.w.clock)!;
    await expect(main(["inbox", "ack", "hc:t2", "1"], s.d)).rejects.toThrow(/being flushed/);
    release();
    s.w.panes.delete("t2");
    await expect(flushInbox(s.d, paneRef("t2"))).rejects.toThrow(/gone/);
    expect(existsSync(lockPath(s))).toBe(false);
  });
});
