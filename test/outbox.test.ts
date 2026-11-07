import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { DeliverySchedule } from "../src/lead-delivery.ts";
import { SendUncertain, type MessengerAdapter, type MessengerConfig, type SendTarget } from "../src/messenger/adapter.ts";
import { flushLine, msgDrafts, msgDrop, msgFlush, msgList, msgSend, type MsgDeps } from "../src/msg.ts";
import { Outbox } from "../src/outbox.ts";

// Reply drafts: while the lead extension consumes, `msg send` records a draft that `msg flush` (the extension at the
// end of the lead's turn) sends later.

const T0 = 1_700_000_000_000;

function setup(o: { consumer?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "seori-outbox-"));
  const channel = new Channel(root);
  const outbox = new Outbox(root);
  const sent: { source: string; target: SendTarget; text: string }[] = [];
  let mode: "ok" | "uncertain" | "error" = "ok";
  let n = 0;
  let clock = T0;
  const adapterFor = (c: MessengerConfig): MessengerAdapter => ({
    source: c.source,
    receive: async () => {},
    send: async (target, text) => {
      sent.push({ source: c.source, target, text });
      if (mode === "uncertain") throw new SendUncertain("timed out after sending");
      if (mode === "error") throw new Error("403 forbidden");
      return { messageId: `m${++n}` };
    },
    check: async () => "stub",
  });
  const d: MsgDeps = { adapterFor, configs: [{ source: "fake", owner: "u1" }], now: () => clock };
  // The lead extension (this live process stands in for its omp) holds the consumer lock.
  if (o.consumer !== false) writeFileSync(channel.consumerLockPath, JSON.stringify({ pid: process.pid, host: hostname(), at: T0 }));
  for (const id of ["fake:c1:100", "fake:c1:101", "fake:c1:102"]) {
    channel.appendInbound({ id, kind: "messenger", source: "fake", chat: "c1", from: "u1", at: T0, text: `text of ${id}` });
  }
  return { root, channel, outbox, sent, d, setMode: (m: typeof mode) => (mode = m), tick: (ms: number) => (clock += ms) };
}

