import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, type MessengerRow } from "../src/channel.ts";
import { Refusal } from "../src/harness.ts";
import { SendUncertain, type MessengerAdapter, type MessengerConfig, type Reaction, type SendTarget } from "../src/messenger/adapter.ts";
import { msgClose, msgEditReplyOf, msgList, msgSend, msgThread, parseTo, type MsgDeps } from "../src/msg.ts";
import { noActions } from "./fake.ts";

const T0 = 1_700_000_000_000;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "seori-msg-"));
  const channel = new Channel(root);
  const sent: { source: string; target: SendTarget; text: string }[] = [];
  const reacted: { source: string; target: SendTarget; message: string; reaction: Reaction }[] = [];
  const warned: string[] = [];
  let mode: "ok" | "uncertain" | "error" = "ok";
  let reactFails = false;
  let n = 0;
  const adapterFor = (c: MessengerConfig): MessengerAdapter => ({
    ...noActions,
    source: c.source,
    receive: async () => {},
    send: async (target, text) => {
      sent.push({ source: c.source, target, text });
      if (mode === "uncertain") throw new SendUncertain("timed out after sending");
      if (mode === "error") throw new Error("403 forbidden");
      return { messageId: `m${++n}` };
    },
    react: async (target, message, reaction) => {
      if (reactFails) throw new Error("missing_scope");
      reacted.push({ source: c.source, target, message, reaction });
    },
    check: async () => "stub",
  });
  const d: MsgDeps = { adapterFor, configs: [{ source: "fake", owner: "u1" }, { source: "tg", owner: "u1" }], now: () => T0 + 1000, warn: (l) => warned.push(l) };
  const add = (id: string, o: Partial<MessengerRow> = {}) => {
    const [source, chat] = id.split(":");
    channel.appendInbound({ id, kind: "messenger", source: source!, chat: chat!, from: "u1", at: T0, text: `text of ${id}`, ...o });
  };
  const addWatch = (watchId: string, seq: number, text = `event ${seq}`) =>
    channel.appendInbound({ id: `watch:${watchId}:${seq}`, kind: "watch", watchId, name: "ci", at: T0, text });
  return {
    root, channel, sent, reacted, warned, d, add, addWatch,
    setMode: (m: typeof mode) => (mode = m), failReactions: () => (reactFails = true),
  };
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
        ...noActions,
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

  test("a notice that may have reached the messenger is HELD, not a crash; a definite failure still throws", async () => {
    const { root, channel, d, setMode } = setup();
    setMode("uncertain");
    expect(await msgSend(root, { to: parseTo("tg:c5"), text: "heads up" }, d)).toEqual({ status: "HELD", ids: [] });
    setMode("error");
    await expect(msgSend(root, { to: parseTo("tg:c5"), text: "heads up" }, d)).rejects.toThrow("403 forbidden");
    expect(channel.ledger()).toEqual([]);
  });

  test("parseTo", () => {
    expect(parseTo("fake:c1")).toEqual({ source: "fake", chat: "c1" });
    expect(parseTo("fake:c1:a:b")).toEqual({ source: "fake", chat: "c1", thread: "a:b" });
    for (const bad of ["fake", "fake:", ":c1", "fake:c1:"]) expect(() => parseTo(bad)).toThrow(Refusal);
  });

  test("a telegram thread must be a topic id: anything else is refused instead of posting to the General topic", () => {
    expect(parseTo("telegram:-1001:42")).toEqual({ source: "telegram", chat: "-1001", thread: "42" });
    for (const bad of ["telegram:-1001:general", "telegram:-1001:0", "telegram:-1001:042", "telegram:-1001:4.2", "telegram:-1001:99999999999999999"]) {
      expect(() => parseTo(bad)).toThrow(/must be a Telegram topic id/);
    }
  });
});

describe("msg close and list", () => {
  test("list marks a message from someone other than the owner", () => {
    const { root, add } = setup();
    add("fake:c1:100");
    add("fake:c1:101", { from: "u2", notOwner: true });
    expect(msgList(root, {}, T0).map((l) => l.split("  ")[4])).toEqual(["u1", "u2 (not owner)"]);
  });

  test("close refuses unknown, replied and closed ids, else closes", async () => {
    const { root, channel, d, add } = setup();
    add("fake:c1:100");
    add("fake:c1:101");
    await expect(msgClose(root, "fake:c1:999", "x", d)).rejects.toThrow("unknown message id");
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d);
    await expect(msgClose(root, "fake:c1:100", "x", d)).rejects.toThrow("already replied");
    await msgClose(root, "fake:c1:101", "handled in person", { ...d, now: () => T0 + 5 });
    expect(channel.ledger().at(-1)).toEqual({ id: "fake:c1:101", ev: "closed", at: T0 + 5, why: "handled in person" });
    await expect(msgClose(root, "fake:c1:101", "x", d)).rejects.toThrow("already closed");
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
    await msgClose(root, "watch:w1:1", "handled", { ...d, now: () => T0 + 5 });
    expect(channel.ledger()).toEqual([{ id: "watch:w1:1", ev: "closed", at: T0 + 5, why: "handled" }]);
    expect(msgList(root, {}, T0).map((l) => l.split("  ")[0])).toEqual(["fake:c1:100"]);
  });
});

