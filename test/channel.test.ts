import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { Channel, type InboundRow } from "../src/channel.ts";

const T0 = 1_700_000_000_000;
const row = (id: string, text = `text of ${id}`): InboundRow => ({ id, kind: "messenger", source: "fake", chat: "c1", from: "u1", at: T0, text });
const fresh = () => new Channel(mkdtempSync(join(tmpdir(), "seori-channel-")));

describe("appendInbound", () => {
  test("dedupes against rows stored earlier, by this instance, another instance, or appended after this one last looked", () => {
    const a = fresh();
    const b = new Channel(a.root);
    expect(a.appendInbound(row("fake:c1:1"))).toBe(true);
    expect(a.appendInbound(row("fake:c1:1"))).toBe(false);
    expect(b.appendInbound(row("fake:c1:1"))).toBe(false);
    expect(b.appendInbound(row("fake:c1:2"))).toBe(true);
    expect(a.appendInbound(row("fake:c1:2"))).toBe(false);
    expect(a.appendInbound(row("fake:c1:3", "한글 ✓"))).toBe(true);
    expect(new Channel(a.root).appendInbound(row("fake:c1:3"))).toBe(false);
    expect(a.inbound().map((r) => [r.id, r.text])).toEqual([
      ["fake:c1:1", "text of fake:c1:1"],
      ["fake:c1:2", "text of fake:c1:2"],
      ["fake:c1:3", "한글 ✓"],
    ]);
  });

  test("watch rows share the file, dedupe and ledger states with messenger rows", () => {
    const c = fresh();
    const ev: InboundRow = { id: "watch:w1:1", kind: "watch", watchId: "w1", name: "ci", at: T0, text: "[watch ci w1] done" };
    expect(c.appendInbound(row("fake:c1:1"))).toBe(true);
    expect(c.appendInbound(ev)).toBe(true);
    expect(c.appendInbound(ev)).toBe(false);
    c.appendLedger({ id: "watch:w1:1", ev: "entered", at: T0 });
    c.appendLedger({ id: "watch:w1:1", ev: "closed", at: T0, why: "seen" });
    expect(c.states().map((s) => [s.row.kind, s.row.id, s.entered, s.closed])).toEqual([
      ["messenger", "fake:c1:1", false, false],
      ["watch", "watch:w1:1", true, true],
    ]);
    expect(c.open().map((s) => s.row.id)).toEqual(["fake:c1:1"]);
  });

  test("after a torn tail (power loss mid-write) the next row starts on its own line and is readable", () => {
    const c = fresh();
    c.appendInbound(row("fake:c1:1"));
    appendFileSync(c.inboundPath, JSON.stringify(row("fake:c1:2")).slice(0, 25));
    expect(c.appendInbound(row("fake:c1:3"))).toBe(true);
    expect(c.inbound().map((r) => r.id)).toEqual(["fake:c1:1", "fake:c1:3"]);
    expect(readFileSync(c.inboundPath, "utf8").endsWith("\n")).toBe(true);
    // The torn id was never stored, so its redelivery from upstream is accepted.
    expect(new Channel(c.root).appendInbound(row("fake:c1:2"))).toBe(true);
    expect(c.inbound().map((r) => r.id)).toEqual(["fake:c1:1", "fake:c1:3", "fake:c1:2"]);
  });

  test("a file replaced by a shorter one is rescanned from the start", () => {
    const c = fresh();
    c.appendInbound(row("fake:c1:1"));
    c.appendInbound(row("fake:c1:2"));
    writeFileSync(c.inboundPath, `${JSON.stringify(row("fake:c1:9"))}\n`);
    expect(c.appendInbound(row("fake:c1:9"))).toBe(false);
    expect(c.appendInbound(row("fake:c1:1"))).toBe(true);
  });
});