describe("msg send while the lead extension consumes", () => {
  test("a reply is checked, then drafted instead of sent: no ledger event, the id reads drafted and is not redelivered", async () => {
    const { root, channel, outbox, sent, d } = setup();
    const r = await msgSend(root, { replyTo: ["fake:c1:100"], text: "answer" }, d);
    expect(r).toMatchObject({ status: "DRAFTED", ids: ["fake:c1:100"] });
    expect(r.draft).toMatch(/^[0-9a-f]{8}$/);
    expect(sent).toEqual([]);
    expect(channel.ledger()).toEqual([]);
    expect(outbox.events()).toEqual([{ ev: "drafted", draft: r.draft!, at: T0, target: { kind: "reply", ids: ["fake:c1:100"] }, text: "answer" }]);
    const state = channel.states().find((s) => s.row.id === "fake:c1:100")!;
    expect(state.drafted).toBe(true);
    expect(msgList(root, {}, T0)[0]).toStartWith("fake:c1:100  drafted  ");
    // Never redelivered while drafted, even when a delivery and its backoff say it is due.
    channel.appendLedger({ id: "fake:c1:100", ev: "delivered", at: T0 - 600_000, attempt: 1, mode: "followUp" });
    const decision = new DeliverySchedule().decide(channel.states(), T0, true, { kind: "session_start" });
    expect(decision.deliver.map((x) => x.row.id)).toEqual(["fake:c1:101", "fake:c1:102"]);
    expect(decision.giveUp).toEqual([]);
  });

  test("the usual refusals still apply to a draft: unknown ids and ALREADY_REPLIED", async () => {
    const { root, channel, outbox, d } = setup();
    await expect(msgSend(root, { replyTo: ["fake:c1:999"], text: "x" }, d)).rejects.toThrow("unknown message id");
    channel.appendLedger({ id: "fake:c1:101", ev: "replied", at: T0, messageId: "m0" });
    await expect(msgSend(root, { replyTo: ["fake:c1:101"], text: "x" }, d)).rejects.toThrow("ALREADY_REPLIED fake:c1:101");
    expect(outbox.events()).toEqual([]);
    await expect(msgSend(root, { to: { source: "nope", chat: "c1" }, text: "x" }, d)).rejects.toThrow('no messenger "nope"');
    expect(outbox.events()).toEqual([]);
  });

  test("a notice is drafted too", async () => {
    const { root, outbox, sent, d } = setup();
    const r = await msgSend(root, { to: { source: "fake", chat: "c9", thread: "t1" }, text: "heads up" }, d);
    expect(r).toMatchObject({ status: "DRAFTED", ids: [] });
    expect(sent).toEqual([]);
    expect(outbox.open()).toMatchObject([{ draft: r.draft, target: { kind: "notice", source: "fake", chat: "c9", thread: "t1" }, text: "heads up" }]);
  });

  test("--now sends at once, as before; without a live consumer a send goes out at once", async () => {
    const live = setup();
    expect(await msgSend(live.root, { replyTo: ["fake:c1:100"], text: "ack", sendNow: true }, live.d)).toEqual({ status: "SENT", messageId: "m1", ids: ["fake:c1:100"] });
    expect(live.outbox.events()).toEqual([]);

    const dead = setup({ consumer: false });
    expect(await msgSend(dead.root, { replyTo: ["fake:c1:100"], text: "hi" }, dead.d)).toEqual({ status: "SENT", messageId: "m1", ids: ["fake:c1:100"] });
    expect(await msgSend(dead.root, { to: { source: "fake", chat: "c9" }, text: "note" }, dead.d)).toEqual({ status: "SENT", messageId: "m2", ids: [] });
    expect(dead.outbox.events()).toEqual([]);
    // A consumer lock left by a dead pid on this host is no consumer.
    writeFileSync(dead.channel.consumerLockPath, JSON.stringify({ pid: 2 ** 22 + 17, host: hostname(), at: T0 }));
    expect((await msgSend(dead.root, { replyTo: ["fake:c1:101"], text: "hi" }, dead.d)).status).toBe("SENT");
  });

  test("--now next to an open draft for the same id is refused, so the draft cannot become a second reply", async () => {
    const { root, sent, d } = setup();
    const { draft } = await msgSend(root, { replyTo: ["fake:c1:100"], text: "draft" }, d);
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "now", sendNow: true }, d)).rejects.toThrow(`fake:c1:100 has draft ${draft} waiting to go out`);
    expect(sent).toEqual([]);
  });
});

