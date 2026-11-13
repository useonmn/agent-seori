import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadName } from "../src/messenger/adapter.ts";
import { DiscordAdapter } from "../src/messenger/discord.ts";
import { SlackAdapter } from "../src/messenger/slack.ts";
import { TelegramAdapter } from "../src/messenger/telegram.ts";

// The actions beyond send (react, edit, typing, thread name and state) on each platform, against an HTTP stand-in that
// records every call: the platform API is mocked at the HTTP boundary only.

type Call = { method: string; path: string; body: unknown };
type Answer = (c: Call) => Response | undefined;

let servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

/** Records every request; `answer` may reply, otherwise `fallback` does. */
function recorder(fallback: Answer) {
  const calls: Call[] = [];
  const answers: Answer[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const call: Call = { method: req.method, path: decodeURIComponent(url.pathname), body: text ? JSON.parse(text) : undefined };
      calls.push(call);
      for (const a of answers) {
        const r = a(call);
        if (r) return r;
      }
      return fallback(call) ?? new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { calls, answers, base: `http://127.0.0.1:${server.port}` };
}

const home = () => mkdtempSync(join(tmpdir(), "seori-actions-"));
const noSleep = async () => {};

describe("threadName", () => {
  test("puts the status emoji in front and replaces one already there", () => {
    expect(threadName("Fix login", "working")).toBe("🔄 Fix login");
    expect(threadName("✅ Fix login", "waiting")).toBe("⏸ Fix login");
    expect(threadName("🔄 Fix login", undefined)).toBe("🔄 Fix login");
    expect(threadName("  Fix login ", "done")).toBe("✅ Fix login");
  });
});

describe("Telegram actions", () => {
  const setup = () => {
    const r = recorder((c) => Response.json({ ok: true, result: c.path.endsWith("/sendChatAction") || c.path.endsWith("Topic") || c.path.endsWith("Reaction") ? true : { message_id: 5 } }));
    const a = new TelegramAdapter({ source: "telegram", owner: "42", options: { apiBase: r.base } }, home(), { env: { SEORI_TELEGRAM_TOKEN: "1:t" }, sleep: noSleep });
    const method = (c: Call) => c.path.split("/").at(-1);
    return { ...r, a, sent: () => r.calls.map((c) => [method(c), c.body]) };
  };

  test("react sets and clears the eyes reaction", async () => {
    const t = setup();
    await t.a.react("42", "7", true);
    await t.a.react("42", "7", false);
    expect(t.sent()).toEqual([
      ["setMessageReaction", { chat_id: "42", message_id: 7, reaction: [{ type: "emoji", emoji: "👀" }] }],
      ["setMessageReaction", { chat_id: "42", message_id: 7, reaction: [] }],
    ]);
  });

  test("edit replaces the text; an unchanged text is fine; too long is refused before any request", async () => {
    const t = setup();
    await t.a.edit({ chat: "42", thread: "9" }, "5", "⏳ Fix login · 3m");
    expect(t.sent()).toEqual([["editMessageText", { chat_id: "42", message_id: 5, text: "⏳ Fix login · 3m", link_preview_options: { is_disabled: true } }]]);
    t.answers.push(() => Response.json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, { status: 400 }));
    await t.a.edit({ chat: "42" }, "5", "same");
    await expect(t.a.edit({ chat: "42" }, "5", "x".repeat(4097))).rejects.toThrow(/4096/);
    expect(t.calls).toHaveLength(2);
  });

  test("a refused edit is an error with Telegram's reason", async () => {
    const t = setup();
    t.answers.push(() => Response.json({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, { status: 400 }));
    await expect(t.a.edit({ chat: "42" }, "5", "x")).rejects.toThrow(/message to edit not found/);
  });

  test("typing goes to the topic", async () => {
    const t = setup();
    expect(await t.a.typing({ chat: "42", thread: "9" })).toEqual([]);
    expect(t.sent()).toEqual([["sendChatAction", { chat_id: "42", action: "typing", message_thread_id: 9 }]]);
  });

  test("thread renames the topic with its status and closes or reopens it in a forum supergroup", async () => {
    const t = setup();
    expect(await t.a.thread({ chat: "-100", thread: "9" }, { name: "🔄 Fix login", status: "done", state: "close" })).toEqual({ name: "✅ Fix login", state: "close", notes: [] });
    expect(await t.a.thread({ chat: "-100", thread: "9" }, { state: "reopen" })).toEqual({ state: "reopen", notes: [] });
    expect(t.sent()).toEqual([
      ["editForumTopic", { chat_id: "-100", message_thread_id: 9, name: "✅ Fix login" }],
      ["closeForumTopic", { chat_id: "-100", message_thread_id: 9 }],
      ["reopenForumTopic", { chat_id: "-100", message_thread_id: 9 }],
    ]);
  });

  test("an unchanged topic is fine; a private chat cannot close a topic and says so", async () => {
    const t = setup();
    t.answers.push((c) => (c.path.endsWith("editForumTopic") ? Response.json({ ok: false, error_code: 400, description: "Bad Request: TOPIC_NOT_MODIFIED" }, { status: 400 }) : undefined));
    expect(await t.a.thread({ chat: "42", thread: "9" }, { name: "Fix login", status: "done", state: "close" })).toEqual({
      name: "✅ Fix login",
      notes: ["telegram: a topic in a private chat cannot be closed or reopened; the ✅ at the start of its name marks it done"],
    });
    expect(t.sent().map(([m]) => m)).toEqual(["editForumTopic"]);
  });

  test("a message outside a topic has no thread to change, and says so", async () => {
    const t = setup();
    expect(await t.a.thread({ chat: "42", message: "5" }, { name: "x", status: "working" })).toEqual({
      notes: ["telegram: the message is not in a topic, so there is no topic to rename or close; the status message carries the status"],
    });
    expect(t.calls).toEqual([]);
  });
});

describe("Discord actions", () => {
  const setup = (channelType = 11, archived = false) => {
    const r = recorder((c) => {
      if (c.method === "GET" && /^\/api\/channels\/[^/]+$/.test(c.path)) return Response.json({ id: c.path.split("/").at(-1), type: channelType, thread_metadata: { archived } });
      if (c.method === "PATCH") return Response.json({ id: "x" });
      return new Response(null, { status: 204 });
    });
    const a = new DiscordAdapter({ source: "discord", owner: "42", options: { apiBase: `${r.base}/api` } }, home(), { env: { SEORI_DISCORD_TOKEN: "T0K" }, sleep: noSleep });
    return { ...r, a, sent: () => r.calls.map((c) => [c.method, c.path, c.body]) };
  };

  test("react puts and deletes the bot's own eyes reaction", async () => {
    const t = setup();
    await t.a.react("C1", "55", true);
    await t.a.react("C1", "55", false);
    expect(t.sent()).toEqual([
      ["PUT", "/api/channels/C1/messages/55/reactions/👀/@me", undefined],
      ["DELETE", "/api/channels/C1/messages/55/reactions/👀/@me", undefined],
    ]);
  });

  test("edit patches the message in its thread without pings; too long is refused; typing posts to the thread", async () => {
    const t = setup();
    await t.a.edit({ chat: "C1", thread: "T9" }, "55", "✅ Fix login");
    expect(await t.a.typing({ chat: "C1", thread: "T9" })).toEqual([]);
    await expect(t.a.edit({ chat: "C1" }, "55", "x".repeat(2001))).rejects.toThrow(/2000/);
    expect(t.sent()).toEqual([
      ["PATCH", "/api/channels/T9/messages/55", { content: "✅ Fix login", allowed_mentions: { parse: [] } }],
      ["POST", "/api/channels/T9/typing", undefined],
    ]);
  });

  test("thread renames and archives a thread, and unarchives it on reopen", async () => {
    const t = setup();
    expect(await t.a.thread({ chat: "T9" }, { name: "Fix login", status: "waiting" })).toEqual({ name: "⏸ Fix login", notes: [] });
    expect(await t.a.thread({ chat: "C1", thread: "T9" }, { name: "Fix login", status: "done", state: "close" })).toEqual({ name: "✅ Fix login", state: "close", notes: [] });
    expect(await t.a.thread({ chat: "T9" }, { state: "reopen", status: "working", name: "Fix login" })).toEqual({ name: "🔄 Fix login", state: "reopen", notes: [] });
    expect(t.sent().filter(([m]) => m === "PATCH")).toEqual([
      ["PATCH", "/api/channels/T9", { name: "⏸ Fix login" }],
      ["PATCH", "/api/channels/T9", { name: "✅ Fix login", archived: true }],
      ["PATCH", "/api/channels/T9", { name: "🔄 Fix login", archived: false }],
    ]);
  });

  test("a channel that is not a thread (a DM, a server channel) is never renamed, and says so", async () => {
    const t = setup(1);
    expect(await t.a.thread({ chat: "D1" }, { name: "Fix login", status: "working" })).toEqual({
      notes: ["discord: channel D1 is not a thread, so there is no thread to rename or close; the status message carries the status"],
    });
    expect(t.sent().map(([m]) => m)).toEqual(["GET"]);
  });
});

describe("Discord action limits", () => {
  const setup = (archived: boolean) => {
    const sleeps: number[] = [];
    const r = recorder((c) => {
      if (c.method === "GET") return Response.json({ id: "T9", type: 11, thread_metadata: { archived } });
      return Response.json({ id: "x" });
    });
    const a = new DiscordAdapter({ source: "discord", owner: "42", options: { apiBase: `${r.base}/api` } }, home(), {
      env: { SEORI_DISCORD_TOKEN: "T0K" },
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { ...r, a, sleeps };
  };

  test("a long rate limit fails at once with when to retry, instead of waiting it out", async () => {
    const t = setup(false);
    t.answers.push((c) => (c.method === "PATCH" ? Response.json({ message: "You are being rate limited.", retry_after: 300, global: false }, { status: 429 }) : undefined));
    await expect(t.a.thread({ chat: "T9" }, { name: "Fix login", status: "done" })).rejects.toThrow(/retry after 300 s/);
    expect(t.sleeps).toEqual([]);
    expect(t.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  test("a short rate limit is waited out and retried", async () => {
    const t = setup(false);
    let first = true;
    t.answers.push((c) => {
      if (c.method !== "PATCH" || !first) return undefined;
      first = false;
      return Response.json({ retry_after: 2, global: false }, { status: 429 });
    });
    expect(await t.a.thread({ chat: "T9" }, { name: "Fix login" })).toEqual({ name: "Fix login", notes: [] });
    expect(t.sleeps).toEqual([2000]);
  });

  test("a closed thread is not renamed without --reopen or --close, and says so", async () => {
    const t = setup(true);
    expect(await t.a.thread({ chat: "T9" }, { name: "Fix login", status: "working" })).toEqual({
      notes: ["discord: thread T9 is closed; pass --reopen to rename it"],
    });
    expect(t.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  test("closing a closed thread is already done; renaming it with --close reopens, renames and closes it again", async () => {
    const t = setup(true);
    expect(await t.a.thread({ chat: "T9" }, { state: "close" })).toEqual({ state: "close", notes: [] });
    expect(t.calls.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(await t.a.thread({ chat: "T9" }, { name: "Fix login", status: "done", state: "close" })).toEqual({ name: "✅ Fix login", state: "close", notes: [] });
    expect(t.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ name: "✅ Fix login", archived: false }, { archived: true }]);
  });

  test("ids are path segments, never paths: slashes are encoded and dot segments refused", async () => {
    const t = setup(false);
    await t.a.react("../../guilds/1", "5", true);
    expect(t.calls[0]!.path).toBe("/api/channels/../../guilds/1/messages/5/reactions/👀/@me");
    await expect(t.a.edit({ chat: "C1" }, "..", "x")).rejects.toThrow(/".." is not an id/);
    await expect(t.a.thread({ chat: "." }, { state: "close" })).rejects.toThrow(/"." is not an id/);
    expect(t.calls).toHaveLength(1);
  });
});

describe("Slack actions", () => {
  const setup = () => {
    const r = recorder(() => Response.json({ ok: true }));
    const a = new SlackAdapter({ source: "slack", owner: "U1", options: { apiBase: `${r.base}/api` } }, home(), {
      env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" },
      sleep: noSleep,
    });
    return { ...r, a, sent: () => r.calls.map((c) => [c.path.replace("/api/", ""), c.body]) };
  };

  test("react adds and removes eyes; already there or already gone is fine", async () => {
    const t = setup();
    await t.a.react("D1", "1700000000.000100", true);
    await t.a.react("D1", "1700000000.000100", false);
    t.answers.push((c) => Response.json({ ok: false, error: c.path.endsWith("add") ? "already_reacted" : "no_reaction" }));
    await t.a.react("D1", "1700000000.000100", true);
    await t.a.react("D1", "1700000000.000100", false);
    expect(t.sent().slice(0, 2)).toEqual([
      ["reactions.add", { channel: "D1", timestamp: "1700000000.000100", name: "eyes" }],
      ["reactions.remove", { channel: "D1", timestamp: "1700000000.000100", name: "eyes" }],
    ]);
  });

  test("a refused reaction is an error naming Slack's reason", async () => {
    const t = setup();
    t.answers.push(() => Response.json({ ok: false, error: "message_not_found" }));
    await expect(t.a.react("D1", "1", true)).rejects.toThrow(/message_not_found/);
  });

  test("edit updates the message with mentions escaped; too long is refused", async () => {
    const t = setup();
    await t.a.edit({ chat: "C1", thread: "1700000000.000001" }, "1700000000.000009", "<!channel> ✅ done");
    await expect(t.a.edit({ chat: "C1" }, "1", "x".repeat(3901))).rejects.toThrow(/3900/);
    expect(t.sent()).toEqual([["chat.update", { channel: "C1", ts: "1700000000.000009", text: "&lt;!channel&gt; ✅ done" }]]);
  });

  test("typing is not available to Slack bots and says so without a request", async () => {
    const t = setup();
    expect(await t.a.typing({ chat: "D1" })).toEqual(["slack: bots have no typing indicator (in agent mode seori shows its own working status)"]);
    expect(t.calls).toEqual([]);
  });

  test("thread status is one reaction on the thread's first message; names and closing are not possible", async () => {
    const t = setup();
    t.answers.push((c) => (c.path.endsWith("reactions.remove") ? Response.json({ ok: false, error: "no_reaction" }) : undefined));
    expect(await t.a.thread({ chat: "C1", message: "1700000000.000100" }, { name: "Fix login", status: "done", state: "close" })).toEqual({
      status: "done",
      notes: [
        "slack: threads have no names; the status is shown as a reaction on the thread's first message",
        "slack: threads cannot be closed or reopened; the ✅ reaction marks it done",
      ],
    });
    expect(t.sent()).toEqual([
      ["reactions.remove", { channel: "C1", timestamp: "1700000000.000100", name: "arrows_counterclockwise" }],
      ["reactions.remove", { channel: "C1", timestamp: "1700000000.000100", name: "double_vertical_bar" }],
      ["reactions.add", { channel: "C1", timestamp: "1700000000.000100", name: "white_check_mark" }],
    ]);
  });

  test("a long rate limit fails at once with when to retry, whether Slack answers ratelimited or 429", async () => {
    const sleeps: number[] = [];
    const r = recorder(() => Response.json({ ok: true }));
    const a = new SlackAdapter({ source: "slack", owner: "U1", options: { apiBase: `${r.base}/api` } }, home(), {
      env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" },
      sleep: async (ms) => void sleeps.push(ms),
    });
    r.answers.push(() => Response.json({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "300" } }));
    await expect(a.react("D1", "1", true)).rejects.toThrow(/retry after 300 s/);
    r.answers.length = 0;
    r.answers.push(() => Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "120" } }));
    await expect(a.edit({ chat: "D1" }, "1", "x")).rejects.toThrow(/retry after 120 s/);
    expect(sleeps).toEqual([]);
    expect(r.calls).toHaveLength(2);
  });

  test("no thread and no message is a NOTE like on the other platforms", async () => {
    const t = setup();
    expect(await t.a.thread({ chat: "C1" }, { status: "working" })).toEqual({ notes: ["slack: no thread or message given, so there is no thread to mark; the status message carries the status"] });
    expect(t.calls).toEqual([]);
  });

  test("the thread root wins over the message the thread was asked from", async () => {
    const t = setup();
    await t.a.thread({ chat: "C1", thread: "1700000000.000001", message: "1700000000.000100" }, { status: "working" });
    expect(t.sent().map(([, b]) => (b as { timestamp: string }).timestamp)).toEqual(["1700000000.000001", "1700000000.000001", "1700000000.000001"]);
  });
});