describe("the check mark when a message is answered", () => {
  test("a reply swaps the eyes for the check mark on every id it answers; an --ack reply keeps them until the result", async () => {
    const { root, reacted, d, add } = setup();
    add("fake:c1:100", { thread: "t9" });
    add("fake:c1:101");
    add("fake:c1:102:edit:7");

    expect(await msgSend(root, { replyTo: ["fake:c1:100"], text: "On it.", ack: true }, d)).toMatchObject({ status: "SENT" });
    expect(reacted).toEqual([]);
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "Done: PR merged.", again: true }, d);
    expect(reacted).toEqual([{ source: "fake", target: { chat: "c1", thread: "t9" }, message: "100", reaction: "answered" }]);

    // An edit's id marks the message it edits.
    await msgSend(root, { replyTo: ["fake:c1:101", "fake:c1:102:edit:7"], text: "both" }, d);
    expect(reacted.slice(1).map((r) => r.message)).toEqual(["101", "102"]);
  });

  test("a reply that is not out (held or failed) leaves the eyes; one whose reaction fails still counts as sent", async () => {
    const { root, channel, reacted, warned, d, add, setMode, failReactions } = setup();
    add("fake:c1:100");
    add("fake:c1:101");
    add("fake:c1:102");
    setMode("uncertain");
    expect(await msgSend(root, { replyTo: ["fake:c1:100"], text: "hi" }, d)).toMatchObject({ status: "HELD" });
    setMode("error");
    await expect(msgSend(root, { replyTo: ["fake:c1:101"], text: "hi" }, d)).rejects.toThrow("403 forbidden");
    expect(reacted).toEqual([]);

    setMode("ok");
    failReactions();
    expect(await msgSend(root, { replyTo: ["fake:c1:102"], text: "hi" }, d)).toMatchObject({ status: "SENT", ids: ["fake:c1:102"] });
    expect(channel.ledger().at(-1)).toMatchObject({ id: "fake:c1:102", ev: "replied" });
    expect(warned).toEqual(["seori: fake:c1:102 is answered, but its check mark could not be set: missing_scope"]);
  });

  test("close gives a messenger message the check mark, a watch event none; --ack needs --reply-to", async () => {
    const { root, reacted, d, add, addWatch } = setup();
    add("tg:c5:300");
    addWatch("w1", 1);
    await msgClose(root, "tg:c5:300", "handled in person", d);
    await msgClose(root, "watch:w1:1", "seen", d);
    expect(reacted).toEqual([{ source: "tg", target: { chat: "c5" }, message: "300", reaction: "answered" }]);
    await expect(msgSend(root, { to: parseTo("tg:c5"), text: "heads up", ack: true }, d)).rejects.toThrow("--ack");
  });
});

/** setup() whose messengers can open, name and edit threads (Discord's), recording each call. */
function withThreads() {
  const s = setup();
  const opened: { chat: string; message: string; name: string }[] = [];
  const edits: { thread: string; edit: { name?: string; archived: boolean } }[] = [];
  const msgEdits: { target: SendTarget; message: string; text: string }[] = [];
  const names: Record<string, string> = {};
  let open: "thread" | "none" | "error" = "thread";
  const d: MsgDeps = {
    ...s.d,
    adapterFor: (c) => ({
      ...s.d.adapterFor(c),
      edit: async (target, message, text) => void msgEdits.push({ target, message, text }),
      openThread: async (chat, message, name) => {
        if (open === "error") throw new Error("50013 Missing Permissions");
        opened.push({ chat, message, name });
        return open === "thread" ? `T${message}` : undefined;
      },
      threadName: async (thread) => names[thread] ?? "",
      editThread: async (thread, edit) => void edits.push({ thread, edit }),
    }),
  };
  return { ...s, d, opened, edits, msgEdits, names, openWith: (m: typeof open) => (open = m) };
}

