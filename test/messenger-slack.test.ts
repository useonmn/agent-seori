import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Channel } from "../src/channel.ts";
import { type InboundMessage, SendUncertain } from "../src/messenger/adapter.ts";
import { compareTs, SlackAdapter, SlackApiError } from "../src/messenger/slack.ts";
import { msgEditReplyOf, msgSend, type MsgDeps } from "../src/msg.ts";

const OWNER = "UOWNER";
const home = () => mkdtempSync(join(tmpdir(), "seori-slack-"));
const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);
const envelope = (id: string, event: Record<string, unknown>) => JSON.stringify({ type: "events_api", envelope_id: id, payload: { event } });
const dm = (ts: string, extra: Record<string, unknown> = {}) => ({ type: "message", channel_type: "im", channel: "D1", user: OWNER, text: `hi ${ts}`, ts, ...extra });
const chan = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({ type: "message", channel_type: "channel", channel: "C1", user: OWNER, text, ts, ...extra });
const edit = (user: string, text: string, ts: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  subtype: "message_changed",
  channel: "C1",
  channel_type: "channel",
  message: { type: "message", user, text, ts, edited: { user, ts: `${ts}9` }, ...extra },
  ts: `${ts}8`,
});

type Mock = {
  apiBase: string;
  opens: number;
  acks: string[];
  posts: Record<string, unknown>[];
  postAuth: string[];
  /** chat.update bodies, in order. */
  updates: Record<string, unknown>[];
  historyCalls: URLSearchParams[];
  /** Per channel, newest first like Slack; filtered by `oldest` (exclusive). */
  history: Record<string, Record<string, unknown>[]>;
  /** Paged answer instead of `history`, when set. */
  historyPage?: (q: URLSearchParams) => Record<string, unknown>;
  /** Error answer of conversations.history for a channel, when set. */
  historyError: Record<string, Record<string, unknown>>;
  repliesCalls: URLSearchParams[];
  /** `<channel>:<thread ts>` → replies, oldest first, without the parent (the mock puts it first like Slack). */
  replies: Record<string, Record<string, unknown>[]>;
  /** Error answer of conversations.replies for `<channel>:<thread ts>`, when set. */
  repliesError: Record<string, Record<string, unknown>>;
  /** Answer one reply per page (has_more until the last), to see paging stop early. */
  repliesPaged: boolean;
  /** users.info answers by user id (default: a full member); `usersError` answers every call when set. */
  users: Record<string, Record<string, unknown>>;
  usersError?: Record<string, unknown>;
  usersCalls: string[];
  /** Called after hello on each new socket (1-based connection number). */
  onConnect: (ws: ServerWebSocket<unknown>, n: number) => void;
  sendHello: boolean;
  authAnswer: () => Response;
  openAnswer: () => Response;
  postAnswers: Array<(body: Record<string, unknown>) => Response | Promise<Response>>;
  stop: () => void;
};

let mocks: Mock[] = [];
afterEach(() => {
  for (const m of mocks) m.stop();
  mocks = [];
});

function startMock(): Mock {
  let ts = 0;
  const mock: Mock = {
    apiBase: "",
    opens: 0,
    acks: [],
    posts: [],
    postAuth: [],
    updates: [],
    historyCalls: [],
    history: {},
    historyError: {},
    repliesCalls: [],
    replies: {},
    repliesError: {},
    repliesPaged: false,
    users: {},
    usersCalls: [],
    onConnect: () => {},
    sendHello: true,
    authAnswer: () => json({ ok: true, user: "seori", user_id: "UBOT", team: "Acme", team_id: "T1" }),
    openAnswer: () => json({ ok: true, url: `ws://127.0.0.1:${server.port}/link` }),
    postAnswers: [],
    stop: () => server.stop(true),
  };
  let connections = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/link") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (url.pathname === "/api/auth.test") return mock.authAnswer();
      if (url.pathname === "/api/apps.connections.open") {
        mock.opens++;
        expect(req.method).toBe("POST");
        expect(req.headers.get("authorization")).toBe("Bearer xapp-1");
        return mock.openAnswer();
      }
      if (url.pathname === "/api/conversations.history") {
        const q = url.searchParams;
        mock.historyCalls.push(q);
        if (mock.historyPage) return json(mock.historyPage(q));
        const error = mock.historyError[q.get("channel") ?? ""];
        if (error) return json(error);
        const oldest = q.get("oldest") ?? "0";
        const messages = (mock.history[q.get("channel") ?? ""] ?? []).filter((m) => compareTs(String(m["ts"]), oldest) > 0);
        return json({ ok: true, messages, has_more: false });
      }
      if (url.pathname === "/api/users.info") {
        const user = url.searchParams.get("user") ?? "";
        mock.usersCalls.push(user);
        if (mock.usersError) return json(mock.usersError);
        return json({ ok: true, user: { id: user, is_restricted: false, is_ultra_restricted: false, ...mock.users[user] } });
      }
      if (url.pathname === "/api/conversations.replies") {
        const q = url.searchParams;
        mock.repliesCalls.push(q);
        const channel = q.get("channel") ?? "";
        const root = q.get("ts") ?? "";
        const oldest = q.get("oldest") ?? "0";
        const error = mock.repliesError[`${channel}:${root}`];
        if (error) return json(error);
        const parent = mock.history[channel]?.find((m) => m["ts"] === root) ?? { type: "message", ts: root, thread_ts: root };
        const replies = (mock.replies[`${channel}:${root}`] ?? []).filter((m) => compareTs(String(m["ts"]), oldest) > 0);
        if (mock.repliesPaged) {
          const all = [parent, ...replies];
          const i = Number(q.get("cursor") ?? "0");
          return json({ ok: true, messages: all.slice(i, i + 1), has_more: i + 1 < all.length, response_metadata: { next_cursor: String(i + 1) } });
        }
        return json({ ok: true, messages: [parent, ...replies], has_more: false });
      }
      if (url.pathname === "/api/chat.postMessage") {
        const body = (await req.json()) as Record<string, unknown>;
        mock.posts.push(body);
        mock.postAuth.push(req.headers.get("authorization") ?? "");
        const answer = mock.postAnswers.shift();
        if (answer) return answer(body);
        ts++;
        return json({ ok: true, channel: body["channel"], ts: `1800000000.00000${ts}` });
      }
      if (url.pathname === "/api/chat.update") {
        mock.updates.push((await req.json()) as Record<string, unknown>);
        return json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        connections++;
        if (mock.sendHello) ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
        mock.onConnect(ws, connections);
      },
      message(_ws, data) {
        const frame = JSON.parse(String(data)) as { envelope_id?: string };
        if (frame.envelope_id) mock.acks.push(frame.envelope_id);
      },
    },
  });
  mock.apiBase = `http://127.0.0.1:${server.port}/api`;
  mocks.push(mock);
  return mock;
}

