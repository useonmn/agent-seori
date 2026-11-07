import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, type MessengerRow } from "../src/channel.ts";
import { Refusal } from "../src/harness.ts";
import { SendUncertain, type MessengerAdapter, type MessengerConfig, type SendTarget } from "../src/messenger/adapter.ts";
import { msgClose, msgList, msgSend, parseTo, type MsgDeps } from "../src/msg.ts";

const T0 = 1_700_000_000_000;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "seori-msg-"));
  const channel = new Channel(root);
  const sent: { source: string; target: SendTarget; text: string }[] = [];
  let mode: "ok" | "uncertain" | "error" = "ok";
  let n = 0;
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
  const d: MsgDeps = { adapterFor, configs: [{ source: "fake", owner: "u1" }, { source: "tg", owner: "u1" }], now: () => T0 + 1000 };
  const add = (id: string, o: Partial<MessengerRow> = {}) => {
    const [source, chat] = id.split(":");
    channel.appendInbound({ id, kind: "messenger", source: source!, chat: chat!, from: "u1", at: T0, text: `text of ${id}`, ...o });
  };
  const addWatch = (watchId: string, seq: number, text = `event ${seq}`) =>
    channel.appendInbound({ id: `watch:${watchId}:${seq}`, kind: "watch", watchId, name: "ci", at: T0, text });
  return { root, channel, sent, d, add, addWatch, setMode: (m: typeof mode) => (mode = m) };
}