describe("job threads", () => {
  test("the first --ack on a channel message opens its thread before the reply goes out; every later reply and edit goes there", async () => {
    const { root, channel, sent, reacted, d, add, opened, msgEdits } = withThreads();
    add("fake:c1:100");
    add("fake:c1:101");
    const r = await msgSend(root, { replyTo: ["fake:c1:100", "fake:c1:101"], text: "⏳ fix login · 0m", ack: true, title: "fix login" }, d);
    expect(r).toEqual({ status: "SENT", messageId: "m1", ids: ["fake:c1:100", "fake:c1:101"], thread: "T100" });
    expect(opened).toEqual([{ chat: "c1", message: "100", name: "🔄 fix login" }]);
    expect(channel.ledger().slice(0, 3)).toEqual([
      { id: "fake:c1:100", ev: "thread", at: T0 + 1000, thread: "T100", title: "fix login" },
      { id: "fake:c1:101", ev: "thread", at: T0 + 1000, thread: "T100", title: "fix login" },
      { id: "fake:c1:100", ev: "sending", at: T0 + 1000 },
    ]);

    await msgEditReplyOf(root, "fake:c1:100", "⏳ fix login · 5m", d);
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "Done: PR merged.", again: true }, d);
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "One more thing.", again: true, ack: true }, d);
    expect(sent.map((x) => x.target)).toEqual([{ chat: "c1", thread: "T100" }, { chat: "c1", thread: "T100" }, { chat: "c1", thread: "T100" }]);
    expect(msgEdits).toEqual([{ target: { chat: "c1", thread: "T100" }, message: "m1", text: "⏳ fix login · 5m" }]);
    expect(opened.length).toBe(1);
    // The check mark still goes on the request itself, in its channel.
    expect(reacted).toEqual([{ source: "fake", target: { chat: "c1" }, message: "100", reaction: "answered" }]);
  });

  test("no thread for a message in a thread, where the messenger opens none, after a first reply, or when the open fails", async () => {
    const { root, channel, sent, warned, d, add, opened, openWith } = withThreads();
    add("fake:t5:200", { root: "fake:c1:t5", rootByOwner: true });
    add("fake:d1:201");
    add("fake:c1:202");
    add("fake:c1:203");
    await msgSend(root, { replyTo: ["fake:t5:200"], text: "on it", ack: true }, d);
    openWith("none"); // a DM
    await msgSend(root, { replyTo: ["fake:d1:201"], text: "on it\nmore below", ack: true }, d);
    openWith("thread");
    await msgSend(root, { replyTo: ["fake:c1:202"], text: "quick answer" }, d);
    await msgSend(root, { replyTo: ["fake:c1:202"], text: "now a job", again: true, ack: true }, d);
    openWith("error");
    await msgSend(root, { replyTo: ["fake:c1:203"], text: "on it", ack: true }, d);
    expect(opened).toEqual([{ chat: "d1", message: "201", name: "🔄 on it" }]);
    expect(sent.map((x) => x.target)).toEqual([
      { chat: "t5", replyTo: "200" },
      { chat: "d1", replyTo: "201" },
      { chat: "c1", replyTo: "202" },
      { chat: "c1", replyTo: "202" },
      { chat: "c1", replyTo: "203" },
    ]);
    expect(channel.ledger().some((e) => e.ev === "thread")).toBe(false);
    expect(warned).toEqual(["seori: no thread opened for fake:c1:203; the acknowledgement goes where it was written: 50013 Missing Permissions"]);
    await expect(msgSend(root, { replyTo: ["fake:c1:203"], text: "x", title: "t" }, d)).rejects.toThrow("--title names the thread an acknowledgement opens; it needs --ack");
    // A messenger without threads keeps today's reply.
    await msgSend(root, { replyTo: ["fake:c1:203"], text: "on it", ack: true, again: true }, setup().d);
  });

  test("msg thread renames with the status emoji and the recorded title, archives, and takes a thread the message was written in", async () => {
    const { root, channel, d, add, edits, names } = withThreads();
    add("fake:c1:100");
    add("fake:t5:200", { root: "fake:c1:t5", rootByOwner: true });
    add("fake:c1:300");
    await msgSend(root, { replyTo: ["fake:c1:100"], text: "on it", ack: true, title: "fix login" }, d);

    expect(await msgThread(root, "fake:c1:100", { status: "waiting" }, d)).toEqual({ thread: "T100", name: "⏸ fix login" });
    expect(await msgThread(root, "fake:c1:100", { status: "done", title: "fix login flow", archive: true }, d)).toEqual({ thread: "T100", name: "✅ fix login flow" });
    expect(channel.jobThread("fake:c1:100")).toEqual({ thread: "T100", title: "fix login flow" });
    expect(await msgThread(root, "fake:c1:100", { archive: true }, d)).toEqual({ thread: "T100" });

    // The owner's own thread: the title comes from its name, and a missing status keeps its emoji.
    names["t5"] = "✅ deploy";
    expect(await msgThread(root, "fake:t5:200", { status: "working" }, d)).toEqual({ thread: "t5", name: "🔄 deploy" });
    expect(await msgThread(root, "fake:t5:200", { title: "deploy v2" }, d)).toEqual({ thread: "t5", name: "✅ deploy v2" });
    expect(edits).toEqual([
      { thread: "T100", edit: { name: "⏸ fix login", archived: false } },
      { thread: "T100", edit: { name: "✅ fix login flow", archived: true } },
      { thread: "T100", edit: { archived: true } },
      { thread: "t5", edit: { name: "🔄 deploy", archived: false } },
      { thread: "t5", edit: { name: "✅ deploy v2", archived: false } },
    ]);

    await expect(msgThread(root, "fake:c1:300", { status: "done" }, d)).rejects.toThrow("fake:c1:300 has no thread");
    await expect(msgThread(root, "fake:c1:100", {}, d)).rejects.toThrow("give --status, --title or --archive");
    await expect(msgThread(root, "fake:c1:100", { status: "done" }, setup().d)).rejects.toThrow("fake has no threads seori can rename or archive");
  });
});
