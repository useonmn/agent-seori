import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InboundMessage, SendUncertain } from "../src/messenger/adapter.ts";
import { TelegramAdapter, type TelegramDeps } from "../src/messenger/telegram.ts";
import { voiceTranscriber } from "../src/messenger/voice.ts";
import type { Exec } from "../src/runtime/exec.ts";

const TOKEN = "123:abc";
const OWNER = "42";
const home = () => mkdtempSync(join(tmpdir(), "seori-telegram-"));

type Reply = { status?: number; body?: unknown; hang?: boolean };
type Call = { method: string; body: Record<string, unknown> };

/** A Bot API mock: getUpdates serves `updates` from the requested offset; `script[method]` queues one-off replies. */
function mock() {
  const calls: Call[] = [];
  const updates: unknown[] = [];
  const script: Record<string, Reply[]> = {};
  const hooks: { onCall?: (method: string) => void } = {};
  let nextId = 100;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname);
      const method = m?.[2] ?? "";
      const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>;
      calls.push({ method, body });
      hooks.onCall?.(method);
      if (m?.[1] !== TOKEN) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
      const scripted = script[method]?.shift();
      if (scripted) {
        if (scripted.hang) return new Promise<Response>(() => {});
        return Response.json(scripted.body, { status: scripted.status ?? 200 });
      }
      switch (method) {
        case "deleteWebhook":
          return Response.json({ ok: true, result: true });
        case "getMe":
          return Response.json({ ok: true, result: { id: 777, is_bot: true, username: "seori_bot" } });
        case "getUpdates": {
          const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
          const ready = updates.filter((u) => (u as { update_id: number }).update_id >= offset);
          // an idle long poll answers after a short hold so the receive loop does not spin
          if (ready.length === 0) await Bun.sleep(10);
          return Response.json({ ok: true, result: ready });
        }
        case "sendMessage":
          return Response.json({ ok: true, result: { message_id: nextId++, chat: { id: body["chat_id"] } } });
        default:
          return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
      }
    },
  });
  return { server, calls, updates, script, hooks, apiBase: `http://127.0.0.1:${server.port}` };
}

let servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

function setup(root = home(), token = TOKEN) {
  const api = mock();
  servers.push(api.server);
  const sleeps: number[] = [];
  // A fake clock that only moves when the adapter sleeps, so outage windows are deterministic.
  const clock = { ms: 1_000_000 };
  const make = () =>
    new TelegramAdapter({ source: "telegram", owner: OWNER, options: { apiBase: api.apiBase, pollTimeoutSec: 0 } }, root, {
      env: { SEORI_TELEGRAM_TOKEN: token },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.ms += ms;
      },
      now: () => clock.ms,
    });
  return { ...api, root, sleeps, clock, make, adapter: make() };
}

const dm = (update_id: number, message_id: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id,
  message: { message_id, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, date: 1_700_000_000, text, ...extra },
});

/** Runs receive until `want` messages arrived (or onMessage throws, or `ms` passed), then aborts and returns them. */
async function collect(a: TelegramAdapter, want: number, onMessage: (m: InboundMessage) => Promise<void> = async () => {}, ms = 1_000) {
  const ac = new AbortController();
  const got: InboundMessage[] = [];
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    await a.receive(ac.signal, async (m) => {
      await onMessage(m);
      got.push(m);
      if (got.length >= want) ac.abort();
    });
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return got;
}

const cursor = (root: string) => JSON.parse(readFileSync(join(root, "messenger", "telegram", "cursor.json"), "utf8")) as { offset: number };

