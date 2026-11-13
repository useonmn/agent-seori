import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InboundMessage, SendUncertain } from "../src/messenger/adapter.ts";
import { DiscordAdapter } from "../src/messenger/discord.ts";
import { FAKE_BOT_ID, FakeAdapter } from "../src/messenger/fake.ts";
import { adapterFor } from "../src/messenger/index.ts";
import { SlackAdapter } from "../src/messenger/slack.ts";
import { TelegramAdapter } from "../src/messenger/telegram.ts";

const home = () => mkdtempSync(join(tmpdir(), "seori-fake-"));
const row = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`;

/** Runs receive until `want` messages arrived (or onMessage throws, or `ms` passed), then aborts and returns them. */
async function collect(a: FakeAdapter, want: number, onMessage: (m: InboundMessage) => Promise<void> = async () => {}, ms = 2_000) {
  const ac = new AbortController();
  const got: InboundMessage[] = [];
  const run = a.receive(ac.signal, async (m) => {
    await onMessage(m);
    got.push(m);
    if (got.length >= want) ac.abort();
  });
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    await run;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return got;
}

describe("FakeAdapter receive", () => {
  test("emits fake:<chat>:<msgId> ids in order and commits the offset after each message", async () => {
    const root = home();
    const a = new FakeAdapter(root, { pollMs: 5, now: () => 42 });
    appendFileSync(a.inPath, row({ msgId: "1", chat: "c1", from: "u1", text: "hi", at: 7 }) + row({ msgId: "2", chat: "c1", thread: "t", from: "u1", text: "yo" }));
    const got = await collect(a, 2);
    expect(got).toEqual([
      { id: "fake:c1:1", source: "fake", chat: "c1", from: "u1", sender: { kind: "person", id: "u1" }, at: 7, text: "hi" },
      { id: "fake:c1:2", source: "fake", chat: "c1", thread: "t", from: "u1", sender: { kind: "person", id: "u1" }, at: 42, text: "yo" },
    ]);
    expect(a.offset()).toBe(2);
    expect(await collect(a, 1, undefined, 50)).toEqual([]); // nothing replays once committed: 10 polls find nothing
  });

  test("a rejected onMessage leaves the offset uncommitted, so the message is offered again", async () => {
    const root = home();
    const a = new FakeAdapter(root, { pollMs: 5 });
    appendFileSync(a.inPath, row({ msgId: "1", chat: "c", from: "u1", text: "hi" }));
    const ac = new AbortController();
    await expect(a.receive(ac.signal, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(a.offset()).toBe(0);
    expect((await collect(a, 1)).map((m) => m.id)).toEqual(["fake:c:1"]);
    expect(a.offset()).toBe(1);
  });

  test("picks up rows appended while running, skips malformed lines and waits for an unterminated one", async () => {
    const root = home();
    const a = new FakeAdapter(root, { pollMs: 5 });
    const partial = JSON.stringify({ msgId: "9", chat: "c", from: "u1", text: "partial" });
    appendFileSync(a.inPath, "not json\n" + row({ chat: "c", from: "u1", text: "no id" }) + row({ msgId: "8", chat: "c", from: "u1", text: "first" }) + partial);
    // Row 9's newline and row 10 arrive only after message 8 was handled, i.e. while receive is already polling.
    const got = await collect(a, 3, async (m) => {
      if (m.id === "fake:c:8") appendFileSync(a.inPath, "\n" + row({ msgId: "10", chat: "c", from: "u1", text: "next" }));
    });
    expect(got.map((m) => m.id)).toEqual(["fake:c:8", "fake:c:9", "fake:c:10"]);
    expect(a.offset()).toBe(5);
  });
});

describe("FakeAdapter send", () => {
  test("ok returns increasing message ids and writes out.jsonl", async () => {
    const a = new FakeAdapter(home(), { now: () => 5 });
    expect(await a.send({ chat: "c", replyTo: "fake:c:1" }, "one")).toEqual({ messageId: "1" });
    expect(await a.send({ chat: "c", thread: "t" }, "two")).toEqual({ messageId: "2" });
    expect(a.sent()).toEqual([
      { messageId: "1", chat: "c", replyTo: "fake:c:1", text: "one", at: 5 },
      { messageId: "2", chat: "c", thread: "t", text: "two", at: 5 },
    ]);
  });

  test("timeout writes out.jsonl and then throws SendUncertain", async () => {
    const a = new FakeAdapter(home());
    writeFileSync(a.sendModePath, "timeout\n");
    await expect(a.send({ chat: "c" }, "maybe")).rejects.toBeInstanceOf(SendUncertain);
    expect(a.sent().map((r) => r.text)).toEqual(["maybe"]);
  });

  test("error throws a plain Error and sends nothing", async () => {
    const a = new FakeAdapter(home());
    writeFileSync(a.sendModePath, "error");
    const err = await a.send({ chat: "c" }, "no").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SendUncertain);
    expect(a.sent()).toEqual([]);
    writeFileSync(a.sendModePath, "ok");
    expect(await a.send({ chat: "c" }, "yes")).toEqual({ messageId: "1" });
    expect(readFileSync(a.outPath, "utf8")).toContain('"yes"');
  });
});

describe("adapterFor", () => {
  test("each platform gets its adapter; an unknown source is refused", () => {
    const root = home();
    expect(adapterFor({ source: "fake", owner: "u1" }, root)).toBeInstanceOf(FakeAdapter);
    expect(adapterFor({ source: "telegram", owner: "1" }, root)).toBeInstanceOf(TelegramAdapter);
    expect(adapterFor({ source: "slack", owner: "U1" }, root)).toBeInstanceOf(SlackAdapter);
    expect(adapterFor({ source: "discord", owner: "1" }, root)).toBeInstanceOf(DiscordAdapter);
    expect(() => adapterFor({ source: "kakao", owner: "u1" }, root)).toThrow("messenger kakao is not supported");
  });
});

describe("FakeAdapter delivery rules", () => {
  test("labels senders, drops the bot's own rows and passes others only by DM, mention or a joined thread", async () => {
    const root = home();
    const a = new FakeAdapter(root, { pollMs: 5, owner: "u1", now: () => 1 });
    await a.send({ chat: "c", thread: "joined" }, "seori was here");
    appendFileSync(
      a.inPath,
      row({ msgId: "1", chat: "c", from: "u1", text: "owner, no mention" }) +
        row({ msgId: "2", chat: "c", from: FAKE_BOT_ID, text: "own message" }) +
        row({ msgId: "3", chat: "c", from: "u2", text: "no mention" }) +
        row({ msgId: "4", chat: "c", from: "u2", name: "Bob", text: "@seori", mentions: true }) +
        row({ msgId: "5", chat: "c", thread: "4", from: "u3", text: "in the thread of a mention" }) +
        row({ msgId: "6", chat: "c", thread: "joined", from: "b1", bot: true, text: "agent in a joined thread" }) +
        row({ msgId: "7", chat: "d", dm: true, from: "b2", bot: true, text: "agent DM" }) +
        row({ msgId: "8", chat: "c", thread: "x", from: "u2", text: "unjoined thread" }),
    );
    const got = await collect(a, 5);
    expect(got.map((m) => [m.id, m.sender])).toEqual([
      ["fake:c:1", { kind: "owner", id: "u1" }],
      ["fake:c:4", { kind: "person", id: "u2", name: "Bob" }],
      ["fake:c:5", { kind: "person", id: "u3" }],
      ["fake:c:6", { kind: "agent", id: "b1" }],
      ["fake:d:7", { kind: "agent", id: "b2" }],
    ]);
  });

  test("adapterFor gives the fake adapter its owner", async () => {
    const root = home();
    const a = adapterFor({ source: "fake", owner: "u1", options: { pollMs: 5 } }, root) as FakeAdapter;
    appendFileSync(a.inPath, row({ msgId: "1", chat: "c", from: "u2", text: "no mention" }) + row({ msgId: "2", chat: "c", from: "u1", text: "owner" }));
    expect((await collect(a, 1)).map((m) => m.id)).toEqual(["fake:c:2"]);
  });
});
