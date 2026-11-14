import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordAdapter } from "../src/messenger/discord.ts";
import { SlackAdapter } from "../src/messenger/slack.ts";
import { TelegramAdapter } from "../src/messenger/telegram.ts";

// Editing a message seori sent, and seori's reactions, on each platform, against an HTTP stand-in that records every
// call: the platform API is mocked at the HTTP boundary only.

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

const home = () => mkdtempSync(join(tmpdir(), "seori-edit-"));
const noSleep = async () => {};

describe("Telegram edit", () => {
  const setup = () => {
    const r = recorder(() => Response.json({ ok: true, result: { message_id: 5 } }));
    const a = new TelegramAdapter({ source: "telegram", owner: "42", options: { apiBase: r.base } }, home(), { env: { SEORI_TELEGRAM_TOKEN: "1:t" }, sleep: noSleep });
    const method = (c: Call) => c.path.split("/").at(-1);
    return { ...r, a, sent: () => r.calls.map((c) => [method(c), c.body]) };
  };

  test("edit replaces the text; an unchanged text is fine; too long is refused before any request", async () => {
    const t = setup();
    await t.a.edit({ chat: "42", thread: "9" }, "5", "Fix login, 3m");
    expect(t.sent()).toEqual([["editMessageText", { chat_id: "42", message_id: 5, text: "Fix login, 3m", link_preview_options: { is_disabled: true } }]]);
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

  test("react sets the eyes, then replaces them with 👌 (✅ is not an allowed reaction); a refusal is an error", async () => {
    const t = setup();
    await t.a.react({ chat: "42", thread: "9" }, "5", "read");
    await t.a.react({ chat: "42" }, "5", "answered");
    expect(t.sent()).toEqual([
      ["setMessageReaction", { chat_id: "42", message_id: 5, reaction: [{ type: "emoji", emoji: "👀" }] }],
      ["setMessageReaction", { chat_id: "42", message_id: 5, reaction: [{ type: "emoji", emoji: "👌" }] }],
    ]);
    t.answers.push(() => Response.json({ ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" }, { status: 400 }));
    await expect(t.a.react({ chat: "42" }, "5", "read")).rejects.toThrow(/REACTION_INVALID/);
  });
});

describe("Discord edit", () => {
  const setup = () => {
    const sleeps: number[] = [];
    const r = recorder(() => Response.json({ id: "x" }));
    const a = new DiscordAdapter({ source: "discord", owner: "42", options: { apiBase: `${r.base}/api` } }, home(), {
      env: { SEORI_DISCORD_TOKEN: "T0K" },
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { ...r, a, sleeps, sent: () => r.calls.map((c) => [c.method, c.path, c.body]) };
  };

  test("edit patches the message in its thread without pings; too long is refused", async () => {
    const t = setup();
    await t.a.edit({ chat: "C1", thread: "T9" }, "55", "Fix login: done");
    await expect(t.a.edit({ chat: "C1" }, "55", "x".repeat(2001))).rejects.toThrow(/2000/);
    expect(t.sent()).toEqual([["PATCH", "/api/channels/T9/messages/55", { content: "Fix login: done", allowed_mentions: { parse: [] } }]]);
  });

  test("a long rate limit fails at once with when to retry; a short one is waited out and retried", async () => {
    const t = setup();
    t.answers.push(() => Response.json({ message: "You are being rate limited.", retry_after: 300, global: false }, { status: 429 }));
    await expect(t.a.edit({ chat: "C1" }, "55", "x")).rejects.toThrow(/retry after 300 s/);
    expect(t.sleeps).toEqual([]);
    t.answers.length = 0;
    let first = true;
    t.answers.push(() => {
      if (!first) return undefined;
      first = false;
      return Response.json({ retry_after: 2, global: false }, { status: 429 });
    });
    await t.a.edit({ chat: "C1" }, "55", "x");
    expect(t.sleeps).toEqual([2000]);
  });

  test("ids are path segments, never paths: slashes are encoded and dot segments refused", async () => {
    const t = setup();
    await t.a.edit({ chat: "../../guilds/1" }, "5", "x");
    expect(t.calls[0]!.path).toBe("/api/channels/../../guilds/1/messages/5");
    await expect(t.a.edit({ chat: "C1" }, "..", "x")).rejects.toThrow(/".." is not an id/);
    expect(t.calls).toHaveLength(1);
  });

  test("react: the bot's own eyes; the check mark goes on, then the eyes come off, in the message's thread", async () => {
    const t = setup();
    t.answers.push(() => new Response(null, { status: 204 }));
    await t.a.react({ chat: "C1" }, "55", "read");
    await t.a.react({ chat: "C1", thread: "T9" }, "55", "answered");
    expect(t.sent()).toEqual([
      ["PUT", "/api/channels/C1/messages/55/reactions/👀/@me", undefined],
      ["PUT", "/api/channels/T9/messages/55/reactions/✅/@me", undefined],
      ["DELETE", "/api/channels/T9/messages/55/reactions/👀/@me", undefined],
    ]);
    t.answers.length = 0;
    t.answers.push(() => Response.json({ message: "Missing Permissions", code: 50013 }, { status: 403 }));
    await expect(t.a.react({ chat: "C1" }, "55", "read")).rejects.toThrow(/Missing Permissions/);
  });
});

describe("Slack edit", () => {
  const setup = () => {
    const sleeps: number[] = [];
    const r = recorder(() => Response.json({ ok: true }));
    const a = new SlackAdapter({ source: "slack", owner: "U1", options: { apiBase: `${r.base}/api` } }, home(), {
      env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" },
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { ...r, a, sleeps, sent: () => r.calls.map((c) => [c.path.replace("/api/", ""), c.body]) };
  };

  test("edit updates the message with mentions escaped; too long is refused", async () => {
    const t = setup();
    await t.a.edit({ chat: "C1", thread: "1700000000.000001" }, "1700000000.000009", "<!channel> done");
    await expect(t.a.edit({ chat: "C1" }, "1", "x".repeat(3901))).rejects.toThrow(/3900/);
    expect(t.sent()).toEqual([["chat.update", { channel: "C1", ts: "1700000000.000009", text: "&lt;!channel&gt; done" }]]);
  });

  test("a long rate limit fails at once with when to retry, whether Slack answers ratelimited or 429", async () => {
    const t = setup();
    t.answers.push(() => Response.json({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "300" } }));
    await expect(t.a.edit({ chat: "D1" }, "1", "x")).rejects.toThrow(/retry after 300 s/);
    t.answers.length = 0;
    t.answers.push(() => Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "120" } }));
    await expect(t.a.edit({ chat: "D1" }, "1", "x")).rejects.toThrow(/retry after 120 s/);
    expect(t.sleeps).toEqual([]);
    expect(t.calls).toHaveLength(2);
  });

  test("react: eyes with reactions.add; the check mark goes on, then the eyes come off; a mark already set or gone is fine", async () => {
    const t = setup();
    await t.a.react({ chat: "C1", thread: "1700000000.000001" }, "1700000000.000009", "read");
    t.answers.push((c) => (c.path.endsWith("reactions.add") ? Response.json({ ok: false, error: "already_reacted" }) : Response.json({ ok: false, error: "no_reaction" })));
    await t.a.react({ chat: "C1" }, "1700000000.000009", "answered");
    expect(t.sent()).toEqual([
      ["reactions.add", { channel: "C1", timestamp: "1700000000.000009", name: "eyes" }],
      ["reactions.add", { channel: "C1", timestamp: "1700000000.000009", name: "white_check_mark" }],
      ["reactions.remove", { channel: "C1", timestamp: "1700000000.000009", name: "eyes" }],
    ]);
    t.answers.length = 0;
    t.answers.push(() => Response.json({ ok: false, error: "missing_scope", needed: "reactions:write" }));
    await expect(t.a.react({ chat: "C1" }, "1", "read")).rejects.toThrow(/lacks scope reactions:write/);
  });
});