type Extra = { sleeps?: number[]; options?: Record<string, unknown>; env?: Record<string, string | undefined>; sleep?: (ms: number) => Promise<void>; now?: () => number; others?: boolean };

function adapter(mock: Mock, root: string, extra: Extra = {}) {
  return new SlackAdapter({ source: "slack", owner: OWNER, ...(extra.others ? { others: true } : {}), options: { apiBase: mock.apiBase, ...extra.options } }, root, {
    env: extra.env ?? { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" },
    sleep:
      extra.sleep ??
      (async (ms) => {
        extra.sleeps?.push(ms);
        await Bun.sleep(1);
      }),
    ...(extra.now ? { now: extra.now } : {}),
  });
}

async function until(cond: () => boolean, ms = 1_500): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** Runs receive until `done(got)` holds (or `ms` passed), then aborts and returns what arrived. */
async function collect(a: SlackAdapter, done: (got: InboundMessage[]) => boolean, onMessage: (m: InboundMessage) => Promise<void> = async () => {}, ms = 1_500) {
  const ac = new AbortController();
  const got: InboundMessage[] = [];
  const run = a.receive(ac.signal, async (m) => {
    await onMessage(m);
    got.push(m);
  });
  const timer = setTimeout(() => ac.abort(), ms);
  const watch = setInterval(() => {
    if (done(got)) ac.abort();
  }, 5);
  try {
    await run;
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
    ac.abort();
  }
  return got;
}

const cursorOf = (root: string) => JSON.parse(readFileSync(join(root, "messenger", "slack", "cursor.json"), "utf8")) as { channels: Record<string, string> };

/** A WebSocket endpoint that completes the handshake (and optionally sends hello), then never answers anything again. */
function blackHole(hello: boolean): { url: string; upgrades: number; swallowed: number; stop: () => void } {
  const open = new WeakSet<object>();
  const hole = { url: "", upgrades: 0, swallowed: 0, stop: () => server.stop(true) };
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        if (open.has(socket)) {
          hole.swallowed++; // every frame, pings included, goes unanswered: a half-open connection
          return;
        }
        open.add(socket);
        hole.upgrades++;
        const key = /sec-websocket-key: *(\S+)/i.exec(data.toString())?.[1] ?? "";
        const accept = new Bun.CryptoHasher("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        if (hello) {
          const payload = Buffer.from(JSON.stringify({ type: "hello" }));
          socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
        }
      },
    },
  });
  hole.url = `ws://127.0.0.1:${server.port}/link`;
  return hole;
}

const writeCursor = (root: string, cursor: unknown) => {
  mkdirSync(join(root, "messenger", "slack"), { recursive: true });
  writeFileSync(join(root, "messenger", "slack", "cursor.json"), JSON.stringify(cursor));
};