describe("msg send --reply-to", () => {
  test("success replies in the row's chat/thread to the first upstream id and marks every id replied", async () => {
    const { root, channel, sent, d, add } = setup();
    add("fake:c1:100", { thread: "t9" });
    add("fake:c1:101");
    const r = await msgSend(root, { replyTo: ["fake:c1:100", "fake:c1:101"], text: "done" }, d);
    expect(r).toEqual({ status: "SENT", messageId: "m1", ids: ["fake:c1:100", "fake:c1:101"] });
    expect(sent).toEqual([{ source: "fake", target: { chat: "c1", thread: "t9", replyTo: "100" }, text: "done" }]);
    expect(channel.ledger()).toEqual([
      { id: "fake:c1:100", ev: "sending", at: T0 + 1000 },
      { id: "fake:c1:101", ev: "sending", at: T0 + 1000 },
      { id: "fake:c1:100", ev: "replied", at: T0 + 1000, messageId: "m1" },
      { id: "fake:c1:101", ev: "replied", at: T0 + 1000, messageId: "m1" },
    ]);
    expect(channel.open()).toEqual([]);
  });

  test("ALREADY_REPLIED blocks a second reply without calling the adapter; --again sends", async () => {
    const { root, channel, sent, d, add } = setup();
    add("fake:c1:100");
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "one" }, d);
    const second = msgSend(root, { replyTo: ["fake:c1:100"], text: "two" }, d);
    await expect(second).rejects.toThrow(Refusal);
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "two" }, d)).rejects.toThrow("ALREADY_REPLIED fake:c1:100 (message m1)");
    expect(sent).toHaveLength(1);
    const again = await msgSend(root, { replyTo: ["fake:c1:100"], text: "two", again: true }, d);
    expect(again).toMatchObject({ status: "SENT", messageId: "m2" });
    expect(sent).toHaveLength(2);
    expect(channel.ledger().filter((e) => e.ev === "replied")).toHaveLength(2);
  });

  test("SendUncertain records send-uncertain for every id and returns HELD; later sends are refused as UNCERTAIN", async () => {
    const { root, channel, sent, d, add, setMode } = setup();
    add("fake:c1:100");
    add("fake:c1:101");
    setMode("uncertain");
    const r = await msgSend(root, { replyTo: ["fake:c1:100", "fake:c1:101"], text: "hi" }, d);
    expect(r).toEqual({ status: "HELD", ids: ["fake:c1:100", "fake:c1:101"] });
    expect(channel.ledger()).toEqual([
      { id: "fake:c1:100", ev: "sending", at: T0 + 1000 },
      { id: "fake:c1:101", ev: "sending", at: T0 + 1000 },
      { id: "fake:c1:100", ev: "send-uncertain", at: T0 + 1000, detail: "timed out after sending" },
      { id: "fake:c1:101", ev: "send-uncertain", at: T0 + 1000, detail: "timed out after sending" },
    ]);
    setMode("ok");
    await expect(msgSend(root, { replyTo: ["fake:c1:101"], text: "hi" }, d)).rejects.toThrow("UNCERTAIN fake:c1:101");
    expect(sent).toHaveLength(1);
    expect(await msgSend(root, { replyTo: ["fake:c1:101"], text: "hi", again: true }, d)).toMatchObject({ status: "SENT" });
  });

  test("a definite send error records send-failed, leaves the id open and propagates; a retry is allowed", async () => {
    const { root, channel, sent, d, add, setMode } = setup();
    add("fake:c1:100");
    setMode("error");
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d)).rejects.toThrow("403 forbidden");
    expect(channel.ledger()).toEqual([
      { id: "fake:c1:100", ev: "sending", at: T0 + 1000 },
      { id: "fake:c1:100", ev: "send-failed", at: T0 + 1000, detail: "403 forbidden" },
    ]);
    expect(channel.open()).toHaveLength(1);
    expect(channel.open()[0]!.uncertain).toBe(false);
    setMode("ok");
    expect(await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d)).toMatchObject({ status: "SENT" });
    expect(sent).toHaveLength(2);
  });

  test("a send killed mid-flight (sending, nothing after) is uncertain: refused without --again, never redelivered", async () => {
    const { root, channel, sent, d, add } = setup();
    add("fake:c1:100");
    channel.appendLedger({ id: "fake:c1:100", ev: "sending", at: T0 });
    expect(channel.states()[0]!.uncertain).toBe(true);
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d)).rejects.toThrow("UNCERTAIN fake:c1:100");
    expect(sent).toEqual([]);
    expect(msgList(root, {}, T0)[0]).toStartWith("fake:c1:100  uncertain  ");
    expect(await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi", again: true }, d)).toMatchObject({ status: "SENT" });
  });

  test("a held reply lock refuses BUSY before checking or sending", async () => {
    const { root, channel, sent, d, add } = setup();
    add("fake:c1:100");
    // Another live process on this host (our parent shell's pid stands in) is mid-reply.
    writeFileSync(channel.replyLockPath, JSON.stringify({ pid: process.ppid, host: hostname(), at: T0 }));
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d)).rejects.toThrow("BUSY");
    expect(sent).toEqual([]);
    expect(channel.ledger()).toEqual([]);
  });

  test("two concurrent replies to one id: exactly one is sent", async () => {
    const { root, channel, d, add } = setup();
    add("fake:c1:100");
    let calls = 0;
    const gate = Promise.withResolvers<void>();
    const slow: MsgDeps = {
      ...d,
      adapterFor: (c) => ({
        source: c.source,
        receive: async () => {},
        send: async () => {
          calls++;
          await gate.promise;
          return { messageId: "slow1" };
        },
        check: async () => "stub",
      }),
    };
    const first = msgSend(root, { replyTo: ["fake:c1:100"], text: "a" }, slow);
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "b" }, slow)).rejects.toThrow("BUSY");
    gate.resolve();
    expect(await first).toMatchObject({ status: "SENT", messageId: "slow1" });
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], text: "c" }, slow)).rejects.toThrow("ALREADY_REPLIED");
    expect(calls).toBe(1);
    expect(channel.ledger().filter((e) => e.ev === "replied")).toHaveLength(1);
  });

  test("refuses unknown ids, ids from different chats, and mixing --reply-to with --to", async () => {
    const { root, channel, sent, d, add } = setup();
    add("fake:c1:100");
    add("fake:c2:200");
    add("tg:c1:300");
    await expect(msgSend(root, { replyTo: ["fake:c1:999"], text: "x" }, d)).rejects.toThrow("unknown message id fake:c1:999");
    await expect(msgSend(root, { replyTo: ["fake:c1:100", "fake:c2:200"], text: "x" }, d)).rejects.toThrow("one reply goes to one chat");
    await expect(msgSend(root, { replyTo: ["fake:c1:100", "tg:c1:300"], text: "x" }, d)).rejects.toThrow("one reply goes to one chat");
    await expect(msgSend(root, { replyTo: ["fake:c1:100"], to: { source: "fake", chat: "c1" }, text: "x" }, d)).rejects.toThrow("exactly one");
    await expect(msgSend(root, { text: "x" }, d)).rejects.toThrow("exactly one");
    expect(sent).toEqual([]);
    expect(channel.ledger()).toEqual([]);
  });
});