describe("replacing a draft", () => {
  test("a second send to exactly the same ids replaces the draft's text; flush sends only the new text", async () => {
    const { root, outbox, sent, d, tick } = setup();
    const first = await msgSend(root, { replyTo: ["fake:c1:100", "fake:c1:101"], text: "wrong" }, d);
    tick(1000);
    const second = await msgSend(root, { replyTo: ["fake:c1:101", "fake:c1:100"], text: "right" }, d);
    expect(second).toEqual({ status: "REPLACED", ids: ["fake:c1:101", "fake:c1:100"], draft: first.draft });
    expect(outbox.events().at(-1)).toEqual({ ev: "replaced", draft: first.draft!, at: T0 + 1000, text: "right" });
    expect(outbox.open()).toHaveLength(1);
    await msgFlush(root, d);
    expect(sent.map((s) => s.text)).toEqual(["right"]);
  });

  test("ids that only overlap an open draft are refused", async () => {
    const { root, outbox, d } = setup();
    const { draft } = await msgSend(root, { replyTo: ["fake:c1:100", "fake:c1:101"], text: "both" }, d);
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "one" }, d)).rejects.toThrow(
      `draft ${draft} already replies to fake:c1:100,fake:c1:101; to change it, send again with exactly --reply-to fake:c1:100,fake:c1:101 or use --replace ${draft}`,
    );
    await expect(msgSend(root, { replyTo: ["fake:c1:100", "fake:c1:101", "fake:c1:102"], text: "three" }, d)).rejects.toThrow(`draft ${draft} already replies to`);
    expect(outbox.events()).toHaveLength(1);
  });

  test("--replace changes any open draft, notices too; unknown or closed drafts and --now are refused", async () => {
    const { root, outbox, sent, d } = setup();
    const { draft } = await msgSend(root, { to: { source: "fake", chat: "c9" }, text: "old" }, d);
    expect(await msgSend(root, { replace: draft!, text: "new" }, d)).toEqual({ status: "REPLACED", ids: [], draft });
    expect(outbox.open()[0]!.text).toBe("new");
    await expect(msgSend(root, { replace: draft!, text: "x", sendNow: true }, d)).rejects.toThrow("--replace changes a draft");
    await expect(msgSend(root, { replace: "deadbeef", text: "x" }, d)).rejects.toThrow("no open draft deadbeef");
    await expect(msgSend(root, { replace: draft!, to: { source: "fake", chat: "c9" }, text: "x" }, d)).rejects.toThrow("exactly one of --reply-to, --to or --replace");
    await msgFlush(root, d);
    expect(sent.map((s) => [s.target.chat, s.text])).toEqual([["c9", "new"]]);
    await expect(msgSend(root, { replace: draft!, text: "late" }, d)).rejects.toThrow(`no open draft ${draft}`);
  });
});