describe("SlackAdapter receive", () => {
  test("delivers the owner's DM with its id, drops others and bots, acks every envelope and commits past them", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", dm("1700000000.000100")));
      ws.send(envelope("e2", dm("1700000000.000200", { user: "USTRANGER" })));
      ws.send(envelope("e3", dm("1700000000.000300", { bot_id: "B1", user: OWNER })));
      ws.send(envelope("e4", dm("1700000000.000400", { subtype: "bot_message", user: undefined, bot_id: "B2" })));
    };
    const root = home();
    const got = await collect(adapter(mock, root), () => mock.acks.length >= 4);
    expect(got).toEqual([{ id: "slack:D1:1700000000.000100", source: "slack", chat: "D1", from: OWNER, at: 1700000000000, text: "hi 1700000000.000100" }]);
    expect(mock.acks).toEqual(["e1", "e2", "e3", "e4"]);
    expect(cursorOf(root).channels["D1"]).toBe("1700000000.000400");
  });

  test("a top-level message carries no thread, a thread's first message included; a thread reply (DM or channel, edits too) carries its thread", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", { type: "app_mention", channel: "C1", user: OWNER, text: "<@UBOT> look &amp; see", ts: "1700000000.000100" }));
      ws.send(envelope("e2", dm("1700000000.000200", { thread_ts: "1700000000.000150" })));
      ws.send(envelope("e3", dm("1700000000.000250", { thread_ts: "1700000000.000250", reply_count: 2 })));
      ws.send(envelope("e4", chan("1700000000.000300", "<@UBOT> in a thread", { thread_ts: "1700000000.000050" })));
      ws.send(envelope("e5", edit(OWNER, "<@UBOT> top, edited", "1700000000.000100")));
      ws.send(envelope("e6", edit(OWNER, "<@UBOT> reply, edited", "1700000000.000300", { thread_ts: "1700000000.000050" })));
    };
    const got = await collect(adapter(mock, home()), (g) => g.length >= 6);
    expect(got.map((m) => [m.id, m.thread, m.text])).toEqual([
      ["slack:C1:1700000000.000100", undefined, "<@UBOT> look & see"],
      ["slack:D1:1700000000.000200", "1700000000.000150", "hi 1700000000.000200"],
      ["slack:D1:1700000000.000250", undefined, "hi 1700000000.000250"],
      ["slack:C1:1700000000.000300", "1700000000.000050", "<@UBOT> in a thread"],
      ["slack:C1:1700000000.000100:edit:1700000000.0001009", undefined, "(edited) <@UBOT> top, edited"],
      ["slack:C1:1700000000.000300:edit:1700000000.0003009", "1700000000.000050", "(edited) <@UBOT> reply, edited"],
    ]);
  });

  test("a rejected onMessage rejects receive without ack or commit; the restart redelivers the same id from history", async () => {
    const mock = startMock();
    const msg = dm("1700000000.000100");
    mock.history["D1"] = [msg];
    mock.onConnect = (ws, n) => {
      if (n === 1) ws.send(envelope("e1", msg));
    };
    const root = home();
    const boom = new Error("disk full");
    const ac = new AbortController();
    await expect(
      adapter(mock, root).receive(ac.signal, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(mock.acks).toEqual([]);
    expect(cursorOf(root).channels["D1"]).toBe("1700000000.000099");

    const got = await collect(adapter(mock, root), (g) => g.length >= 1);
    expect(got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
    expect(mock.historyCalls.at(-1)?.get("oldest")).toBe("1700000000.000099");
    expect(cursorOf(root).channels["D1"]).toBe("1700000000.000100");
  });

  test("a restart catches up from the saved cursor, paged and oldest first, without replaying committed messages", async () => {
    const mock = startMock();
    mock.onConnect = (ws, n) => {
      if (n === 1) ws.send(envelope("e1", dm("1700000000.000100")));
    };
    const root = home();
    expect((await collect(adapter(mock, root), (g) => g.length >= 1)).map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);

    const b = { type: "message", user: OWNER, text: "b", ts: "1700000000.000200" };
    const c = { type: "message", user: OWNER, text: "c", ts: "1700000001.000000" };
    const stranger = { type: "message", user: "UX", text: "x", ts: "1700000001.000005" };
    mock.historyPage = (q) => (q.get("cursor") === "p2" ? { ok: true, messages: [b], has_more: false } : { ok: true, messages: [stranger, c], has_more: true, response_metadata: { next_cursor: "p2" } });
    const got = await collect(adapter(mock, root), () => mock.historyCalls.length >= 2 && cursorOf(root).channels["D1"] === "1700000001.000005");
    expect(got.map((m) => [m.id, m.text])).toEqual([
      ["slack:D1:1700000000.000200", "b"],
      ["slack:D1:1700000001.000000", "c"],
    ]);
    expect(mock.historyCalls[0]?.get("oldest")).toBe("1700000000.000100");
    expect(mock.historyCalls[0]?.get("inclusive")).toBe("false");
  });

  test("an edit is a new edit id with (edited) text; files become attachment lines", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", message: { type: "message", user: OWNER, text: "fixed", ts: "1700000000.000100", edited: { user: OWNER, ts: "1700000050.000000" } }, ts: "1700000050.000001" }));
      ws.send(envelope("e2", { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", message: { type: "message", user: OWNER, text: "unfurl only", ts: "1700000000.000100" }, ts: "1700000051.000000" }));
      ws.send(envelope("e3", dm("1700000060.000000", { subtype: "file_share", text: "", files: [{ id: "F1", name: "log.txt", mimetype: "text/plain", size: 12, permalink: "https://x.slack.com/files/F1" }] })));
    };
    const got = await collect(adapter(mock, home()), (g) => g.length >= 2 && mock.acks.length >= 3);
    expect(got.map((m) => [m.id, m.text, m.at])).toEqual([
      ["slack:D1:1700000000.000100:edit:1700000050.000000", "(edited) fixed", 1700000050000],
      ["slack:D1:1700000060.000000", "[attachment: log.txt (text/plain, 12 bytes) https://x.slack.com/files/F1]", 1700000060000],
    ]);
  });

  test("refresh_requested reconnects with a fresh URL and keeps delivering", async () => {
    const mock = startMock();
    mock.onConnect = (ws, n) => {
      if (n === 1) ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
      if (n === 2) ws.send(envelope("e1", dm("1700000000.000100")));
    };
    const got = await collect(adapter(mock, home()), (g) => g.length >= 1);
    expect(got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
    expect(mock.opens).toBe(2);
  });

  test("transient failures (5xx on connect, a dropped socket) retry with backoff", async () => {
    const mock = startMock();
    let calls = 0;
    mock.openAnswer = () => (++calls === 1 ? new Response("down", { status: 503 }) : json({ ok: true, url: `${mock.apiBase.replace("http", "ws").replace("/api", "")}/link` }));
    mock.onConnect = (ws, n) => {
      if (n === 1) ws.close();
      else ws.send(envelope("e1", dm("1700000000.000100")));
    };
    const sleeps: number[] = [];
    const got = await collect(adapter(mock, home(), { sleeps }), (g) => g.length >= 1);
    expect(got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
  });

  test("fatal configuration errors reject receive with what to fix", async () => {
    const root = home();
    const signal = new AbortController().signal;
    const noop = async () => {};

    const badBot = startMock();
    badBot.authAnswer = () => json({ ok: false, error: "invalid_auth" });
    await expect(adapter(badBot, root).receive(signal, noop)).rejects.toThrow(/rejected the bot token.*invalid_auth/);

    const badApp = startMock();
    badApp.openAnswer = () => json({ ok: false, error: "token_revoked" });
    await expect(adapter(badApp, root).receive(signal, noop)).rejects.toThrow(/rejected the app token.*token_revoked/);

    const disabled = startMock();
    disabled.onConnect = (ws) => ws.send(JSON.stringify({ type: "disconnect", reason: "link_disabled" }));
    await expect(adapter(disabled, root).receive(signal, noop)).rejects.toThrow(/Socket Mode is turned off/);

    const missing = startMock();
    const a = adapter(missing, root, { env: {} });
    await expect(a.receive(signal, noop)).rejects.toThrow(/SEORI_SLACK_BOT_TOKEN/);
  });

  test("abort returns promptly while the socket is idle", async () => {
    const mock = startMock();
    // Frames are handled in order, so the ack of a frame sent after hello means hello's catch-up is done and the
    // adapter went back to waiting on an idle socket in the same turn it acked.
    mock.onConnect = (ws) => ws.send(JSON.stringify({ type: "slash_commands", envelope_id: "idle-probe" }));
    const ac = new AbortController();
    const run = adapter(mock, home()).receive(ac.signal, async () => {});
    await until(() => mock.acks.includes("idle-probe"));
    const t = Date.now();
    ac.abort();
    await run;
    expect(Date.now() - t).toBeLessThan(200);
  });

  test("a chat the bot may not read (missing_scope) is skipped by catch-up; other chats still arrive", async () => {
    const mock = startMock();
    const root = home();
    writeCursor(root, { channels: { G1: "1700000000.000001", D1: "1700000000.000001" } });
    mock.historyError["G1"] = { ok: false, error: "missing_scope", needed: "groups:history" };
    mock.history["D1"] = [dm("1700000000.000100")];
    const got = await collect(adapter(mock, root), (g) => g.length >= 1);
    expect(got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
    expect(cursorOf(root).channels["G1"]).toBe("1700000000.000001"); // kept: adding the scope resumes from here
  });

  for (const hello of [true, false]) {
    test(`a socket that ${hello ? "stops answering pings" : "never sends hello"} is dropped and reconnected`, async () => {
      const mock = startMock();
      const hole = blackHole(hello);
      let opens = 0;
      mock.openAnswer = () => json({ ok: true, url: ++opens === 1 ? hole.url : `${mock.apiBase.replace("http", "ws").replace("/api", "")}/link` });
      mock.onConnect = (ws) => ws.send(envelope("e1", dm("1700000000.000100")));
      const options = hello ? { pingIntervalMs: 50 } : { pingIntervalMs: 60_000, helloTimeoutMs: 100 };
      try {
        const got = await collect(adapter(mock, home(), { options }), (g) => g.length >= 1);
        expect(got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
        expect(mock.opens).toBe(2);
        expect(hole.upgrades).toBe(1);
        if (hello) expect(hole.swallowed).toBeGreaterThan(0); // the unanswered ping
      } finally {
        hole.stop();
      }
    });
  }

  test("thread replies (and broadcasts) sent while disconnected are caught up with conversations.replies", async () => {
    const mock = startMock();
    mock.onConnect = (ws, n) => {
      if (n === 1) ws.send(envelope("e1", dm("1700000000.000100")));
    };
    const root = home();
    expect((await collect(adapter(mock, root), (g) => g.length >= 1)).map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);

    // Offline: the owner answers in the thread of their own message, in the thread of a new seori message, and once
    // more with "also send to direct message".
    const broadcast = { type: "message", subtype: "thread_broadcast", user: OWNER, text: "also", ts: "1700000000.000500", thread_ts: "1700000000.000100" };
    mock.history["D1"] = [broadcast, { type: "message", user: "UBOT", bot_id: "B1", text: "done", ts: "1700000000.000200", thread_ts: "1700000000.000200", reply_count: 1, latest_reply: "1700000000.000400" }];
    mock.replies["D1:1700000000.000100"] = [{ type: "message", user: OWNER, text: "follow", ts: "1700000000.000300", thread_ts: "1700000000.000100" }, broadcast];
    mock.replies["D1:1700000000.000200"] = [{ type: "message", user: OWNER, text: "on yours", ts: "1700000000.000400", thread_ts: "1700000000.000200" }];
    const got = await collect(adapter(mock, root), () => cursorOf(root).channels["D1"] === "1700000000.000500");
    expect(got.map((m) => [m.id, m.thread, m.text])).toEqual([
      ["slack:D1:1700000000.000300", "1700000000.000100", "follow"],
      ["slack:D1:1700000000.000400", "1700000000.000200", "on yours"],
      ["slack:D1:1700000000.000500", "1700000000.000100", "also"],
    ]);
    expect(mock.repliesCalls.every((q) => q.get("oldest") === "1700000000.000100")).toBe(true);
  });

  test("a failure loop longer than two minutes rejects receive with the last error; a shorter blip stays internal", async () => {
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
      await Bun.sleep(0);
    };
    const now = () => clock;

    const down = startMock();
    down.openAnswer = () => new Response("down", { status: 503 });
    const err = await adapter(down, home(), { sleep, now })
      .receive(new AbortController().signal, async () => {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^slack slack: no working connection for \d+ s; last error: .*503/);
    expect(clock).toBeGreaterThan(120_000);
    expect(clock).toBeLessThan(120_000 + 60_000);

    clock = 0;
    const blip = startMock();
    blip.openAnswer = () => (clock < 100_000 ? new Response("down", { status: 503 }) : json({ ok: true, url: `${blip.apiBase.replace("http", "ws").replace("/api", "")}/link` }));
    blip.onConnect = (ws) => ws.send(envelope("e1", dm("1700000000.000100")));
    const got = await collect(adapter(blip, home(), { sleep, now }), (g) => g.length >= 1);
    expect(got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
    expect(clock).toBeGreaterThanOrEqual(100_000);
  });

  test("in a channel only a mention or a reply in a thread seori follows is delivered, also after the thread was pruned", async () => {
    const mock = startMock();
    // An older thread seori answered in, no longer in the cursor: conversations.replies shows seori's message.
    mock.replies["C1:1700000000.000060"] = [{ type: "message", user: "UBOT", bot_id: "B1", text: "done", ts: "1700000000.000070", thread_ts: "1700000000.000060" }];
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", chan("1700000000.000100", "hello all")));
      ws.send(envelope("e2", chan("1700000000.000200", "<@UBOT> do x")));
      ws.send(envelope("e3", chan("1700000000.000300", "and y", { thread_ts: "1700000000.000200" })));
      ws.send(envelope("e4", chan("1700000000.000400", "someone else's thread", { thread_ts: "1700000000.000050" })));
      ws.send(envelope("e5", chan("1700000000.000500", "still not ours", { thread_ts: "1700000000.000050" })));
      ws.send(envelope("e6", chan("1700000000.000600", "back to this", { thread_ts: "1700000000.000060" })));
    };
    const got = await collect(adapter(mock, home()), () => mock.acks.length >= 6);
    expect(got.map((m) => [m.id, m.thread, m.from, m.text])).toEqual([
      ["slack:C1:1700000000.000200", undefined, OWNER, "<@UBOT> do x"],
      ["slack:C1:1700000000.000300", "1700000000.000200", OWNER, "and y"],
      ["slack:C1:1700000000.000600", "1700000000.000060", OWNER, "back to this"],
    ]);
    // The thread found not to be seori's is looked up once; tracked threads never.
    expect(mock.repliesCalls.map((q) => q.get("ts"))).toEqual(["1700000000.000050", "1700000000.000060"]);
  });

  test("a thread lookup Slack refuses or rate-limits drops that reply and keeps the session; paging stops at seori's message or after 3 pages", async () => {
    const mock = startMock();
    mock.repliesError["C1:1700000000.000050"] = { ok: false, error: "thread_not_found" };
    mock.repliesError["C1:1700000000.000055"] = { ok: false, error: "missing_scope", needed: "groups:history" };
    mock.repliesError["C1:1700000000.000057"] = { ok: false, error: "ratelimited" };
    mock.repliesPaged = true;
    const reply = (thread: string, ts: string, extra: Record<string, unknown> = {}) => ({ type: "message", user: "UX", text: "chat", ts, thread_ts: thread, ...extra });
    mock.replies["C1:1700000000.000060"] = [
      reply("1700000000.000060", "1700000000.000070", { user: "UBOT", bot_id: "B1", text: "done" }),
      reply("1700000000.000060", "1700000000.000080"),
      reply("1700000000.000060", "1700000000.000090"),
    ];
    mock.replies["C1:1700000000.000065"] = ["66", "67", "68", "69", "70"].map((n) => reply("1700000000.000065", `1700000000.0000${n}5`));
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", chan("1700000000.000100", "gone thread", { thread_ts: "1700000000.000050" })));
      ws.send(envelope("e2", chan("1700000000.000200", "unreadable", { thread_ts: "1700000000.000055" })));
      ws.send(envelope("e3", chan("1700000000.000250", "rate limited", { thread_ts: "1700000000.000057" })));
      ws.send(envelope("e4", chan("1700000000.000300", "seori's thread", { thread_ts: "1700000000.000060" })));
      ws.send(envelope("e5", chan("1700000000.000350", "long chatter thread", { thread_ts: "1700000000.000065" })));
      ws.send(envelope("e6", dm("1700000000.000400")));
    };
    const got = await collect(adapter(mock, home()), () => mock.acks.length >= 6);
    expect(got.map((m) => m.id)).toEqual(["slack:C1:1700000000.000300", "slack:D1:1700000000.000400"]);
    expect(mock.opens).toBe(1);
    const calls = (ts: string) => mock.repliesCalls.filter((q) => q.get("ts") === ts).length;
    // Parent page, then seori's message on the second page; a thread without it stops after 3 pages of 6.
    expect([calls("1700000000.000060"), calls("1700000000.000065")]).toEqual([2, 3]);
  });

  test("a thread seen as not seori's is looked up again after a mention, which counts only from someone seori answers", async () => {
    for (const who of [OWNER, "UOTHER"]) {
      const mock = startMock();
      let socket: ServerWebSocket<unknown> | undefined;
      mock.onConnect = (ws) => {
        socket = ws;
        ws.send(envelope("e1", chan("1700000000.000100", "just chatting", { thread_ts: "1700000000.000050" })));
      };
      // The mention arrives as an edit (an edit is not tracked like a delivered new message).
      const mention = { type: "message", user: who, team: "T1", text: "<@UBOT> can you help", ts: "1700000000.000200", thread_ts: "1700000000.000050" };
      const event = { type: "message", subtype: "message_changed", channel: "C1", channel_type: "channel", message: { ...mention, edited: { user: who, ts: "1700000000.000250" } }, ts: "1700000000.000251" };
      const got = await collect(adapter(mock, home()), () => {
        if (mock.acks.length === 1 && socket) {
          mock.replies["C1:1700000000.000050"] = [mention];
          socket.send(envelope("e2", event));
          socket.send(envelope("e3", chan("1700000000.000300", "yes please", { thread_ts: "1700000000.000050" })));
          socket = undefined;
        }
        return mock.acks.length >= 3;
      });
      // The owner's mention makes it seori's; a mention by someone seori does not answer (others off) does not.
      expect(got.map((m) => m.id)).toEqual(who === OWNER ? ["slack:C1:1700000000.000200:edit:1700000000.000250", "slack:C1:1700000000.000300"] : []);
      expect(mock.repliesCalls.map((q) => q.get("ts"))).toEqual(["1700000000.000050", "1700000000.000050"]);
    }
  });

  test("catch-up applies the same rule: channel chatter is dropped, a mention and a reply in a tracked thread arrive", async () => {
    const mock = startMock();
    const root = home();
    writeCursor(root, { channels: { C1: "1700000000.000001" }, threads: { C1: { "1700000000.000010": "1700000000.000010" } } });
    mock.history["C1"] = [
      { type: "message", user: OWNER, text: "<@UBOT> look", ts: "1700000000.000200" },
      { type: "message", user: OWNER, text: "chatter", ts: "1700000000.000100" },
    ];
    mock.replies["C1:1700000000.000010"] = [{ type: "message", user: OWNER, text: "follow", ts: "1700000000.000300", thread_ts: "1700000000.000010" }];
    const got = await collect(adapter(mock, root), () => cursorOf(root).channels["C1"] === "1700000000.000300");
    expect(got.map((m) => [m.id, m.text])).toEqual([
      ["slack:C1:1700000000.000200", "<@UBOT> look"],
      ["slack:C1:1700000000.000300", "follow"],
    ]);
  });

  test("others leaves guests out (users.info, asked once per user); without users:read only the owner gets through", async () => {
    const mock = startMock();
    mock.users["UGUEST"] = { is_restricted: true };
    mock.users["USINGLE"] = { is_ultra_restricted: true };
    const t1 = { team: "T1" };
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", chan("1700000000.000100", "<@UBOT> guest", { user: "UGUEST", ...t1 })));
      ws.send(envelope("e2", chan("1700000000.000200", "<@UBOT> single-channel guest", { user: "USINGLE", ...t1 })));
      ws.send(envelope("e3", chan("1700000000.000300", "<@UBOT> member", { user: "UOTHER", ...t1 })));
      ws.send(envelope("e4", chan("1700000000.000400", "<@UBOT> member again", { user: "UOTHER", ...t1 })));
      ws.send(envelope("e5", chan("1700000000.000500", "<@UBOT> owner", t1)));
    };
    const got = await collect(adapter(mock, home(), { others: true }), () => mock.acks.length >= 5);
    expect(got.map((m) => [m.id, m.from])).toEqual([
      ["slack:C1:1700000000.000300", "UOTHER"],
      ["slack:C1:1700000000.000400", "UOTHER"],
      ["slack:C1:1700000000.000500", OWNER],
    ]);
    expect(mock.usersCalls.sort()).toEqual(["UGUEST", "UOTHER", "USINGLE"]);

    // An app installed without users:read: with others off, users.info is never called; with others on, a
    // missing_scope drops that person's message (fail closed), keeps the session, and logs one line naming the scope.
    const errors: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      for (const others of [false, true]) {
        const noScope = startMock();
        noScope.usersError = { ok: false, error: "missing_scope", needed: "users:read" };
        noScope.onConnect = (ws) => {
          ws.send(envelope("e1", chan("1700000000.000100", "<@UBOT> member", { user: "UOTHER", ...t1 })));
          ws.send(envelope("e2", chan("1700000000.000200", "<@UBOT> member again", { user: "UOTHER", ...t1 })));
          ws.send(envelope("e3", chan("1700000000.000300", "<@UBOT> owner", t1)));
        };
        const only = await collect(adapter(noScope, home(), { others }), () => noScope.acks.length >= 3);
        expect(only.map((m) => m.from)).toEqual([OWNER]);
        expect(noScope.opens).toBe(1);
        // Addressed messages only, and a missing scope is remembered: one users.info call for UOTHER in this receive.
        expect(noScope.usersCalls).toEqual(others ? ["UOTHER"] : []);
      }
    } finally {
      console.error = error;
    }
    expect(errors.filter((l) => l.includes("users:read"))).toEqual([
      'slack slack: "others" needs the bot scope users:read to tell members from guests; add it in the Slack app settings (OAuth & Permissions) and reinstall the app. Until then only the owner is answered',
    ]);
  });

  test("a channel thread reply carries root (its thread's first message), rootByOwner when the owner wrote it and rootBySeori when seori did; top-level messages and DMs carry neither", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", chan("1700000000.000100", "<@UBOT> top")));
      ws.send(envelope("e2", chan("1700000000.000200", "<@UBOT> under my own plain message", { thread_ts: "1700000000.000050", parent_user_id: OWNER })));
      ws.send(envelope("e3", chan("1700000000.000250", "<@UBOT> under someone else's", { thread_ts: "1700000000.000060", parent_user_id: "UZ" })));
      ws.send(envelope("e4", dm("1700000000.000300", { thread_ts: "1700000000.000250", parent_user_id: OWNER })));
      ws.send(envelope("e5", chan("1700000000.000350", "<@UBOT> under seori's answer", { thread_ts: "1700000000.000070", parent_user_id: "UBOT" })));
    };
    const got = await collect(adapter(mock, home()), (g) => g.length >= 5);
    expect(got.map((m) => [m.id, m.root, m.rootByOwner, m.rootBySeori])).toEqual([
      ["slack:C1:1700000000.000100", undefined, undefined, undefined],
      ["slack:C1:1700000000.000200", "slack:C1:1700000000.000050", true, undefined],
      ["slack:C1:1700000000.000250", "slack:C1:1700000000.000060", undefined, undefined],
      ["slack:D1:1700000000.000300", undefined, undefined, undefined],
      ["slack:C1:1700000000.000350", "slack:C1:1700000000.000070", undefined, true],
    ]);
  });

  test("users.info still rate-limited after retries logs one line and ends the session instead of dropping the message; it arrives after the reconnect", async () => {
    const mock = startMock();
    mock.usersError = { ok: false, error: "ratelimited" };
    mock.onConnect = (ws, n) => {
      if (n === 2) mock.usersError = undefined;
      ws.send(envelope(`e${n}`, chan("1700000000.000100", "<@UBOT> member", { user: "UOTHER", team: "T1" })));
    };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    let got: InboundMessage[];
    try {
      // Done once the redelivered envelope is acked, so the ack is never raced by the abort.
      got = await collect(adapter(mock, home(), { others: true }), (g) => g.length >= 1 && mock.acks.includes("e2"));
    } finally {
      console.error = error;
    }
    expect(got.map((m) => [m.id, m.from])).toEqual([["slack:C1:1700000000.000100", "UOTHER"]]);
    expect(mock.opens).toBe(2);
    expect(mock.acks).toEqual(["e2"]);
    expect(errors).toEqual(["slack slack: users.info is rate limited for UOTHER; reconnecting so their message is handled again"]);
  });

  test("a users.info no is remembered for 10 minutes, then asked again (a scope added later takes effect without a restart)", async () => {
    const mock = startMock();
    mock.usersError = { ok: false, error: "missing_scope", needed: "users:read" };
    let clock = 0;
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", chan("1700000000.000100", "<@UBOT> one", { user: "UOTHER", team: "T1" })));
      ws.send(envelope("e2", chan("1700000000.000150", "<@UBOT> two", { user: "UOTHER", team: "T1" })));
      ws.send(envelope("e3", chan("1700000000.000200", "<@UBOT> owner", { team: "T1" })));
      ws.send(envelope("e4", chan("1700000000.000300", "<@UBOT> three", { user: "UOTHER", team: "T1" })));
    };
    const error = console.error;
    console.error = () => {};
    try {
      // The owner's message moves the clock past the recheck window; scope is added meanwhile.
      const got = await collect(adapter(mock, home(), { others: true, now: () => clock }), () => mock.acks.length >= 4, async (m) => {
        if (m.from === OWNER) {
          clock += 11 * 60_000;
          mock.usersError = undefined;
        }
      });
      expect(got.map((m) => m.text)).toEqual(["<@UBOT> owner", "<@UBOT> three"]);
    } finally {
      console.error = error;
    }
    expect(mock.usersCalls).toEqual(["UOTHER", "UOTHER"]);
  });

  for (const others of [false, true]) {
    test(`others ${others ? "on delivers people of the bot's workspace with their own id" : "off delivers only the owner"}; outside users, bots and seori never`, async () => {
      const mock = startMock();
      const t1 = { team: "T1" };
      mock.onConnect = (ws) => {
        ws.send(envelope("e1", chan("1700000000.000100", "<@UBOT> hi", { user: "UOTHER", ...t1 })));
        ws.send(envelope("e2", dm("1700000000.000200", { user: "UOTHER", ...t1 })));
        ws.send(envelope("e3", chan("1700000000.000300", "chatter", { user: "UOTHER", ...t1 })));
        ws.send(envelope("e4", chan("1700000000.000400", "<@UBOT> ping", { user: "UB9", bot_id: "B9", ...t1 })));
        ws.send(envelope("e5", chan("1700000000.000500", "<@UBOT> me", { user: "UBOT", bot_id: "B1", ...t1 })));
        ws.send(envelope("e6", chan("1700000000.000600", "thanks", { user: "UOTHER", thread_ts: "1700000000.000100", ...t1 })));
        // Slack Connect: a user of another organization in a shared channel, and a message carrying no workspace.
        ws.send(envelope("e7", chan("1700000000.000700", "<@UBOT> from outside", { user: "UEXT", team: "T1", user_team: "TEXT" })));
        ws.send(envelope("e8", chan("1700000000.000800", "<@UBOT> no team", { user: "UNOTEAM" })));
      };
      const got = await collect(adapter(mock, home(), { others }), () => mock.acks.length >= 8);
      expect(got.map((m) => [m.id, m.from])).toEqual(
        others
          ? [
              ["slack:C1:1700000000.000100", "UOTHER"],
              ["slack:D1:1700000000.000200", "UOTHER"],
              ["slack:C1:1700000000.000600", "UOTHER"],
            ]
          : [],
      );
    });
  }

  for (const others of [false, true]) {
    test(`an edit in a channel follows the same rule (others ${others ? "on" : "off"})`, async () => {
      const mock = startMock();
      mock.onConnect = (ws) => {
        ws.send(envelope("e1", edit(OWNER, "no mention", "1700000000.000100")));
        ws.send(envelope("e2", edit(OWNER, "<@UBOT> now", "1700000000.000200")));
        ws.send(envelope("e3", edit("UOTHER", "<@UBOT> mine", "1700000000.000300", { team: "T1" })));
        ws.send(envelope("e4", edit("UB9", "<@UBOT> bot", "1700000000.000400", { bot_id: "B9" })));
      };
      const got = await collect(adapter(mock, home(), { others }), () => mock.acks.length >= 4);
      const owner = ["slack:C1:1700000000.000200:edit:1700000000.0002009", OWNER, "(edited) <@UBOT> now"];
      const other = ["slack:C1:1700000000.000300:edit:1700000000.0003009", "UOTHER", "(edited) <@UBOT> mine"];
      expect(got.map((m) => [m.id, m.from, m.text])).toEqual(others ? [owner, other] : [owner]);
    });
  }
});