describe("states", () => {
  test("folds each id's events, ignores events for unknown ids, and keeps per-id order", () => {
    const c = fresh();
    c.appendInbound(row("fake:c1:1"));
    c.appendInbound(row("fake:c1:2"));
    c.appendInbound(row("fake:c1:3"));
    c.appendLedger({ id: "fake:c1:1", ev: "delivered", at: T0 + 1, attempt: 1, mode: "followUp" });
    c.appendLedger({ id: "fake:c1:9", ev: "replied", at: T0 + 1, messageId: "x" });
    c.appendLedger({ id: "fake:c1:2", ev: "delivered", at: T0 + 2, attempt: 1, mode: "aside" });
    c.appendLedger({ id: "fake:c1:1", ev: "delivered", at: T0 + 3, attempt: 2, mode: "followUp" });
    c.appendLedger({ id: "fake:c1:1", ev: "entered", at: T0 + 4 });
    c.appendLedger({ id: "fake:c1:1", ev: "alerted", at: T0 + 5, why: "lead-blocked" });
    c.appendLedger({ id: "fake:c1:1", ev: "alerted", at: T0 + 6, why: "gave-up" });
    c.appendLedger({ id: "fake:c1:2", ev: "gave-up", at: T0 + 7, attempts: 3 });
    c.appendLedger({ id: "fake:c1:2", ev: "closed", at: T0 + 8, why: "x" });
    expect(c.states().map(({ row: r, ...s }) => [r.id, s])).toEqual([
      ["fake:c1:1", { deliveries: 2, lastDeliveredAt: T0 + 3, entered: true, replied: false, closed: false, uncertain: false, gaveUp: false, alerted: ["lead-blocked", "gave-up"] }],
      ["fake:c1:2", { deliveries: 1, lastDeliveredAt: T0 + 2, entered: false, replied: false, closed: true, uncertain: false, gaveUp: true, alerted: [] }],
      ["fake:c1:3", { deliveries: 0, entered: false, replied: false, closed: false, uncertain: false, gaveUp: false, alerted: [] }],
    ]);
    expect(c.open().map((s) => s.row.id)).toEqual(["fake:c1:1", "fake:c1:3"]);
  });

  test("a sending is uncertain until a later replied or send-failed settles it; send-uncertain stays uncertain", () => {
    const c = fresh();
    for (const n of ["1", "2", "3", "4"]) c.appendInbound(row(`fake:c1:${n}`));
    c.appendLedger({ id: "fake:c1:1", ev: "sending", at: T0 });
    c.appendLedger({ id: "fake:c1:2", ev: "sending", at: T0 });
    c.appendLedger({ id: "fake:c1:2", ev: "send-failed", at: T0, detail: "403" });
    c.appendLedger({ id: "fake:c1:3", ev: "sending", at: T0 });
    c.appendLedger({ id: "fake:c1:3", ev: "replied", at: T0, messageId: "m1" });
    c.appendLedger({ id: "fake:c1:4", ev: "sending", at: T0 });
    c.appendLedger({ id: "fake:c1:4", ev: "send-failed", at: T0, detail: "403" });
    c.appendLedger({ id: "fake:c1:4", ev: "sending", at: T0 + 1 });
    expect(c.states().map((s) => [s.row.id, s.uncertain, s.replied])).toEqual([
      ["fake:c1:1", true, false],
      ["fake:c1:2", false, false],
      ["fake:c1:3", false, true],
      ["fake:c1:4", true, false],
    ]);
  });

  test("stays fast on a long history (single pass over the ledger)", () => {
    const c = fresh();
    const n = 5000;
    writeFileSync(c.inboundPath, Array.from({ length: n }, (_, i) => `${JSON.stringify(row(`fake:c1:${i}`))}\n`).join(""));
    writeFileSync(
      c.ledgerPath,
      Array.from({ length: n * 4 }, (_, i) => `${JSON.stringify({ id: `fake:c1:${i % n}`, ev: "delivered", at: T0 + i, attempt: 1, mode: "followUp" })}\n`).join(""),
    );
    const start = performance.now();
    const states = c.states();
    expect(performance.now() - start).toBeLessThan(1000);
    expect(states).toHaveLength(n);
    expect(states[7]!.deliveries).toBe(4);
  });
});

describe("long-lived locks", () => {
  // A live pid on this host that is not us: the test runner's parent.
  const LIVE_LOCK = JSON.stringify({ pid: process.ppid, host: hostname(), at: T0 });

  test("a same-host lock with a live pid is held", () => {
    const c = fresh();
    writeFileSync(c.consumerLockPath, LIVE_LOCK);
    expect(c.lockConsumer(T0)).toBeUndefined();
  });

  test("a same-host lock written before this boot is stale even though its pid is alive again (reused)", () => {
    const c = fresh();
    writeFileSync(c.consumerLockPath, LIVE_LOCK);
    const beforeBoot = (Date.now() - uptime() * 1000 - 3_600_000) / 1000;
    utimesSync(c.consumerLockPath, beforeBoot, beforeBoot);
    const release = c.lockConsumer(T0);
    expect(release).toBeFunction();
    expect(JSON.parse(readFileSync(c.consumerLockPath, "utf8")).pid).toBe(process.pid);
    release!();
  });
});