describe("TelegramAdapter receive", () => {
  test("delivers the owner's DM with telegram:<chat>:<message id>, deletes the webhook once and long-polls", async () => {
    const t = setup();
    t.updates.push(dm(10, 5, "hello"));
    const got = await collect(t.adapter, 1);
    expect(got).toEqual([{ id: "telegram:42:5", source: "telegram", chat: "42", from: "42", at: 1_700_000_000_000, text: "hello" }]);
    expect(cursor(t.root)).toEqual({ offset: 11 });
    expect(t.calls.filter((c) => c.method === "deleteWebhook")).toEqual([{ method: "deleteWebhook", body: { drop_pending_updates: false } }]);
    const poll = t.calls.find((c) => c.method === "getUpdates")!;
    expect(poll.body).toEqual({ timeout: 0, limit: 100, allowed_updates: ["message", "edited_message"] });
  });

  test("drops other users, bots, other DMs and empty messages, committing past them; topic messages get a thread", async () => {
    const t = setup();
    t.updates.push(
      { update_id: 1, message: { message_id: 1, from: { id: 9, is_bot: false }, chat: { id: 9, type: "private" }, date: 1, text: "stranger" } },
      { update_id: 2, message: { message_id: 2, from: { id: 42, is_bot: true }, chat: { id: 42, type: "private" }, date: 1, text: "bot" } },
      { update_id: 3, message: { message_id: 3, from: { id: 9, is_bot: false }, chat: { id: -100, type: "supergroup" }, date: 1, text: "group stranger" } },
      dm(4, 4, ""),
      { update_id: 5, message: { message_id: 6, from: { id: 42 }, chat: { id: -100, type: "supergroup" }, date: 2, text: "reply in General", message_thread_id: 3 } },
      { update_id: 6, message: { message_id: 7, from: { id: 42 }, chat: { id: -100, type: "supergroup" }, date: 3, text: "topic", is_topic_message: true, message_thread_id: 55 } },
    );
    const got = await collect(t.adapter, 2);
    expect(got.map((m) => [m.id, m.thread, m.text])).toEqual([
      ["telegram:-100:6", undefined, "reply in General"],
      ["telegram:-100:7", "55", "topic"],
    ]);
    expect(cursor(t.root)).toEqual({ offset: 7 });
  });

  test("a reply carries the id and text it replies to; a topic message's link to its topic is not a reply", async () => {
    const t = setup();
    const chat = { id: 42, type: "private" };
    t.updates.push(
      dm(1, 10, "yes, that one", { reply_to_message: { message_id: 7, from: { id: 777, is_bot: true }, chat, date: 1, text: "Shall I ship v1.4?" } }),
      dm(2, 11, "in a topic", { is_topic_message: true, message_thread_id: 5, reply_to_message: { message_id: 5, chat, date: 1, forum_topic_created: { name: "Fix login" } } }),
      dm(3, 12, "about the photo", { reply_to_message: { message_id: 8, chat, date: 1, caption: "before" } }),
    );
    const got = await collect(t.adapter, 3);
    expect(got.map((m) => m.replyTo)).toEqual([{ id: "telegram:42:7", text: "Shall I ship v1.4?" }, undefined, { id: "telegram:42:8", text: "before" }]);
  });

  test("a rejected onMessage keeps the cursor, so the same id is offered again", async () => {
    const t = setup();
    t.updates.push(dm(1, 1, "skip me", { from: { id: 9 }, chat: { id: 9, type: "private" } }), dm(2, 8, "important"));
    await expect(t.adapter.receive(new AbortController().signal, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(cursor(t.root)).toEqual({ offset: 2 }); // past the dropped stranger, not past the failed message
    expect((await collect(t.make(), 1)).map((m) => m.id)).toEqual(["telegram:42:8"]);
    expect(cursor(t.root)).toEqual({ offset: 3 });
  });

  test("a restart resumes from the saved offset without replaying", async () => {
    const t = setup();
    t.updates.push(dm(1, 1, "one"));
    expect((await collect(t.adapter, 1)).map((m) => m.text)).toEqual(["one"]);
    t.updates.push(dm(2, 2, "two"));
    t.calls.length = 0;
    expect((await collect(t.make(), 1)).map((m) => m.text)).toEqual(["two"]);
    expect(t.calls.find((c) => c.method === "getUpdates")!.body["offset"]).toBe(2);
  });

  test("an edit becomes an :edit:<edit_date> id with an (edited) prefix", async () => {
    const t = setup();
    t.updates.push({ update_id: 1, edited_message: { message_id: 5, from: { id: 42 }, chat: { id: 42, type: "private" }, date: 100, edit_date: 160, text: "fixed" } });
    expect(await collect(t.adapter, 1)).toEqual([{ id: "telegram:42:5:edit:160", source: "telegram", chat: "42", from: "42", at: 160_000, text: "(edited) fixed" }]);
  });

  test("attachments add one line each with telegram-file refs; the caption is the text", async () => {
    const t = setup();
    t.updates.push(
      dm(1, 1, "", {
        text: undefined,
        caption: "look",
        photo: [{ file_id: "small", width: 90, height: 90, file_size: 100 }, { file_id: "big", width: 1280, height: 960, file_size: 204_800 }],
        document: { file_id: "doc1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 2_097_152 },
      }),
      dm(2, 2, "", { text: undefined, voice: { file_id: "v1", mime_type: "audio/ogg", duration: 3, file_size: 900 } }),
    );
    const got = await collect(t.adapter, 2);
    expect(got.map((m) => m.text)).toEqual([
      "look\n[attachment: photo (1280x960, 200.0 KB) telegram-file:big]\n[attachment: report.pdf (document, application/pdf, 2.0 MB) telegram-file:doc1]",
      "[attachment: voice (audio/ogg, 3s, 900 B) telegram-file:v1]",
    ]);
  });

  test("5xx and 429 on getUpdates are retried with backoff / retry_after", async () => {
    const t = setup();
    t.script["getUpdates"] = [
      { status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } },
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } },
    ];
    t.updates.push(dm(1, 1, "after errors"));
    expect((await collect(t.adapter, 1)).map((m) => m.text)).toEqual(["after errors"]);
    expect(t.sleeps).toEqual([500, 7000]);
  });

  const badGateway = (n: number): Reply[] => Array.from({ length: n }, () => ({ status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } }));

  test("getUpdates failing for over 2 minutes rejects receive with the last error; a shorter blip stays internal", async () => {
    // Backoff 500, 1000, … 30000 and a clock that only moves in sleeps: the 9th failure is 91.5 s in, the 10th 121.5 s.
    const blip = setup();
    blip.script["getUpdates"] = badGateway(9);
    blip.updates.push(dm(1, 1, "after a blip"));
    expect((await collect(blip.adapter, 1)).map((m) => m.text)).toEqual(["after a blip"]);
    // A success resets the window: another 9 failures in a row are still a blip.
    blip.script["getUpdates"] = badGateway(9);
    blip.updates.push(dm(2, 2, "after another blip"));
    expect((await collect(blip.adapter, 1)).map((m) => m.text)).toEqual(["after another blip"]);

    const down = setup();
    down.script["getUpdates"] = badGateway(20);
    const err = (await down.adapter.receive(new AbortController().signal, async () => {}).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^telegram \(telegram\): getUpdates has kept failing for 122 s; last error: .*502.*Bad Gateway/);
    expect(err.message).not.toContain(TOKEN);
    expect(down.calls.filter((c) => c.method === "getUpdates")).toHaveLength(10);
  });

  test("an unreachable API rejects receive after 2 minutes without leaking the token", async () => {
    const t = setup();
    t.server.stop(true);
    const err = (await t.adapter.receive(new AbortController().signal, async () => {}).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^telegram \(telegram\): deleteWebhook has kept failing/);
    expect(err.message).not.toContain(TOKEN);
  });

  test("backoff sleeps do not pile up abort listeners on the receive signal", async () => {
    const t = setup();
    t.script["getUpdates"] = badGateway(9);
    t.updates.push(dm(1, 1, "ok"));
    const ac = new AbortController();
    const live = new Set<unknown>();
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: AddEventListenerOptions) => {
      if (type === "abort") live.add(fn);
      add(type, fn, o);
    }) as typeof ac.signal.addEventListener;
    ac.signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: EventListenerOptions) => {
      if (type === "abort") live.delete(fn);
      remove(type, fn, o);
    }) as typeof ac.signal.removeEventListener;
    let peak = 0;
    await t.adapter.receive(ac.signal, async () => {
      peak = live.size;
      ac.abort();
    });
    expect(t.sleeps).toHaveLength(9);
    expect(peak).toBe(0);
  });

  test("the outage window counts from the last success, so slow failing requests count too", async () => {
    const t = setup();
    t.script["getUpdates"] = badGateway(20);
    let first = true;
    t.hooks.onCall = (method) => {
      if (method !== "getUpdates" || !first) return;
      first = false;
      t.clock.ms += 40_000; // the first read hangs until its timeout before failing
    };
    await expect(t.adapter.receive(new AbortController().signal, async () => {})).rejects.toThrow(/getUpdates has kept failing for 132 s/);
    expect(t.calls.filter((c) => c.method === "getUpdates")).toHaveLength(9);
  });

  test("a rejected token and a second consumer reject receive with what to fix", async () => {
    const bad = setup(home(), "999:wrong");
    await expect(bad.adapter.receive(new AbortController().signal, async () => {})).rejects.toThrow(/token was rejected \(401/);
    const t = setup();
    t.script["getUpdates"] = [{ status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } }];
    await expect(t.adapter.receive(new AbortController().signal, async () => {})).rejects.toThrow(/another program is reading this bot.*stop it/);
  });

  test("a missing token is a clear error from receive, not the constructor", async () => {
    const root = home();
    const a = new TelegramAdapter({ source: "telegram", owner: OWNER }, root, { env: {} });
    await expect(a.receive(new AbortController().signal, async () => {})).rejects.toThrow(/SEORI_TELEGRAM_TOKEN/);
  });

  test("abort returns promptly from an in-flight long poll", async () => {
    const t = setup();
    t.script["getUpdates"] = [{ hang: true }];
    const ac = new AbortController();
    let started = 0;
    t.hooks.onCall = (method) => {
      if (method !== "getUpdates") return;
      started = Date.now();
      ac.abort();
    };
    await t.adapter.receive(ac.signal, async () => {});
    expect(started).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("TelegramAdapter voice transcription that never finishes", () => {
  const voice = (update_id: number, message_id: number) => dm(update_id, message_id, "", { text: undefined, voice: { file_id: `v${message_id}`, duration: 2 } });

  function adapter(t: ReturnType<typeof setup>, deps: TelegramDeps) {
    return new TelegramAdapter({ source: "telegram", owner: OWNER, options: { apiBase: t.apiBase, pollTimeoutSec: 0 } }, t.root, {
      env: { SEORI_TELEGRAM_TOKEN: TOKEN },
      sleep: async () => {},
      ...deps,
    });
  }

  test("the deadline kills the hook and the voice message arrives without a transcript; the next message follows", async () => {
    const t = setup();
    writeFileSync(join(t.root, "config.json"), JSON.stringify({ hooks: { transcribe: ["stt", "{file}"] } }));
    const deadlines: AbortController[] = [];
    const events: string[] = [];
    // A hook that never exits; once it is spawned, its deadline passes.
    const exec: Exec = (_cmd, _argv, options) => {
      options?.onSpawn?.({ kill: () => events.push("kill") });
      deadlines.at(-1)!.abort();
      return new Promise(() => {});
    };
    const stt = voiceTranscriber(t.root, exec);
    const a = adapter(t, {
      transcribe: (_fetchFile, signal) => stt(async () => join(t.root, "v.ogg"), signal),
      deadline: () => {
        deadlines.push(new AbortController());
        return deadlines.at(-1)!.signal;
      },
      warn: (line) => events.push(line),
    });
    t.updates.push(voice(1, 1), dm(2, 2, "second"));
    const got = await collect(a, 2);
    expect(got.map((m) => m.text)).toEqual(["[attachment: voice (2s) telegram-file:v1]", "second"]);
    expect(events).toHaveLength(2);
    expect(events[0]).toBe("kill");
    expect(events[1]).toStartWith("seori: telegram (telegram): voice message not transcribed: ");
    expect(cursor(t.root)).toEqual({ offset: 3 });
  });

  test("abort ends receive while a transcription is still running; the voice message is kept for the next receive", async () => {
    const t = setup();
    const ac = new AbortController();
    const warns: string[] = [];
    const delivered: InboundMessage[] = [];
    const a = adapter(t, {
      transcribe: () => {
        ac.abort();
        return new Promise(() => {});
      },
      warn: (line) => warns.push(line),
    });
    t.updates.push(voice(1, 1));
    await a.receive(ac.signal, async (m) => void delivered.push(m));
    expect(delivered).toEqual([]);
    expect(warns).toEqual([]);
    expect(existsSync(join(t.root, "messenger", "telegram", "cursor.json"))).toBe(false);
  });
});

describe("TelegramAdapter send", () => {
  test("splits at 4096, replies the first part to the stored id and keeps the topic on every part", async () => {
    const t = setup();
    const text = `${"a".repeat(4000)}\n\n${"b".repeat(200)}`;
    const r = await t.adapter.send({ chat: "-100", thread: "55", replyTo: "9:edit:170" }, text);
    expect(r).toEqual({ messageId: "100" });
    const sends = t.calls.filter((c) => c.method === "sendMessage").map((c) => c.body);
    expect(sends).toEqual([
      { chat_id: "-100", text: "a".repeat(4000), link_preview_options: { is_disabled: true }, message_thread_id: 55, reply_parameters: { message_id: 9, allow_sending_without_reply: true } },
      { chat_id: "-100", text: "b".repeat(200), link_preview_options: { is_disabled: true }, message_thread_id: 55 },
    ]);
    expect(sends.every((s) => !("parse_mode" in s))).toBe(true);
  });

  test("honours 429 retry_after through the injected sleep", async () => {
    const t = setup();
    t.script["sendMessage"] = [{ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } } }];
    expect(await t.adapter.send({ chat: "42" }, "hi")).toEqual({ messageId: "100" });
    expect(t.sleeps).toEqual([3000]);
  });

  test("5xx on the first part is SendUncertain; a definite 400 is a plain Error", async () => {
    const t = setup();
    t.script["sendMessage"] = [{ status: 500, body: { ok: false, error_code: 500, description: "Internal" } }];
    await expect(t.adapter.send({ chat: "42" }, "hi")).rejects.toBeInstanceOf(SendUncertain);
    t.script["sendMessage"] = [{ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }];
    const err = await t.adapter.send({ chat: "1" }, "hi").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SendUncertain);
    expect(String(err)).toContain("chat not found");
  });

  test("a failure after the first part went out is SendUncertain", async () => {
    const t = setup();
    t.script["sendMessage"] = [{ body: { ok: true, result: { message_id: 1 } } }, { status: 400, body: { ok: false, error_code: 400, description: "Bad Request" } }];
    await expect(t.adapter.send({ chat: "42" }, `${"a".repeat(4096)} b`)).rejects.toBeInstanceOf(SendUncertain);
  });

  test("a timeout after sending is SendUncertain", async () => {
    const t = setup();
    t.script["sendMessage"] = [{ hang: true }];
    // The request reached the server and the connection then dies without an answer, as after a timeout.
    t.hooks.onCall = () => queueMicrotask(() => t.server.stop(true));
    await expect(t.adapter.send({ chat: "42" }, "hi")).rejects.toBeInstanceOf(SendUncertain);
  });

  test("empty text is refused without a request", async () => {
    const t = setup();
    await expect(t.adapter.send({ chat: "42" }, "  \n ")).rejects.toThrow(/empty/);
    expect(t.calls).toEqual([]);
  });
});

describe("TelegramAdapter check", () => {
  test("reports the bot's username and id; a bad token says what to fix", async () => {
    expect(await setup().adapter.check()).toBe("@seori_bot (id 777)");
    await expect(setup(home(), "1:bad").adapter.check()).rejects.toThrow(/token was rejected/);
  });
});