describe("SlackAdapter send", () => {
  test("splits long text, posts every chunk in the target thread, disables unfurls and escapes mentions", async () => {
    const mock = startMock();
    const text = `<!channel> & ${"word ".repeat(1000)}`; // > 3900 chars
    const res = await adapter(mock, home()).send({ chat: "D1", thread: "1700000000.000050", replyTo: "1700000000.000100:edit:1700000050.000000" }, text);
    expect(res).toEqual({ messageId: "1800000000.000001" });
    expect(mock.posts.length).toBe(2);
    for (const p of mock.posts) {
      expect(p).toMatchObject({ channel: "D1", thread_ts: "1700000000.000050", unfurl_links: false, unfurl_media: false });
      expect(String(p["text"]).length).toBeLessThanOrEqual(3900);
    }
    expect(String(mock.posts[0]?.["text"]).startsWith("&lt;!channel&gt; &amp; word")).toBe(true);
    expect(mock.postAuth).toEqual(["Bearer xoxb-1", "Bearer xoxb-1"]);
  });

  test("the target thread places the message; replyTo opens no thread, so a reply without a thread is top level, and only an attached post threads under replyTo", async () => {
    const mock = startMock();
    const a = adapter(mock, home());
    await a.send({ chat: "C1", thread: "1700000000.000001", replyTo: "1700000000.000002" }, "x");
    await a.send({ chat: "C1", replyTo: "1700000000.000003" }, "y");
    await a.send({ chat: "D1", replyTo: "1700000000.000004:edit:1700000000.000005" }, "z");
    await a.send({ chat: "D1", replyTo: "1700000000.000006:edit:1700000000.000007", attached: true }, "alert");
    await a.send({ chat: "C1", thread: "1700000000.000001", replyTo: "1700000000.000008", attached: true }, "progress");
    expect(mock.posts.map((p) => [p["channel"], p["thread_ts"]])).toEqual([
      ["C1", "1700000000.000001"],
      ["C1", undefined],
      ["D1", undefined],
      ["D1", "1700000000.000006"],
      ["C1", "1700000000.000001"],
    ]);
  });

  test("msg send answers where the message was written: top-level DM and channel messages top level, thread replies in their thread; --again, msg edit --reply-of and the owner's thread under the answer follow", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", dm("1700000000.000100")));
      ws.send(envelope("e2", chan("1700000000.000200", "<@UBOT> do x")));
      ws.send(envelope("e3", chan("1700000000.000300", "<@UBOT> here", { thread_ts: "1700000000.000050" })));
      ws.send(envelope("e4", dm("1700000000.000400", { thread_ts: "1700000000.000350" })));
    };
    const root = home();
    const channel = new Channel(root);
    // Stored the way the daemon stores an inbound message (src/daemon.ts).
    const store = async (m: InboundMessage) =>
      void channel.appendInbound({
        id: m.id, kind: "messenger", source: m.source, chat: m.chat, ...(m.thread !== undefined ? { thread: m.thread } : {}), ...(m.root !== undefined ? { root: m.root } : {}),
        ...(m.rootByOwner ? { rootByOwner: true as const } : {}), ...(m.rootBySeori ? { rootBySeori: true as const } : {}), from: m.from, at: m.at, text: m.text,
      });
    expect(await collect(adapter(mock, root), (g) => g.length >= 4, store)).toHaveLength(4);
    const d: MsgDeps = { adapterFor: () => adapter(mock, root), configs: [{ source: "slack", owner: OWNER }], now: () => 1_700_000_100_000 };
    const ids = ["slack:D1:1700000000.000100", "slack:C1:1700000000.000200", "slack:C1:1700000000.000300", "slack:D1:1700000000.000400"];
    for (const id of ids) expect(await msgSend(root, { replyTo: [id], text: `re ${id}` }, d)).toMatchObject({ status: "SENT" });
    expect(await msgSend(root, { replyTo: ["slack:C1:1700000000.000200"], text: "result", again: true }, d)).toMatchObject({ status: "SENT", messageId: "1800000000.000005" });
    expect(mock.posts.map((p) => [p["channel"], p["thread_ts"], p["text"]])).toEqual([
      ["D1", undefined, `re ${ids[0]}`],
      ["C1", undefined, `re ${ids[1]}`],
      ["C1", "1700000000.000050", `re ${ids[2]}`],
      ["D1", "1700000000.000350", `re ${ids[3]}`],
      ["C1", undefined, "result"],
    ]);
    // --reply-of edits the first reply (the status message), top-level like the reply itself.
    expect(await msgEditReplyOf(root, "slack:C1:1700000000.000200", "done", d)).toBe("1800000000.000002");
    expect(mock.updates).toEqual([{ channel: "C1", ts: "1800000000.000002", text: "done" }]);

    // The owner goes on in a thread under seori's top-level answer, without a new mention: it reaches the lead, and
    // it is the owner's alone (seori's message there answered the owner), so --thread and progress may use it.
    mock.history["C1"] = [{ type: "message", user: "UBOT", bot_id: "B1", text: "done", ts: "1800000000.000002" }];
    mock.onConnect = (ws) => ws.send(envelope("e5", chan("1800000000.000010", "and y too", { thread_ts: "1800000000.000002", parent_user_id: "UBOT" })));
    const more = await collect(adapter(mock, root), (g) => g.length >= 1, store);
    expect(more.map((m) => [m.id, m.thread, m.root, m.rootBySeori])).toEqual([["slack:C1:1800000000.000010", "1800000000.000002", "slack:C1:1800000000.000002", true]]);
    expect(channel.othersIds().has("slack:C1:1800000000.000010")).toBe(false);
    expect(channel.inbound().map((r) => r.id)).toContain("slack:C1:1800000000.000010");
  });

  test("429 Retry-After and ok:false ratelimited are waited out and retried", async () => {
    const mock = startMock();
    mock.postAnswers.push(
      () => json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "3" } }),
      () => json({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "2" } }),
    );
    const sleeps: number[] = [];
    const res = await adapter(mock, home(), { sleeps }).send({ chat: "D1" }, "hi");
    expect(res.messageId).toBe("1800000000.000001");
    expect(sleeps).toEqual([3000, 2000]);
    expect(mock.posts.length).toBe(3);
  });

  test("5xx or timeout on send is SendUncertain; a definite Slack error is not", async () => {
    const mock = startMock();
    mock.postAnswers.push(() => new Response("oops", { status: 500 }));
    await expect(adapter(mock, home()).send({ chat: "D1" }, "hi")).rejects.toBeInstanceOf(SendUncertain);

    // Answers only once the adapter gave up on it.
    const late = Promise.withResolvers<void>();
    mock.postAnswers.push(async () => {
      await late.promise;
      return json({ ok: true, ts: "1" });
    });
    await expect(adapter(mock, home(), { options: { timeoutMs: 50 } }).send({ chat: "D1" }, "hi")).rejects.toBeInstanceOf(SendUncertain);
    late.resolve();

    mock.postAnswers.push(() => json({ ok: false, error: "channel_not_found" }));
    const definite = await adapter(mock, home())
      .send({ chat: "D9" }, "hi")
      .catch((e: unknown) => e);
    expect(definite).toBeInstanceOf(SlackApiError);
    expect(definite).not.toBeInstanceOf(SendUncertain);
  });

  test("a later chunk failing after the first went out is SendUncertain; empty text is a definite error", async () => {
    const mock = startMock();
    mock.postAnswers.push((b) => json({ ok: true, channel: b["channel"], ts: "1800000000.000009" }), () => json({ ok: false, error: "msg_too_long" }));
    await expect(adapter(mock, home()).send({ chat: "D1" }, "word ".repeat(1000))).rejects.toBeInstanceOf(SendUncertain);

    const empty = await adapter(mock, home())
      .send({ chat: "D1" }, "  \n ")
      .catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(Error);
    expect(empty).not.toBeInstanceOf(SendUncertain);
  });

  test("internal_error or fatal_error from chat.postMessage may have posted: SendUncertain", async () => {
    const mock = startMock();
    for (const error of ["internal_error", "fatal_error"]) {
      mock.postAnswers.push(() => json({ ok: false, error }));
      await expect(adapter(mock, home()).send({ chat: "D1" }, "hi")).rejects.toBeInstanceOf(SendUncertain);
    }
  });
});

