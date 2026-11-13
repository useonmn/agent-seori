import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "../src/messenger/adapter.ts";
import { compareTs, SlackAdapter } from "../src/messenger/slack.ts";
import { pairOwner } from "../src/pair.ts";

// Slack user-token mode: the account is a real workspace member, polled through the Web API with its token and `d`
// cookie. Time is driven by the injected sleep: each poll ends in one sleep the test releases, never a wall-clock wait.

const OWNER = "UOWNER";
const SELF = "USELF";
/** The adapter's clock: the first start (the cursor's `since`) is 1700000000.000000. */
const NOW = 1_700_000_000_000;
const USER_ENV = { SEORI_SLACK_USER_TOKEN: "xoxc-1", SEORI_SLACK_COOKIE: "xoxd-c%2F1" };
const home = () => mkdtempSync(join(tmpdir(), "seori-slack-user-"));
const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);
const msg = (ts: string, extra: Record<string, unknown> = {}) => ({ type: "message", user: OWNER, text: `hi ${ts}`, ts, ...extra });

type Call = { path: string; auth: string; cookie: string | null; query: URLSearchParams; body: Record<string, unknown> | undefined };
type Mock = {
  apiBase: string;
  calls: Call[];
  /** Per channel, newest first like Slack; filtered by `oldest` (exclusive). */
  history: Record<string, Record<string, unknown>[]>;
  /** `<channel>:<root ts>` -> replies without the parent, filtered by `oldest`. */
  replies: Record<string, Record<string, unknown>[]>;
  counts: { ims?: unknown[]; mpims?: unknown[]; channels?: unknown[] };
  threadView: unknown[];
  /** What conversations.open answers for the owner: the DM channel with them. */
  ownerDm: string;
  /** Methods answered `{ ok: false, error: "unknown_method" }`. */
  refuse: Set<string>;
  authAnswer: () => Response;
  stop: () => void;
};

let mocks: Mock[] = [];
afterEach(() => {
  for (const m of mocks) m.stop();
  mocks = [];
});