describe("msg flush", () => {
  test("sends every open draft in creation order, records replied and released, and a second flush sends nothing", async () => {
    const { root, channel, outbox, sent, d, tick } = setup();
    const a = await msgSend(root, { replyTo: ["fake:c1:100"], text: "first" }, d);
    tick(10);
    const b = await msgSend(root, { to: { source: "fake", chat: "c1" }, text: "second" }, d);
    tick(10);
    const c = await msgSend(root, { replyTo: ["fake:c1:101"], text: "third" }, d);
    tick(10);
    const out = await msgFlush(root, d);
    expect(out.map(flushLine)).toEqual([
      `SENT ${a.draft} fake:c1:100 message=m1`,
      `SENT ${b.draft} fake:c1 message=m2`,
      `SENT ${c.draft} fake:c1:101 message=m3`,
    ]);
    expect(sent.map((s) => s.text)).toEqual(["first", "second", "third"]);
    expect(sent[0]!.target).toEqual({ chat: "c1", replyTo: "100" });
    expect(channel.ledger().filter((e) => e.ev === "replied").map((e) => e.id)).toEqual(["fake:c1:100", "fake:c1:101"]);
    expect(outbox.open()).toEqual([]);
    expect(outbox.events().filter((e) => e.ev === "released").map((e) => e.draft)).toEqual([a.draft!, b.draft!, c.draft!]);
    expect(await msgFlush(root, d)).toEqual([]);
    expect(sent).toHaveLength(3);
    expect(channel.states().find((s) => s.row.id === "fake:c1:100")).toMatchObject({ replied: true, drafted: false });
  });

  test("a definite failure leaves the draft open (send-failed in the ledger) and the next flush sends it", async () => {
    const { root, channel, outbox, sent, d, setMode } = setup();
    const { draft } = await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d);
    setMode("error");
    const out = await msgFlush(root, d);
    expect(out.map(flushLine)).toEqual([`FAILED ${draft} fake:c1:100: 403 forbidden; the draft stays open: flush again, or drop it`]);
    expect(outbox.open().map((x) => [x.draft, x.inFlight])).toEqual([[draft!, false]]);
    expect(channel.ledger().map((e) => e.ev)).toEqual(["sending", "send-failed"]);
    expect(channel.states()[0]!.drafted).toBe(true);
    setMode("ok");
    expect((await msgFlush(root, d)).map((o) => o.status)).toEqual(["SENT"]);
    expect(sent).toHaveLength(2);
    expect(outbox.open()).toEqual([]);
  });

  test("an uncertain send is released and recorded send-uncertain; it is never sent again", async () => {
    const { root, channel, outbox, sent, d, setMode } = setup();
    const { draft } = await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d);
    setMode("uncertain");
    const out = await msgFlush(root, d);
    expect(out.map(flushLine)).toEqual([`HELD ${draft} fake:c1:100: the messenger may or may not have it; check the chat, it is not sent again`]);
    expect(outbox.open()).toEqual([]);
    expect(channel.ledger().at(-1)).toMatchObject({ id: "fake:c1:100", ev: "send-uncertain" });
    setMode("ok");
    expect(await msgFlush(root, d)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test("a draft an earlier flush was killed sending is released as uncertain, not sent again", async () => {
    const { root, channel, outbox, sent, d } = setup();
    const { draft } = await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d);
    outbox.append({ ev: "sending", draft: draft!, at: T0 });
    await expect(msgSend(root, { replace: draft!, text: "x" }, d)).rejects.toThrow("may already be in the chat");
    const out = await msgFlush(root, d);
    expect(out.map((o) => o.status)).toEqual(["HELD"]);
    expect(sent).toEqual([]);
    expect(outbox.open()).toEqual([]);
    expect(channel.states()[0]!.uncertain).toBe(true);
  });

  test("a held outbox lock refuses BUSY and sends nothing", async () => {
    const { root, outbox, sent, d } = setup();
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d);
    // Another live process on this host (our parent shell's pid stands in) is flushing.
    writeFileSync(outbox.lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), at: T0 }));
    await expect(msgFlush(root, d)).rejects.toThrow("BUSY: another seori msg flush");
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "fix" }, d)).rejects.toThrow("BUSY: a seori msg flush is sending drafts");
    expect(sent).toEqual([]);
  });

  test("two concurrent flushes send each draft once", async () => {
    const { root, sent, d } = setup();
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d);
    const results = await Promise.allSettled([msgFlush(root, d), msgFlush(root, d)]);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  test("a draft made with --again is flushed with --again", async () => {
    const { root, channel, sent, d } = setup();
    channel.appendLedger({ id: "fake:c1:100", ev: "replied", at: T0, messageId: "m0" });
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "the real answer", again: true }, d);
    expect((await msgFlush(root, d)).map((o) => o.status)).toEqual(["SENT"]);
    expect(sent.map((s) => s.text)).toEqual(["the real answer"]);
  });
});

describe("msg drop and drafts", () => {
  test("drafts lists open drafts; drop discards one and its ids are open again", async () => {
    const { root, channel, outbox, sent, d, tick } = setup();
    const a = await msgSend(root, { replyTo: ["fake:c1:100"], text: `line one\n${"x".repeat(80)}` }, d);
    const b = await msgSend(root, { to: { source: "fake", chat: "c9", thread: "t1" }, text: "note" }, d);
    tick(3 * 60_000);
    expect(msgDrafts(root, T0 + 3 * 60_000)).toEqual([
      `${a.draft}  3m  reply fake:c1:100  ${JSON.stringify(`line one\n${"x".repeat(80)}`.slice(0, 60))}`,
      `${b.draft}  3m  notice fake:c9:t1  "note"`,
    ]);
    msgDrop(root, a.draft!, "answered in person", T0 + 5);
    expect(outbox.events().at(-1)).toEqual({ ev: "dropped", draft: a.draft!, at: T0 + 5, why: "answered in person" });
    expect(channel.states()[0]!.drafted).toBe(false);
    expect(() => msgDrop(root, a.draft!, "x", T0)).toThrow(`no open draft ${a.draft}`);
    expect(msgDrafts(root, T0).map((l) => l.split("  ")[0])).toEqual([b.draft!]);
    await msgFlush(root, d);
    expect(sent.map((s) => s.text)).toEqual(["note"]);
  });
});