describe("msg send --to", () => {
  test("a notice goes to the given chat and touches no ledger", async () => {
    const { root, channel, sent, d } = setup();
    const r = await msgSend(root, { to: parseTo("tg:c5:t1"), text: "heads up" }, d);
    expect(r).toEqual({ status: "SENT", messageId: "m1", ids: [] });
    expect(sent).toEqual([{ source: "tg", target: { chat: "c5", thread: "t1" }, text: "heads up" }]);
    expect(channel.ledger()).toEqual([]);
    await expect(msgSend(root, { to: { source: "slack", chat: "c" }, text: "x" }, d)).rejects.toThrow('no messenger "slack"');
  });

  test("parseTo", () => {
    expect(parseTo("fake:c1")).toEqual({ source: "fake", chat: "c1" });
    expect(parseTo("fake:c1:a:b")).toEqual({ source: "fake", chat: "c1", thread: "a:b" });
    for (const bad of ["fake", "fake:", ":c1", "fake:c1:"]) expect(() => parseTo(bad)).toThrow(Refusal);
  });
});

describe("msg close and list", () => {
  test("close refuses unknown, replied and closed ids, else closes", async () => {
    const { root, channel, d, add } = setup();
    add("fake:c1:100");
    add("fake:c1:101");
    expect(() => msgClose(root, "fake:c1:999", "x", T0)).toThrow("unknown message id");
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d);
    expect(() => msgClose(root, "fake:c1:100", "x", T0)).toThrow("already replied");
    msgClose(root, "fake:c1:101", "handled in person", T0 + 5);
    expect(channel.ledger().at(-1)).toEqual({ id: "fake:c1:101", ev: "closed", at: T0 + 5, why: "handled in person" });
    expect(() => msgClose(root, "fake:c1:101", "x", T0)).toThrow("already closed");
  });

  test("list shows open ids by default and every id with all, with state, age, sender and escaped text", async () => {
    const { root, channel, d, add } = setup();
    add("fake:c1:100", { text: `line one\nline "two" ${"x".repeat(80)}` });
    add("fake:c1:101");
    add("fake:c1:102");
    add("fake:c1:103");
    channel.appendLedger({ id: "fake:c1:101", ev: "delivered", at: T0, attempt: 1, mode: "followUp" });
    channel.appendLedger({ id: "fake:c1:101", ev: "delivered", at: T0, attempt: 2, mode: "followUp" });
    channel.appendLedger({ id: "fake:c1:103", ev: "gave-up", at: T0, attempts: 3 });
    await msgSend(root, { replyTo: ["fake:c1:102"], text: "hi" }, d);

    const open = msgList(root, {}, T0 + 3 * 3_600_000);
    expect(open).toHaveLength(3);
    expect(open[0]).toBe(`fake:c1:100  open  3h  messenger  u1  ${JSON.stringify(`line one\nline "two" ${"x".repeat(80)}`.slice(0, 60))}`);
    expect(open[0]).not.toContain("\n");
    expect(open[1]).toStartWith("fake:c1:101  delivered 2  3h  messenger  u1  ");
    expect(open[2]).toStartWith("fake:c1:103  gave-up  ");

    const all = msgList(root, { all: true }, T0 + 5 * 60_000);
    expect(all.map((l) => l.split("  ").slice(0, 3).join(" "))).toEqual([
      "fake:c1:100 open 5m",
      "fake:c1:101 delivered 2 5m",
      "fake:c1:102 replied 5m",
      "fake:c1:103 gave-up 5m",
    ]);
  });

  test("watch events: --reply-to refuses them, close closes them, list shows their kind and watch name", async () => {
    const { root, channel, sent, d, add, addWatch } = setup();
    add("fake:c1:100");
    addWatch("w1", 1, "[watch ci w1] build failed");
    await expect(msgSend(root, { replyTo: ["watch:w1:1"], text: "ok" }, d)).rejects.toThrow("watch events need no reply");
    await expect(msgSend(root, { replyTo: ["fake:c1:100", "watch:w1:1"], text: "ok" }, d)).rejects.toThrow(Refusal);
    expect(sent).toEqual([]);
    expect(channel.ledger()).toEqual([]);

    expect(msgList(root, {}, T0)[1]).toBe(`watch:w1:1  open  0m  watch  ci  ${JSON.stringify("[watch ci w1] build failed")}`);
    msgClose(root, "watch:w1:1", "handled", T0 + 5);
    expect(channel.ledger()).toEqual([{ id: "watch:w1:1", ev: "closed", at: T0 + 5, why: "handled" }]);
    expect(msgList(root, {}, T0).map((l) => l.split("  ")[0])).toEqual(["fake:c1:100"]);
  });
});