function startMock(): Mock {
  let posted = 0;
  const mock: Mock = {
    apiBase: "",
    calls: [],
    history: {},
    replies: {},
    counts: {},
    threadView: [],
    ownerDm: "D1",
    refuse: new Set(),
    authAnswer: () => json({ ok: true, user: "seori", user_id: SELF, team: "Acme", team_id: "T1" }),
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "POST" ? await req.text() : "";
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      const path = url.pathname.replace(/^\/api\//, "");
      mock.calls.push({ path, auth: req.headers.get("authorization") ?? "", cookie: req.headers.get("cookie"), query: url.searchParams, body });
      const q = url.searchParams;
      if (mock.refuse.has(path)) return json({ ok: false, error: "unknown_method" });
      switch (path) {
        case "auth.test":
          return mock.authAnswer();
        case "apps.connections.open":
          return json({ ok: true, url: "ws://127.0.0.1:1/unused" });
        case "conversations.open":
          return json({ ok: true, channel: { id: q.get("users") === OWNER || body?.["users"] === OWNER ? mock.ownerDm : "D-OTHER" } });
        case "client.counts":
          return json({ ok: true, ...mock.counts });
        case "subscriptions.thread.getView":
          return json({ ok: true, threads: mock.threadView });
        case "conversations.history": {
          const oldest = q.get("oldest") ?? "0";
          const messages = (mock.history[q.get("channel") ?? ""] ?? []).filter((m) => compareTs(String(m["ts"]), oldest) > 0);
          return json({ ok: true, messages, has_more: false });
        }
        case "conversations.replies": {
          const channel = q.get("channel") ?? "";
          const root = q.get("ts") ?? "";
          const oldest = q.get("oldest") ?? "0";
          const parent = mock.history[channel]?.find((m) => m["ts"] === root) ?? { type: "message", ts: root, thread_ts: root };
          const replies = (mock.replies[`${channel}:${root}`] ?? []).filter((m) => compareTs(String(m["ts"]), oldest) > 0);
          return json({ ok: true, messages: [parent, ...replies], has_more: false });
        }
        case "chat.postMessage":
          posted++;
          return json({ ok: true, channel: body?.["channel"], ts: `1800000000.00000${posted}` });
        case "chat.update":
        case "reactions.add":
        case "reactions.remove":
          return json({ ok: true });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  mock.apiBase = `http://127.0.0.1:${server.port}/api`;
  mocks.push(mock);
  return mock;
}

/** The injected sleep: each call parks the adapter until the test releases it with next(). */
function manualClock() {
  const sleeps: number[] = [];
  let release: (() => void) | undefined;
  let parked = Promise.withResolvers<void>();
  return {
    sleeps,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      const d = Promise.withResolvers<void>();
      release = d.resolve;
      parked.resolve();
      return d.promise;
    },
    /** Resolves once the adapter sleeps (a poll finished, or a backoff began). */
    parked: async (): Promise<void> => {
      await parked.promise;
      parked = Promise.withResolvers<void>();
    },
    next: (): void => {
      const r = release;
      release = undefined;
      r?.();
    },
  };
}

type Extra = { options?: Record<string, unknown>; env?: Record<string, string | undefined>; sleep?: (ms: number) => Promise<void>; now?: () => number; pairing?: boolean };

function adapter(mock: Mock, root: string, extra: Extra = {}) {
  return new SlackAdapter({ source: "slack", owner: extra.pairing ? "" : OWNER, options: { apiBase: mock.apiBase, ...extra.options } }, root, {
    env: extra.env ?? USER_ENV,
    sleep: extra.sleep ?? (async () => {}),
    now: extra.now ?? (() => NOW),
    ...(extra.pairing ? { pairing: true } : {}),
  });
}

const cursorOf = (root: string) =>
  JSON.parse(readFileSync(join(root, "messenger", "slack", "user-cursor.json"), "utf8")) as { channels: Record<string, string>; threads: Record<string, Record<string, string>> };

/** Starts receive on a manual clock; returns what arrived, the clock, and stop() that aborts and awaits it. */
function run(mock: Mock, root: string, extra: Extra = {}, onMessage: (m: InboundMessage) => Promise<void> = async () => {}) {
  const clock = manualClock();
  const a = adapter(mock, root, { ...extra, sleep: clock.sleep });
  const ac = new AbortController();
  const got: InboundMessage[] = [];
  const done = a.receive(ac.signal, async (m) => {
    await onMessage(m);
    got.push(m);
  });
  return {
    got,
    clock,
    done,
    stop: async () => {
      ac.abort();
      clock.next();
      await done;
    },
  };
}

describe("SlackAdapter user mode selection", () => {
  test("a user token without a bot token selects user mode; a bot token keeps bot mode; options.mode wins", async () => {
    const mock = startMock();
    expect(await adapter(mock, home()).check()).toBe("user @seori in team Acme");
    expect(await adapter(mock, home(), { env: { ...USER_ENV, SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" } }).check()).toBe("bot @seori in team Acme");
    expect(await adapter(mock, home(), { env: { ...USER_ENV, SEORI_SLACK_BOT_TOKEN: "xoxb-1" }, options: { mode: "user" } }).check()).toBe("user @seori in team Acme");

    // secrets.json works the same as the environment
    const root = home();
    writeFileSync(join(root, "secrets.json"), JSON.stringify({ slack: { userToken: "xoxc-2", cookie: "xoxd-2" } }), { mode: 0o600 });
    expect(await adapter(mock, root, { env: {} }).check()).toBe("user @seori in team Acme");
    expect(mock.calls.at(-1)).toMatchObject({ auth: "Bearer xoxc-2", cookie: "d=xoxd-2" });
  });

  test("an explicit mode with missing secrets names what to set; a bad mode or agent with user mode is refused at construction", async () => {
    const mock = startMock();
    const noUser = adapter(mock, home(), { env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1" }, options: { mode: "user" } });
    await expect(noUser.check()).rejects.toThrow(/SEORI_SLACK_USER_TOKEN.*SEORI_SLACK_COOKIE.*"userToken".*"cookie"/);
    const noCookie = adapter(mock, home(), { env: { SEORI_SLACK_USER_TOKEN: "xoxc-1" }, options: { mode: "user" } });
    await expect(noCookie.receive(new AbortController().signal, async () => {})).rejects.toThrow(/SEORI_SLACK_COOKIE/);
    await expect(adapter(mock, home(), { options: { mode: "bot" } }).check()).rejects.toThrow(/SEORI_SLACK_BOT_TOKEN/);

    expect(() => adapter(mock, home(), { options: { mode: "member" } })).toThrow(/"mode" must be "user" or "bot"/);
    expect(() => adapter(mock, home(), { options: { agent: true } })).toThrow(/agent.*bot/);
    expect(() => adapter(mock, home(), { options: { agent: true, mode: "user" } })).toThrow(/agent.*bot/);
  });

  test("the Cookie header goes with every call in user mode and never in bot mode", async () => {
    const mock = startMock();
    mock.counts = { ims: [{ id: "D1", has_unreads: true }] };
    mock.history["D1"] = [msg("1700000000.000100")];
    const r = run(mock, home());
    const a = adapter(mock, home());
    await r.clock.parked();
    await a.send({ chat: "D1" }, "x");
    await a.edit({ chat: "D1" }, "1800000000.000001", "y");
    await a.react("D1", "1700000000.000100", true);
    await r.stop();
    expect(mock.calls.map((c) => c.path)).toEqual(["auth.test", "conversations.open", "subscriptions.thread.getView", "client.counts", "conversations.history", "chat.postMessage", "chat.update", "reactions.add"]);
    expect(mock.calls.every((c) => c.cookie === "d=xoxd-c%2F1" && c.auth === "Bearer xoxc-1")).toBe(true);

    const bot = startMock();
    const b = adapter(bot, home(), { env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1", ...USER_ENV } });
    await b.check();
    await b.send({ chat: "D1" }, "x");
    await b.react("D1", "1700000000.000100", true);
    expect(bot.calls.length).toBe(4);
    expect(bot.calls.every((c) => c.cookie === null)).toBe(true);
  });
});

describe("SlackAdapter user mode receive", () => {
  test("a poll delivers the owner's DM and thread reply with bot-mode ids, skips own, others' and bot messages", async () => {
    const mock = startMock();
    mock.counts = { ims: [{ id: "D1", has_unreads: true }], channels: [{ id: "C9", has_unreads: true, mention_count: 0 }] };
    mock.history["D1"] = [
      msg("1700000000.000500", { user: "UX" }),
      msg("1700000000.000400", { user: SELF, text: "mine" }),
      msg("1700000000.000300", { bot_id: "B1" }),
      msg("1700000000.000200", { subtype: "bot_message", user: undefined, bot_id: "B2" }),
      msg("1700000000.000100"),
    ];
    mock.history["C9"] = [msg("1700000000.000600")]; // unread channel without a mention: not read
    const root = home();
    const r = run(mock, root);
    await r.clock.parked();
    expect(r.got).toEqual([{ id: "slack:D1:1700000000.000100", source: "slack", chat: "D1", from: OWNER, at: 1700000000000, text: "hi 1700000000.000100" }]);
    expect(cursorOf(root).channels["D1"]).toBe("1700000000.000500");
    // this account posted at .000400: its thread is tracked, and the owner answers in it
    expect(Object.keys(cursorOf(root).threads["D1"] ?? {})).toContain("1700000000.000400");
    mock.replies["D1:1700000000.000400"] = [msg("1700000000.000700", { thread_ts: "1700000000.000400" }), msg("1700000000.000800", { thread_ts: "1700000000.000400", user: "UX" })];
    mock.counts = {};
    r.clock.next();
    await r.clock.parked();
    await r.stop();
    expect(r.got.map((m) => [m.id, m.thread, m.text])).toEqual([
      ["slack:D1:1700000000.000100", undefined, "hi 1700000000.000100"],
      ["slack:D1:1700000000.000700", "1700000000.000400", "hi 1700000000.000700"],
    ]);
    expect(cursorOf(root).channels["D1"]).toBe("1700000000.000800");
    expect(mock.calls.some((c) => c.path === "conversations.history" && c.query.get("channel") === "C9")).toBe(false);
    expect(r.clock.sleeps.every((ms) => ms === 60_000)).toBe(true);
  });

  test("a channel mention and a thread from the threads view are read; channel messages need a mention", async () => {
    const mock = startMock();
    mock.counts = { channels: [{ id: "C1", has_unreads: true, mention_count: 1 }] };
    mock.history["C1"] = [msg("1700000000.000200", { text: `<@${SELF}> look &amp; see` }), msg("1700000000.000100", { text: "no mention" })];
    mock.threadView = [{ root_msg: { channel: "C2", ts: "1700000000.000010" }, unread_replies: [msg("1700000000.000300", { thread_ts: "1700000000.000010", text: `<@${SELF}> in a thread` })] }];
    mock.replies["C2:1700000000.000010"] = [msg("1700000000.000300", { thread_ts: "1700000000.000010", text: `<@${SELF}> in a thread` })];
    const r = run(mock, home(), { options: { pollIntervalMs: 5_000 } });
    await r.clock.parked();
    await r.stop();
    expect(r.got.map((m) => [m.id, m.thread, m.text])).toEqual([
      ["slack:C1:1700000000.000200", "1700000000.000200", `<@${SELF}> look & see`],
      ["slack:C2:1700000000.000300", "1700000000.000010", `<@${SELF}> in a thread`],
    ]);
    expect(r.clock.sleeps[0]).toBe(5_000);
  });

  test("the owner's reply in a channel thread the account follows counts without a mention, as a live thread event would", async () => {
    const mock = startMock();
    const reply = msg("1700000000.000300", { thread_ts: "1700000000.000010", text: "and the other one too" });
    mock.threadView = [{ root_msg: { channel: "C3", ts: "1700000000.000010" }, unread_replies: [reply] }];
    mock.replies["C3:1700000000.000010"] = [reply, msg("1700000000.000400", { thread_ts: "1700000000.000010", user: "UX", text: "me too" })];
    const r = run(mock, home());
    await r.clock.parked();
    await r.stop();
    expect(r.got.map((m) => [m.id, m.thread, m.text])).toEqual([["slack:C3:1700000000.000300", "1700000000.000010", "and the other one too"]]);
  });

  test("a colleague's DM thread in the threads view is never opened or read", async () => {
    const mock = startMock();
    const reply = msg("1700000000.000300", { thread_ts: "1700000000.000010", user: "UCOLLEAGUE", text: "about lunch" });
    mock.threadView = [{ root_msg: { channel: "D9", ts: "1700000000.000010" }, unread_replies: [reply] }];
    mock.replies["D9:1700000000.000010"] = [reply];
    mock.history["D9"] = [reply];
    const root = home();
    const r = run(mock, root);
    await r.clock.parked();
    await r.stop();
    expect(r.got).toEqual([]);
    expect(mock.calls.some((c) => c.query.get("channel") === "D9")).toBe(false);
    expect(cursorOf(root).channels["D9"]).toBeUndefined();
  });

  test("the token and cookie are read once, not on every call", async () => {
    const mock = startMock();
    const root = home();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "secrets.json"), JSON.stringify({ slack: { userToken: "xoxc-file", cookie: "xoxd-file" } }), { mode: 0o600 });
    const a = adapter(mock, root, { env: {} });
    await a.send({ chat: "D1" }, "x");
    writeFileSync(join(root, "secrets.json"), JSON.stringify({ slack: { userToken: "xoxc-changed", cookie: "xoxd-changed" } }), { mode: 0o600 });
    await a.send({ chat: "D1" }, "y");
    expect(mock.calls.filter((c) => c.path === "chat.postMessage").map((c) => [c.auth, c.cookie])).toEqual([
      ["Bearer xoxc-file", "d=xoxd-file"],
      ["Bearer xoxc-file", "d=xoxd-file"],
    ]);
  });

  test("the cursor is committed only after onMessage resolved; a rejection rejects receive and the restart redelivers", async () => {
    const mock = startMock();
    mock.counts = { ims: [{ id: "D1", has_unreads: true }] };
    mock.history["D1"] = [msg("1700000000.000100")];
    const root = home();
    const boom = new Error("disk full");
    let seenCursor: string | undefined;
    await expect(
      adapter(mock, root).receive(new AbortController().signal, async () => {
        seenCursor = cursorOf(root).channels["D1"];
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(seenCursor).toBe("1700000000.000000");
    expect(cursorOf(root).channels["D1"]).toBe("1700000000.000000");

    const r = run(mock, root);
    await r.clock.parked();
    await r.stop();
    expect(r.got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
    expect(cursorOf(root).channels["D1"]).toBe("1700000000.000100");
  });

  test("a restart resumes from the saved cursor without replays, even with the DM no longer unread", async () => {
    const mock = startMock();
    mock.counts = { ims: [{ id: "D1", has_unreads: true }] };
    mock.history["D1"] = [msg("1700000000.000100")];
    const root = home();
    const first = run(mock, root);
    await first.clock.parked();
    await first.stop();
    expect(first.got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);

    mock.counts = {}; // read in a browser meanwhile: a known DM is still polled
    mock.history["D1"] = [msg("1700000000.000200"), msg("1700000000.000100")];
    const second = run(mock, root);
    await second.clock.parked();
    await second.stop();
    expect(second.got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000200"]);
    const reads = mock.calls.filter((c) => c.path === "conversations.history");
    expect(reads.at(-1)?.query.get("oldest")).toBe("1700000000.000100");
  });

  test("messages from before the first start are not delivered", async () => {
    const mock = startMock();
    mock.counts = { ims: [{ id: "D1", has_unreads: true }] };
    mock.history["D1"] = [msg("1700000000.000100"), msg("1699999000.000000")];
    const r = run(mock, home());
    await r.clock.parked();
    await r.stop();
    expect(r.got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
  });

  test("transient failures back off and recover; an outage past two minutes rejects with the last error", async () => {
    const mock = startMock();
    let fail = 2;
    mock.authAnswer = () => (fail-- > 0 ? new Response("down", { status: 503 }) : json({ ok: true, user: "seori", user_id: SELF, team: "Acme" }));
    mock.counts = { ims: [{ id: "D1", has_unreads: true }] };
    mock.history["D1"] = [msg("1700000000.000100")];
    let clock = NOW;
    const sleeps: number[] = [];
    let got = 0;
    const ac = new AbortController();
    await adapter(mock, home(), {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
        if (got > 0) ac.abort();
      },
    }).receive(ac.signal, async () => {
      got++;
    });
    expect(got).toBe(1);
    expect(sleeps.some((ms) => ms < 60_000)).toBe(true);

    const down = startMock();
    down.authAnswer = () => new Response("down", { status: 503 });
    clock = NOW;
    const err = await adapter(down, home(), {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    })
      .receive(new AbortController().signal, async () => {})
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^slack slack: no working connection for \d+ s; last error: .*503/);
  });

  test("the account must not be the owner's own: receive and check refuse it, so seori never reads its own replies as commands", async () => {
    const mock = startMock();
    mock.authAnswer = () => json({ ok: true, user: "owner", user_id: OWNER, team: "Acme" });
    mock.counts = { ims: [{ id: "D1", has_unreads: true }] };
    mock.history["D1"] = [msg("1700000000.000100")];
    const err = await adapter(mock, home())
      .receive(new AbortController().signal, async () => {})
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/is the owner's own account.*its own member account/);
    await expect(adapter(mock, home()).check()).rejects.toThrow(/is the owner's own account/);
    expect(mock.calls.some((c) => c.path === "conversations.history")).toBe(false);
  });

  test("only the DM with the owner is read; other people's DMs to the account never are, unread or not", async () => {
    const mock = startMock();
    mock.counts = { ims: [{ id: "D1", has_unreads: true }, { id: "D2", has_unreads: true }], mpims: [{ id: "G1", has_unreads: true, mention_count: 0 }] };
    mock.history["D1"] = [msg("1700000000.000100")];
    mock.history["D2"] = [msg("1700000000.000200", { user: "UCOLLEAGUE" })];
    const root = home();
    const r = run(mock, root);
    await r.clock.parked();
    r.clock.next();
    await r.clock.parked();
    await r.stop();
    expect(r.got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000100"]);
    const read = mock.calls.filter((c) => c.path === "conversations.history").map((c) => c.query.get("channel"));
    expect(new Set(read)).toEqual(new Set(["D1"]));
    expect(Object.keys(cursorOf(root).channels)).toEqual(["D1"]);
  });

  test("auth.test without a user id is retried, never cached as an empty id", async () => {
    const mock = startMock();
    let first = true;
    mock.authAnswer = () => {
      if (first) {
        first = false;
        return json({ ok: true, user: "seori", team: "Acme" });
      }
      return json({ ok: true, user: "seori", user_id: SELF, team: "Acme" });
    };
    mock.counts = { ims: [{ id: "D1", has_unreads: true }] };
    mock.history["D1"] = [msg("1700000000.000300", { user: SELF, text: "mine" }), msg("1700000000.000100")];
    const sleeps: number[] = [];
    const ac = new AbortController();
    const got: string[] = [];
    await adapter(mock, home(), {
      sleep: async (ms) => {
        sleeps.push(ms);
        if (got.length) ac.abort();
      },
    }).receive(ac.signal, async (m) => void got.push(m.text));
    expect(got).toEqual(["hi 1700000000.000100"]);
    expect(mock.calls.filter((c) => c.path === "auth.test")).toHaveLength(2);
    expect(sleeps[0]).toBeLessThan(60_000);
  });

  test("fetchMessage reads with the user token and cookie", async () => {
    const mock = startMock();
    mock.history["D1"] = [msg("1700000000.000100")];
    const got = await adapter(mock, home()).fetchMessage("D1", "1700000000.000100");
    expect(got).toEqual({ from: OWNER, at: 1700000000000, text: "hi 1700000000.000100" });
    const call = mock.calls.find((c) => c.path === "conversations.history")!;
    expect([call.auth, call.cookie]).toEqual(["Bearer xoxc-1", "d=xoxd-c%2F1"]);
  });

  test("invalid_auth or token_revoked rejects receive saying to refresh the user token and cookie", async () => {
    for (const error of ["invalid_auth", "token_revoked"]) {
      const mock = startMock();
      mock.authAnswer = () => json({ ok: false, error });
      const err = await adapter(mock, home())
        .receive(new AbortController().signal, async () => {})
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(new RegExp(`user token.*${error}.*refresh the user token and cookie`));
    }
  });

  test("a web-client method the token may not call is skipped; known DMs are still read", async () => {
    const mock = startMock();
    const root = home();
    mkdirSync(join(root, "messenger", "slack"), { recursive: true });
    writeFileSync(join(root, "messenger", "slack", "user-cursor.json"), JSON.stringify({ since: "1700000000.000000", channels: { D1: "1700000000.000100" }, threads: {} }));
    mock.refuse = new Set(["client.counts", "subscriptions.thread.getView"]);
    mock.history["D1"] = [msg("1700000000.000200"), msg("1700000000.000100")];
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    const r = run(mock, root);
    try {
      await r.clock.parked();
      r.clock.next();
      await r.clock.parked();
      await r.stop();
    } finally {
      console.error = original;
    }
    expect(r.got.map((m) => m.id)).toEqual(["slack:D1:1700000000.000200"]);
    // reported once per method, not on every poll
    expect(errors).toHaveLength(2);
    expect(String(errors[0])).toMatch(/unknown_method/);
  });
});

describe("SlackAdapter user mode send", () => {
  test("send posts with the user token and cookie, escaped, threaded under the reply target", async () => {
    const mock = startMock();
    const res = await adapter(mock, home()).send({ chat: "D1", replyTo: "1700000000.000100" }, "<!channel> hi");
    expect(res).toEqual({ messageId: "1800000000.000001" });
    const post = mock.calls.find((c) => c.path === "chat.postMessage");
    expect(post).toMatchObject({ auth: "Bearer xoxc-1", cookie: "d=xoxd-c%2F1" });
    expect(post?.body).toMatchObject({ channel: "D1", thread_ts: "1700000000.000100", text: "&lt;!channel&gt; hi" });
  });
});

describe("SlackAdapter user mode pairing", () => {
  test("a recent DM from any other human pairs; this account, bots and channel messages never do", async () => {
    const mock = startMock();
    mock.counts = { ims: [{ id: "D1", has_unreads: true }, { id: "D2", has_unreads: true }], channels: [{ id: "C1", mention_count: 1 }] };
    mock.history["D1"] = [msg("1700000000.000300", { user: SELF }), msg("1700000000.000200", { user: "UBOTUSER", bot_id: "B1" })];
    mock.history["D2"] = [msg("1700000000.000400", { user: "UNEW" })];
    mock.history["C1"] = [msg("1700000000.000100", { user: "UX", text: `<@${SELF}> hi` })];
    const root = home();
    const candidates = await pairOwner(root, "slack", { minutes: 1 }, {
      now: () => NOW,
      adapterFor: (config, r, cursorRoot) =>
        new SlackAdapter({ ...config, options: { apiBase: mock.apiBase } }, r, { env: USER_ENV, sleep: async () => {}, now: () => NOW, pairing: true, cursorRoot }),
    });
    expect(candidates.map((c) => [c.id, c.chat])).toEqual([["UNEW", "D2"]]);
  });
});