describe("SlackAdapter removed user-token mode", () => {
  test("options.mode user, or a user token or cookie (secrets.json or env) and no botToken, is refused naming the bot app", () => {
    const removed = /Slack user-token mode was removed; create a Slack bot app/;
    expect(() => new SlackAdapter({ source: "slack", owner: OWNER, options: { mode: "user" } }, home(), { env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1" } })).toThrow(removed);
    const root = home();
    writeFileSync(join(root, "secrets.json"), JSON.stringify({ slack: { userToken: "xoxc-1", cookie: "xoxd-1" } }), { mode: 0o600 });
    expect(() => new SlackAdapter({ source: "slack", owner: OWNER }, root, { env: {} })).toThrow(removed);
    expect(() => new SlackAdapter({ source: "slack", owner: OWNER }, home(), { env: { SEORI_SLACK_USER_TOKEN: "xoxc-1", SEORI_SLACK_COOKIE: "xoxd-1" } })).toThrow(removed);
    // A bot token alongside leftover user-mode keys runs as the bot; "bot" is the only mode left, and a typo is refused.
    expect(() => new SlackAdapter({ source: "slack", owner: OWNER }, root, { env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1" } })).not.toThrow();
    expect(() => new SlackAdapter({ source: "slack", owner: OWNER, options: { mode: "bot" } }, home(), { env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1" } })).not.toThrow();
    expect(() => new SlackAdapter({ source: "slack", owner: OWNER, options: { mode: "usr" } }, home(), { env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1" } })).toThrow(/"mode" must be "bot" or left out, got "usr"/);
  });
});

describe("SlackAdapter removed agent mode", () => {
  test("leftover agent options are ignored with one warning per process from receive (the daemon), none from a CLI send or edit", async () => {
    const warned: string[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => void warned.push(a.join(" "));
    const env = { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" };
    try {
      const config = { source: "slack-legacy", owner: OWNER, options: { agent: true, agentStatus: "x" } };
      const leftover = new SlackAdapter(config, home(), { env });
      expect(warned).toEqual([]);
      const stopped = new AbortController();
      stopped.abort();
      await leftover.receive(stopped.signal, async () => {});
      // A restarted receive, even on a new adapter for the same source, does not warn again.
      await new SlackAdapter(config, home(), { env }).receive(stopped.signal, async () => {});
      await new SlackAdapter({ source: "slack-plain", owner: OWNER }, home(), { env }).receive(stopped.signal, async () => {});
    } finally {
      console.error = err;
    }
    expect(warned).toEqual(["slack slack-legacy: Slack agent mode was removed; options agent, agentStatus are ignored (DM replies are no longer forced into threads and no working status is shown)"]);
  });
});

describe("SlackAdapter check", () => {
  test("reports the bot and team; a bad token is a clear error", async () => {
    const mock = startMock();
    expect(await adapter(mock, home()).check()).toBe("bot @seori in team Acme");
    mock.authAnswer = () => json({ ok: false, error: "not_authed" });
    await expect(adapter(mock, home()).check()).rejects.toThrow(/rejected the bot token.*not_authed/);
  });
});

describe("SlackAdapter pairing mode", () => {
  test("passes a live DM from any non-bot user with its real sender; channels, bots, the bot itself, edits and history never pass", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", dm("1700000000.000100", { user: "UBOT" })));
      ws.send(envelope("e2", dm("1700000000.000200", { user: "UX", bot_id: "B1" })));
      ws.send(envelope("e3", { type: "app_mention", channel: "C1", user: "UX", text: "<@UBOT> hi", ts: "1700000000.000300" }));
      ws.send(envelope("e4", { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", message: { type: "message", user: "UX", text: "e", ts: "1700000000.000100", edited: { user: "UX", ts: "1700000000.000400" } }, ts: "1700000000.000401" }));
      ws.send(envelope("e5", dm("1700000000.000500", { user: "UNEW" })));
    };
    const root = home();
    // a known DM channel: its catch-up history (a stranger's old message) must not pair
    writeCursor(root, { channels: { D9: "1600000000.000000" }, threads: {} });
    mock.historyPage = () => ({ ok: true, messages: [{ type: "message", user: "UOLD", text: "old", ts: "1600000001.000000" }], has_more: false });
    const a = new SlackAdapter({ source: "slack", owner: "", options: { apiBase: mock.apiBase } }, root, {
      env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" },
      sleep: async () => {},
      pairing: true,
    });
    const got = await collect(a, () => mock.acks.length >= 5 && mock.historyCalls.length >= 1);
    expect(got).toEqual([{ id: "slack:D1:1700000000.000500", source: "slack", chat: "D1", from: "UNEW", at: 1700000000000, text: "hi 1700000000.000500" }]);
    expect(mock.acks.length).toBe(5);
    expect(mock.historyCalls.length).toBeGreaterThanOrEqual(1);
  });
});
