import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { type InboundMessage, SendUncertain } from "../src/messenger/adapter.ts";
import { compareTs, SlackAdapter, SlackApiError } from "../src/messenger/slack.ts";

const OWNER = "UOWNER";
const home = () => mkdtempSync(join(tmpdir(), "seori-slack-"));
const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);
const envelope = (id: string, event: Record<string, unknown>) => JSON.stringify({ type: "events_api", envelope_id: id, payload: { event } });
const dm = (ts: string, extra: Record<string, unknown> = {}) => ({ type: "message", channel_type: "im", channel: "D1", user: OWNER, text: `hi ${ts}`, ts, ...extra });

type Mock = {
  apiBase: string;
  opens: number;
  acks: string[];
  posts: Record<string, unknown>[];
  postAuth: string[];
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
  /** Called after hello on each new socket (1-based connection number). */
  onConnect: (ws: ServerWebSocket<unknown>, n: number) => void;
  sendHello: boolean;
  authAnswer: () => Response;
  openAnswer: () => Response;
  postAnswers: Array<(body: Record<string, unknown>) => Response | Promise<Response>>;
  /** Bodies of assistant.threads.setStatus calls, in order. */
  statuses: Record<string, unknown>[];
  statusAnswer: () => Response;
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
    historyCalls: [],
    history: {},
    historyError: {},
    repliesCalls: [],
    replies: {},
    onConnect: () => {},
    sendHello: true,
    authAnswer: () => json({ ok: true, user: "seori", user_id: "UBOT", team: "Acme", team_id: "T1" }),
    openAnswer: () => json({ ok: true, url: `ws://127.0.0.1:${server.port}/link` }),
    postAnswers: [],
    statuses: [],
    statusAnswer: () => json({ ok: true }),
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
      if (url.pathname === "/api/conversations.replies") {
        const q = url.searchParams;
        mock.repliesCalls.push(q);
        const channel = q.get("channel") ?? "";
        const root = q.get("ts") ?? "";
        const oldest = q.get("oldest") ?? "0";
        const parent = mock.history[channel]?.find((m) => m["ts"] === root) ?? { type: "message", ts: root, thread_ts: root };
        const replies = (mock.replies[`${channel}:${root}`] ?? []).filter((m) => compareTs(String(m["ts"]), oldest) > 0);
        return json({ ok: true, messages: [parent, ...replies], has_more: false });
      }
      if (url.pathname === "/api/assistant.threads.setStatus") {
        mock.statuses.push((await req.json()) as Record<string, unknown>);
        return mock.statusAnswer();
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

type Extra = { sleeps?: number[]; options?: Record<string, unknown>; env?: Record<string, string | undefined>; sleep?: (ms: number) => Promise<void>; now?: () => number; every?: (tick: () => Promise<void>, ms: number) => () => void };

function adapter(mock: Mock, root: string, extra: Extra = {}) {
  return new SlackAdapter({ source: "slack", owner: OWNER, options: { apiBase: mock.apiBase, ...extra.options } }, root, {
    env: extra.env ?? { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" },
    sleep:
      extra.sleep ??
      (async (ms) => {
        extra.sleeps?.push(ms);
        await Bun.sleep(1);
      }),
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.every ? { every: extra.every } : {}),
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

  test("channel mentions thread under the owner's message; DM thread replies keep their thread", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", { type: "app_mention", channel: "C1", user: OWNER, text: "<@UBOT> look &amp; see", ts: "1700000000.000100" }));
      ws.send(envelope("e2", dm("1700000000.000200", { thread_ts: "1700000000.000150" })));
    };
    const got = await collect(adapter(mock, home()), (g) => g.length >= 2);
    expect(got.map((m) => [m.id, m.thread, m.text])).toEqual([
      ["slack:C1:1700000000.000100", "1700000000.000100", "<@UBOT> look & see"],
      ["slack:D1:1700000000.000200", "1700000000.000150", "hi 1700000000.000200"],
    ]);
  });

  test("a thread reply carries the id of the thread's first message; a top-level message carries none", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", dm("1700000000.000200", { thread_ts: "1700000000.000150" })));
      ws.send(envelope("e2", dm("1700000000.000300")));
    };
    const got = await collect(adapter(mock, home()), (g) => g.length >= 2);
    expect(got.map((m) => m.replyTo)).toEqual([{ id: "slack:D1:1700000000.000150" }, undefined]);
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
    let connected = false;
    mock.onConnect = () => {
      connected = true;
    };
    const ac = new AbortController();
    const run = adapter(mock, home()).receive(ac.signal, async () => {});
    await until(() => connected);
    await Bun.sleep(20);
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

    // Offline: the owner answers in the thread of their own message (where seori replies), in the thread of a new seori
    // message, and once more with "also send to direct message".
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
});

describe("SlackAdapter agent mode", () => {
  const agent = (mock: Mock, root: string, options: Record<string, unknown> = {}) => adapter(mock, root, { options: { agent: true, ...options } });
  /** The working-status refresh, captured instead of run by a timer: the test runs each refresh and awaits it. */
  const manualRefresh = () => {
    let tick: (() => Promise<void>) | undefined;
    return { every: (t: () => Promise<void>) => ((tick = t), () => {}), refresh: () => tick!() };
  };

  test("every owner DM gets its own thread and a working status once delivered; without agent mode nothing changes", async () => {
    const mock = startMock();
    mock.onConnect = (ws) => {
      ws.send(envelope("e1", dm("1700000000.000100")));
      ws.send(envelope("e2", dm("1700000000.000200", { thread_ts: "1700000000.000150" })));
      ws.send(envelope("e3", dm("1700000000.000300", { user: "USTRANGER" })));
    };
    const got = await collect(agent(mock, home(), { agentStatus: "작업 중..." }), () => mock.statuses.length >= 2 && mock.acks.length >= 3);
    expect(got.map((m) => [m.id, m.thread])).toEqual([
      ["slack:D1:1700000000.000100", "1700000000.000100"],
      ["slack:D1:1700000000.000200", "1700000000.000150"],
    ]);
    expect(mock.statuses).toEqual([
      { channel_id: "D1", thread_ts: "1700000000.000100", status: "작업 중..." },
      { channel_id: "D1", thread_ts: "1700000000.000150", status: "작업 중..." },
    ]);

    const plain = startMock();
    plain.onConnect = (ws) => ws.send(envelope("e1", dm("1700000000.000100")));
    const before = await collect(adapter(plain, home()), (g) => g.length >= 1);
    expect(before[0]?.thread).toBeUndefined();
    expect(plain.statuses).toEqual([]);
  });

  test("the status is set again until seori replies in the thread; a top-level reply clears it; the limit ends it", async () => {
    const mock = startMock();
    let socket: ServerWebSocket<unknown> | undefined;
    mock.onConnect = (ws) => {
      socket = ws;
      ws.send(envelope("e1", dm("1700000000.000100")));
      ws.send(envelope("e2", dm("1700000000.000200")));
    };
    const working = (thread: string) => ({ channel_id: "D1", thread_ts: thread, status: "Working..." });
    const m = manualRefresh();
    let finished = false;
    const run = collect(adapter(mock, home(), { options: { agent: true, agentStatus: "Working..." }, every: m.every }), () => finished, undefined, 3_000);
    try {
      await until(() => mock.statuses.length >= 2, 3_000);
      await m.refresh();
      expect(mock.statuses).toEqual([working("1700000000.000100"), working("1700000000.000200"), working("1700000000.000100"), working("1700000000.000200")]);
      socket!.send(envelope("e3", dm("1700000000.000300", { user: "UBOT", bot_id: "B1", thread_ts: "1700000000.000100" })));
      socket!.send(envelope("e4", dm("1700000000.000400", { user: "UBOT", bot_id: "B1" })));
      await until(() => mock.acks.length >= 4 && mock.statuses.length >= 5, 3_000);
      // Two refresh periods after both threads were answered: nothing is set again.
      await m.refresh();
      await m.refresh();
    } finally {
      finished = true;
      await run;
    }
    expect(mock.statuses.slice(4)).toEqual([{ channel_id: "D1", thread_ts: "1700000000.000200", status: "" }]);

    let clock = 0;
    const limited = startMock();
    limited.onConnect = (ws) => ws.send(envelope("e1", dm("1700000000.000100")));
    const l = manualRefresh();
    let done = false;
    const limitedRun = collect(adapter(limited, home(), { options: { agent: true, statusLimitMs: 1_000 }, now: () => (clock += 400), every: l.every }), () => done, undefined, 3_000);
    try {
      await until(() => limited.statuses.length >= 1, 3_000);
      // Each refresh reads the clock once (+400 ms): the third is past the 1 s limit and clears the status.
      await l.refresh();
      await l.refresh();
      await l.refresh();
    } finally {
      done = true;
      await limitedRun;
    }
    expect(limited.statuses.at(-1)).toEqual({ channel_id: "D1", thread_ts: "1700000000.000100", status: "" });
    expect(limited.statuses.filter((s) => s["status"] === "")).toHaveLength(1);
  });

  test("a refused status never blocks delivery and is not retried by the refresh", async () => {
    const mock = startMock();
    mock.statusAnswer = () => json({ ok: false, error: "missing_scope", needed: "assistant:write" });
    mock.onConnect = (ws) => ws.send(envelope("e1", dm("1700000000.000100")));
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    const m = manualRefresh();
    let finished = false;
    try {
      const run = collect(adapter(mock, home(), { options: { agent: true }, every: m.every }), () => finished, undefined, 3_000);
      await until(() => errors.length >= 1, 3_000);
      // Two refresh periods after the refusal came back.
      await m.refresh();
      await m.refresh();
      finished = true;
      expect((await run).map((m) => m.thread)).toEqual(["1700000000.000100"]);
    } finally {
      finished = true;
      console.error = original;
    }
    expect(mock.statuses.length).toBe(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/working status for D1:1700000000.000100 failed: .*missing_scope/);
  });
});

describe("SlackAdapter send", () => {
  test("splits long text, threads every chunk under the reply target, disables unfurls and escapes mentions", async () => {
    const mock = startMock();
    const text = `<!channel> & ${"word ".repeat(1000)}`; // > 3900 chars
    const res = await adapter(mock, home()).send({ chat: "D1", replyTo: "1700000000.000100:edit:1700000050.000000" }, text);
    expect(res).toEqual({ messageId: "1800000000.000001" });
    expect(mock.posts.length).toBe(2);
    for (const p of mock.posts) {
      expect(p).toMatchObject({ channel: "D1", thread_ts: "1700000000.000100", unfurl_links: false, unfurl_media: false });
      expect(String(p["text"]).length).toBeLessThanOrEqual(3900);
    }
    expect(String(mock.posts[0]?.["text"]).startsWith("&lt;!channel&gt; &amp; word")).toBe(true);
    expect(mock.postAuth).toEqual(["Bearer xoxb-1", "Bearer xoxb-1"]);
  });

  test("a target thread wins; without one the message is top level", async () => {
    const mock = startMock();
    const a = adapter(mock, home());
    await a.send({ chat: "C1", thread: "1700000000.000001", replyTo: "1700000000.000002" }, "x");
    await a.send({ chat: "D1" }, "y");
    expect(mock.posts[0]?.["thread_ts"]).toBe("1700000000.000001");
    expect(mock.posts[1]?.["thread_ts"]).toBeUndefined();
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

    mock.postAnswers.push(async () => {
      await Bun.sleep(300);
      return json({ ok: true, ts: "1" });
    });
    await expect(adapter(mock, home(), { options: { timeoutMs: 50 } }).send({ chat: "D1" }, "hi")).rejects.toBeInstanceOf(SendUncertain);

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
