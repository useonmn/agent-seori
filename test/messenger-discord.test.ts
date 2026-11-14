import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { type InboundMessage, SendUncertain } from "../src/messenger/adapter.ts";
import { CursorFile } from "../src/messenger/common.ts";
import { type DiscordCursor, DiscordAdapter } from "../src/messenger/discord.ts";

const OWNER = "42";
const home = () => mkdtempSync(join(tmpdir(), "seori-discord-"));

type Msg = Record<string, unknown> & { id: string; channel_id: string };
const msg = (id: string, over: Partial<Msg> = {}): Msg => ({
  id,
  channel_id: "C1",
  type: 0,
  content: `m${id}`,
  timestamp: "2026-11-07T00:00:00.000Z",
  author: { id: OWNER },
  attachments: [],
  ...over,
});

type PostMode = "ok" | "429" | "500" | "400" | "hang";
type Frame = { op: number; d: { session_id: string; seq: number | null } };

/** Discord stand-in: REST under /api/v10 and the gateway websocket at /gw on the same port. */
class MockDiscord {
  readonly server;
  sockets = new Set<ServerWebSocket<unknown>>();
  heartbeatInterval = 10_000;
  ack = true;
  identifies = 0;
  resumes: { session_id: string; seq: number | null }[] = [];
  closeCodes: number[] = [];
  identifyClose: number | undefined;
  session: string | undefined;
  seq = 0;
  log: { s: number; t: string; d: unknown }[] = [];
  afterReady: [string, unknown][] = [];
  history: Record<string, Msg[]> = {};
  historyCalls: string[] = [];
  /** Server (guild text) channels, in server G1; every other channel id answers GET /channels/{id} as a DM. */
  guildChannels = new Set<string>();
  /** GET /channels/{id} answers this channel object instead (a thread, a channel of another server). */
  channelInfo: Record<string, Record<string, unknown>> = {};
  /** GET /channels/{id} answers this HTTP status instead (403 no access, 404 gone). */
  channelStatus: Record<string, number> = {};
  channelCalls: string[] = [];
  /** `<guild>:<user>` → the member object GET /guilds/{guild}/members/{user} answers; anyone else is 404 Unknown Member. */
  members: Record<string, Record<string, unknown>> = {};
  /** Servers the bot is not in: GET /guilds/{id}/members/{user} answers 403 Missing Access. */
  notIn = new Set<string>();
  memberCalls: string[] = [];
  posts: { channel: string; body: Record<string, unknown> }[] = [];
  postPlan: PostMode[] = [];
  gatewayStatus = 200;
  historyStatus = 200;
  nextId = 900;
  /** A `hang` post answers only once this resolves (at the end of the test, after the adapter gave up). */
  readonly hung = Promise.withResolvers<void>();

  constructor() {
    const self = this;
    this.server = Bun.serve({
      port: 0,
      async fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/gw") return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
        return self.rest(req, url);
      },
      websocket: {
        open(ws) {
          self.sockets.add(ws);
          ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: self.heartbeatInterval } }));
        },
        message(ws, raw) {
          self.onFrame(ws, JSON.parse(String(raw)) as Frame);
        },
        close(ws, code) {
          self.sockets.delete(ws);
          self.closeCodes.push(code);
        },
      },
    });
  }

  get base() {
    return `http://127.0.0.1:${this.server.port}/api/v10`;
  }
  get ws() {
    return `ws://127.0.0.1:${this.server.port}/gw`;
  }

  private onFrame(ws: ServerWebSocket<unknown>, p: Frame) {
    if (p.op === 1) {
      if (this.ack) ws.send(JSON.stringify({ op: 11 }));
    } else if (p.op === 2) {
      this.identifies++;
      if (this.identifyClose !== undefined) return ws.close(this.identifyClose);
      this.session = `S${this.identifies}`;
      this.seq = 0;
      this.log = [];
      this.emit("READY", { session_id: this.session, resume_gateway_url: this.ws, user: { id: "BOT" } });
      for (const [t, d] of this.afterReady.splice(0)) this.emit(t, d);
    } else if (p.op === 6) {
      this.resumes.push({ session_id: p.d.session_id, seq: p.d.seq });
      if (p.d.session_id !== this.session) return ws.send(JSON.stringify({ op: 9, d: false }));
      for (const e of this.log) if (e.s > (p.d.seq ?? 0)) ws.send(JSON.stringify({ op: 0, ...e }));
      ws.send(JSON.stringify({ op: 0, s: null, t: "RESUMED", d: {} }));
    }
  }

  /** Dispatches an event to the live socket(s) and keeps it for a later resume. */
  emit(t: string, d: unknown) {
    const e = { s: ++this.seq, t, d };
    this.log.push(e);
    for (const ws of this.sockets) ws.send(JSON.stringify({ op: 0, ...e }));
  }

  send(p: unknown) {
    for (const ws of this.sockets) ws.send(JSON.stringify(p));
  }

  private async rest(req: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/api\/v10/, "");
    if (req.headers.get("authorization") !== "Bot T0K") return Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 });
    if (path === "/gateway/bot") return Response.json({ url: this.ws }, { status: this.gatewayStatus });
    if (path === "/users/@me") return Response.json({ id: "BOT", username: "seori" });
    const ch = /^\/channels\/([^/]+)$/.exec(path);
    if (ch && req.method === "GET") {
      this.channelCalls.push(ch[1]!);
      const status = this.channelStatus[ch[1]!];
      if (status) return Response.json({ message: "nope", code: status === 404 ? 10003 : 50001 }, { status });
      return Response.json(this.channelInfo[ch[1]!] ?? (this.guildChannels.has(ch[1]!) ? { id: ch[1], type: 0, guild_id: "G1" } : { id: ch[1], type: 1 }));
    }
    const gm = /^\/guilds\/([^/]+)\/members\/([^/]+)$/.exec(path);
    if (gm && req.method === "GET") {
      this.memberCalls.push(`${gm[1]}:${gm[2]}`);
      if (this.notIn.has(gm[1]!)) return Response.json({ message: "Missing Access", code: 50001 }, { status: 403 });
      const member = this.members[`${gm[1]}:${gm[2]}`];
      return member ? Response.json(member) : Response.json({ message: "Unknown Member", code: 10007 }, { status: 404 });
    }
    const m = /^\/channels\/([^/]+)\/messages$/.exec(path);
    if (m && req.method === "GET") {
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      this.historyCalls.push(`${m[1]}:${after}`);
      if (this.historyStatus !== 200) return new Response("busy", { status: this.historyStatus });
      const oldestFirst = (this.history[m[1]!] ?? []).filter((x) => BigInt(x.id) > after).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      return Response.json(oldestFirst.slice(0, limit).reverse()); // Discord answers newest first
    }
    if (m && req.method === "POST") {
      const mode = this.postPlan.shift() ?? "ok";
      const body = (await req.json()) as Record<string, unknown>;
      if (mode === "429") return Response.json({ retry_after: 0.05, global: false }, { status: 429 });
      if (mode === "500") return new Response("oops", { status: 500 });
      if (mode === "400") return Response.json({ code: 50035 }, { status: 400 });
      if (mode === "hang") {
        await this.hung.promise;
        return Response.json({ id: "late" });
      }
      this.posts.push({ channel: m[1]!, body });
      return Response.json({ id: String(this.nextId++), channel_id: m[1] });
    }
    return new Response("not found", { status: 404 });
  }
}

let mocks: MockDiscord[] = [];
afterEach(() => {
  for (const m of mocks) {
    m.hung.resolve();
    m.server.stop(true);
  }
  mocks = [];
});
const mock = () => {
  const m = new MockDiscord();
  mocks.push(m);
  return m;
};

function adapter(
  m: MockDiscord,
  root: string,
  extra: { sleeps?: number[]; now?: () => number; token?: string; options?: Record<string, unknown>; guilds?: string[]; ownerNeedsMention?: boolean } = {},
) {
  const others = extra.guilds ? { others: true, guilds: extra.guilds } : {};
  const mention = extra.ownerNeedsMention !== undefined ? { ownerNeedsMention: extra.ownerNeedsMention } : {};
  return new DiscordAdapter({ source: "discord", owner: OWNER, ...others, ...mention, options: { apiBase: m.base, wsUrl: m.ws, timeoutMs: 200, ...extra.options } }, root, {
    env: { SEORI_DISCORD_TOKEN: extra.token ?? "T0K" },
    sleep: async (ms) => {
      extra.sleeps?.push(ms);
      await Bun.sleep(1);
    },
    ...(extra.now ? { now: extra.now } : {}),
  });
}

const cursorOf = (root: string) => CursorFile.for<DiscordCursor>(root, "discord").load();

/** Runs receive until `want` messages arrived (or `ms` passed), then aborts and returns them. */
async function collect(a: DiscordAdapter, want: number, onMessage: (m: InboundMessage) => Promise<void> = async () => {}, ms = 1_500) {
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

const until = async (cond: () => boolean, ms = 1_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
};

describe("DiscordAdapter receive", () => {
  test("delivers owner messages with discord:<channel>:<id>, drops others and bots, and commits past them", async () => {
    const m = mock();
    const root = home();
    m.afterReady = [
      ["MESSAGE_CREATE", msg("101")],
      ["MESSAGE_CREATE", msg("102", { author: { id: "7" } })],
      ["MESSAGE_CREATE", msg("103", { author: { id: OWNER, bot: true } })],
      ["MESSAGE_CREATE", msg("104", { content: "" })], // nothing to say: skipped
      ["MESSAGE_CREATE", msg("105", { type: 7 })], // a system message
      ["MESSAGE_CREATE", msg("106", { content: "last" })],
    ];
    const got = await collect(adapter(m, root), 2);
    expect(got).toEqual([
      { id: "discord:C1:101", source: "discord", chat: "C1", from: OWNER, at: Date.parse("2026-11-07T00:00:00.000Z"), text: "m101" },
      { id: "discord:C1:106", source: "discord", chat: "C1", from: OWNER, at: Date.parse("2026-11-07T00:00:00.000Z"), text: "last" },
    ]);
    const c = cursorOf(root)!;
    expect(c.channels).toEqual({ C1: "106" });
    expect(c.session).toEqual({ sessionId: "S1", resumeUrl: m.ws, seq: 7 });
    expect(m.identifies).toBe(1);
  });

  test("a rejected onMessage is redelivered with the same id (resume replays from the committed seq)", async () => {
    const m = mock();
    const root = home();
    m.afterReady = [["MESSAGE_CREATE", msg("201")]];
    let calls = 0;
    const got = await collect(adapter(m, root), 1, async () => {
      if (++calls === 1) throw new Error("lead busy");
    });
    expect(calls).toBe(2);
    expect(got.map((x) => x.id)).toEqual(["discord:C1:201"]);
    expect(m.identifies).toBe(1);
    expect(m.resumes).toEqual([{ session_id: "S1", seq: 1 }]);
    expect(cursorOf(root)!.channels).toEqual({ C1: "201" });
  });

  test("a restart resumes the saved session without replaying committed messages, and closes with 4000", async () => {
    const m = mock();
    const root = home();
    m.afterReady = [["MESSAGE_CREATE", msg("301")]];
    expect((await collect(adapter(m, root), 1)).map((x) => x.id)).toEqual(["discord:C1:301"]);
    await until(() => m.closeCodes.length > 0);
    expect(m.closeCodes).toEqual([4000]);
    m.emit("MESSAGE_CREATE", msg("302")); // arrives while seori is down
    const got = await collect(adapter(m, root), 1);
    expect(got.map((x) => x.id)).toEqual(["discord:C1:302"]);
    expect(m.identifies).toBe(1);
    expect(m.resumes).toEqual([{ session_id: "S1", seq: 2 }]);
  });

  test("a fresh identify catches up tracked channels oldest first, paging, without double delivery", async () => {
    const m = mock();
    const root = home();
    CursorFile.for<DiscordCursor>(root, "discord").save({ channels: { C1: "1000" } });
    m.history["C1"] = Array.from({ length: 150 }, (_, i) => msg(String(1001 + i), i === 5 ? { author: { id: "7" } } : {}));
    m.afterReady = [
      ["MESSAGE_CREATE", msg("1150")], // already caught up
      ["MESSAGE_CREATE", msg("1151")],
    ];
    const got = await collect(adapter(m, root), 150);
    const ids = got.map((x) => x.id.split(":")[2]!);
    expect(ids.length).toBe(150);
    expect(ids[0]).toBe("1001");
    expect(ids).not.toContain("1006");
    expect(ids.slice(-2)).toEqual(["1150", "1151"]);
    expect(new Set(ids).size).toBe(150);
    expect(m.historyCalls).toEqual(["C1:1000", "C1:1100"]); // the second page is short: done
    expect(cursorOf(root)!.channels).toEqual({ C1: "1151" });
  });

  test("an edit becomes an :edit:<stamp> id with (edited) text; attachments become lines", async () => {
    const m = mock();
    const root = home();
    const file = { filename: "a.png", content_type: "image/png", size: 12, url: "https://cdn/a.png" };
    m.afterReady = [
      ["MESSAGE_UPDATE", msg("401", { content: "fixed", edited_timestamp: "2026-11-07T00:00:05.000Z" })],
      ["MESSAGE_UPDATE", msg("401", { content: "embed resolved", edited_timestamp: null })],
      ["MESSAGE_CREATE", msg("402", { content: "", attachments: [file] })],
      ["MESSAGE_CREATE", msg("403", { content: "look", attachments: [file] })],
    ];
    const got = await collect(adapter(m, root), 3);
    const stamp = String(Date.parse("2026-11-07T00:00:05.000Z"));
    expect(got.map((x) => [x.id, x.text])).toEqual([
      [`discord:C1:401:edit:${stamp}`, "(edited) fixed"],
      ["discord:C1:402", "[attachment: a.png (image/png, 12 bytes) https://cdn/a.png]"],
      ["discord:C1:403", "look\n[attachment: a.png (image/png, 12 bytes) https://cdn/a.png]"],
    ]);
    expect(got[0]!.at).toBe(Date.parse("2026-11-07T00:00:05.000Z"));
  });

  test("in a server channel the owner needs no mention, edits included; with ownerNeedsMention only a mention of the bot or a reply to it is; DMs need neither", async () => {
    const g = (id: string, over: Partial<Msg> = {}) => msg(id, { guild_id: "G1", ...over });
    const edited = "2026-11-07T00:00:05.000Z";
    const events: [string, unknown][] = [
      ["MESSAGE_CREATE", g("501", { content: "chatter" })],
      ["MESSAGE_CREATE", g("502", { content: "<@BOT> hi", mentions: [{ id: "BOT" }] })],
      ["MESSAGE_CREATE", g("503", { type: 19, content: "on it?", referenced_message: { author: { id: "BOT" } } })],
      ["MESSAGE_CREATE", g("504", { type: 19, content: "to myself", referenced_message: { author: { id: OWNER } } })],
      ["MESSAGE_UPDATE", g("501", { content: "still chatter", edited_timestamp: edited })],
      ["MESSAGE_UPDATE", g("502", { content: "<@BOT> hello", mentions: [{ id: "BOT" }], edited_timestamp: edited })],
      ["MESSAGE_CREATE", msg("505", { content: "in a DM" })],
    ];
    const m = mock();
    m.afterReady = [...events];
    const got = await collect(adapter(m, home()), 7);
    expect(got.map((x) => [x.id, x.text])).toEqual([
      ["discord:C1:501", "chatter"],
      ["discord:C1:502", "<@BOT> hi"],
      ["discord:C1:503", "on it?"],
      ["discord:C1:504", "to myself"],
      [`discord:C1:501:edit:${Date.parse(edited)}`, "(edited) still chatter"],
      [`discord:C1:502:edit:${Date.parse(edited)}`, "(edited) <@BOT> hello"],
      ["discord:C1:505", "in a DM"],
    ]);

    const strict = mock();
    strict.afterReady = [...events];
    const addressed = await collect(adapter(strict, home(), { ownerNeedsMention: true }), 4);
    expect(addressed.map((x) => [x.id, x.text])).toEqual([
      ["discord:C1:502", "<@BOT> hi"],
      ["discord:C1:503", "on it?"],
      [`discord:C1:502:edit:${Date.parse(edited)}`, "(edited) <@BOT> hello"],
      ["discord:C1:505", "in a DM"],
    ]);
  });

  test("the owner needs no mention in a thread or a server channel, live and on catch-up; someone else's chatter is still dropped", async () => {
    const m = mock();
    const root = home();
    CursorFile.for<DiscordCursor>(root, "discord").save({ channels: { C2: "1000", T1: "1000" } });
    m.channelInfo = {
      C2: { id: "C2", type: 0, guild_id: "G1" },
      T1: { id: "T1", type: 11, guild_id: "G1", parent_id: "C2", owner_id: OWNER },
    };
    m.history["C2"] = [msg("1001", { channel_id: "C2", content: "while you were down" }), msg("1002", { channel_id: "C2", author: { id: "7" }, content: "chatter" })];
    m.history["T1"] = [msg("1001", { channel_id: "T1", content: "in the thread too" })];
    m.afterReady = [
      ["MESSAGE_CREATE", msg("1101", { channel_id: "T1", guild_id: "G1", content: "live in the thread" })],
      ["MESSAGE_CREATE", msg("1102", { channel_id: "C2", guild_id: "G1", author: { id: "7" }, content: "more chatter" })],
      ["MESSAGE_CREATE", msg("1103", { channel_id: "C2", guild_id: "G1", content: "live in the channel" })],
    ];
    const got = await collect(adapter(m, root, { guilds: ["G1"] }), 4);
    expect(got.map((x) => [x.id, x.from, x.root, x.text])).toEqual([
      ["discord:C2:1001", OWNER, undefined, "while you were down"],
      ["discord:T1:1001", OWNER, "discord:C2:T1", "in the thread too"],
      ["discord:T1:1101", OWNER, "discord:C2:T1", "live in the thread"],
      ["discord:C2:1103", OWNER, undefined, "live in the channel"],
    ]);
    expect(cursorOf(root)!.channels).toEqual({ C2: "1103", T1: "1101" });
  });

  test("catch-up skips a channel it may not see (kept) or that is gone (forgotten); the others are still caught up", async () => {
    const m = mock();
    const root = home();
    CursorFile.for<DiscordCursor>(root, "discord").save({ channels: { C3: "1000", C4: "1000", C1: "1000" } });
    m.channelStatus = { C3: 403, C4: 404 };
    m.history["C1"] = [msg("1001")];
    const got = await collect(adapter(m, root), 1);
    expect(got.map((x) => x.id)).toEqual(["discord:C1:1001"]);
    expect(cursorOf(root)!.channels).toEqual({ C3: "1000", C1: "1001" });
  });

  test("with ownerNeedsMention, catch-up of a server channel delivers only what mentions the bot; a resumed session asks /users/@me who the bot is", async () => {
    const m = mock();
    const root = home();
    CursorFile.for<DiscordCursor>(root, "discord").save({ channels: { C2: "1000" } });
    m.guildChannels.add("C2");
    m.history["C2"] = [msg("1001", { channel_id: "C2", content: "chatter" }), msg("1002", { channel_id: "C2", content: "<@BOT> look", mentions: [{ id: "BOT" }] })];
    const got = await collect(adapter(m, root, { ownerNeedsMention: true }), 1);
    expect(got.map((x) => x.id)).toEqual(["discord:C2:1002"]);

    // Restarted: the session resumes (no READY, so no bot id from it) and a live server mention still arrives.
    await until(() => m.closeCodes.length > 0);
    m.emit("MESSAGE_CREATE", msg("1003", { channel_id: "C2", guild_id: "G1", content: "<@BOT> again", mentions: [{ id: "BOT" }] }));
    const again = await collect(adapter(m, root, { ownerNeedsMention: true }), 1);
    expect(again.map((x) => x.id)).toEqual(["discord:C2:1003"]);
    expect(m.resumes.length).toBe(1);
  });

  test("only the owner is delivered: another person's mention or DM, and a bot's mention, are dropped", async () => {
    const m = mock();
    m.afterReady = [
      ["MESSAGE_CREATE", msg("601", { guild_id: "G1", author: { id: "7" }, content: "<@BOT> q", mentions: [{ id: "BOT" }] })],
      ["MESSAGE_CREATE", msg("602", { author: { id: "7" }, content: "dm" })],
      ["MESSAGE_CREATE", msg("603", { guild_id: "G1", author: { id: "9", bot: true }, content: "<@BOT> beep", mentions: [{ id: "BOT" }] })],
      ["MESSAGE_CREATE", msg("604", { content: "owner" })],
    ];
    const got = await collect(adapter(m, home()), 1);
    expect(got.map((x) => [x.id, x.from])).toEqual([["discord:C1:604", OWNER]]);
    expect(m.memberCalls).toEqual([]); // others off: nobody is looked up
  });

  test("with others, a non-owner in a server of guilds is delivered under the addressing rule; other servers, bots and webhooks are not", async () => {
    const m = mock();
    m.guildChannels.add("C1");
    const g = (id: string, guild: string, over: Partial<Msg> = {}) => msg(id, { guild_id: guild, author: { id: "7" }, content: `<@BOT> ${id}`, mentions: [{ id: "BOT" }], ...over });
    const edited = "2026-11-07T00:00:05.000Z";
    m.afterReady = [
      ["MESSAGE_CREATE", g("701", "G1")],
      ["MESSAGE_CREATE", g("702", "G2")], // a server not in guilds
      ["MESSAGE_CREATE", g("703", "G1", { content: "chatter", mentions: [] })], // not addressed
      ["MESSAGE_CREATE", g("704", "G1", { author: { id: "W1" }, webhook_id: "W1" })],
      ["MESSAGE_CREATE", g("705", "G1", { author: { id: "9", bot: true } })],
      ["MESSAGE_CREATE", g("706", "G1", { type: 19, content: "and?", mentions: [], referenced_message: { author: { id: "BOT" } } })],
      ["MESSAGE_UPDATE", g("702", "G2", { edited_timestamp: edited })],
      ["MESSAGE_UPDATE", g("701", "G1", { content: "<@BOT> 701 fixed", edited_timestamp: edited })],
      ["MESSAGE_CREATE", g("707", "G2", { author: { id: OWNER } })], // the owner is answered in any server
    ];
    const got = await collect(adapter(m, home(), { guilds: ["G1"] }), 4);
    expect(got.map((x) => [x.id, x.from])).toEqual([
      ["discord:C1:701", "7"],
      ["discord:C1:706", "7"],
      [`discord:C1:701:edit:${Date.parse(edited)}`, "7"],
      ["discord:C1:707", OWNER],
    ]);
    expect(m.memberCalls).toEqual([]); // a server message needs no membership lookup
  });

  test("with others, a non-owner's DM is delivered only from a member of a server in guilds (screening passed), asked again after 10 minutes", async () => {
    const m = mock();
    let clock = 1_000_000;
    m.notIn.add("G0");
    m.members = { "G2:7": { user: { id: "7" } }, "G1:8": { user: { id: "8" }, pending: true } };
    const dm = (id: string, from: string) => msg(id, { channel_id: `D${from}`, author: { id: from } });
    m.afterReady = [
      ["MESSAGE_CREATE", dm("801", "7")], // G0: bot not there, G1: not a member, G2: member
      ["MESSAGE_CREATE", dm("802", "8")], // pending membership screening in G1
      ["MESSAGE_CREATE", dm("803", "9")], // in none of them
      ["MESSAGE_CREATE", dm("804", "7")], // answered from the cache
      ["MESSAGE_CREATE", dm("805", OWNER)],
    ];
    const root = home();
    const ac = new AbortController();
    const got: InboundMessage[] = [];
    const run = adapter(m, root, { guilds: ["G0", "G1", "G2"], now: () => clock }).receive(ac.signal, async (x) => void got.push(x));
    try {
      await until(() => got.length >= 3);
      expect(got.map((x) => [x.id, x.from])).toEqual([
        ["discord:D7:801", "7"],
        ["discord:D7:804", "7"],
        [`discord:D${OWNER}:805`, OWNER],
      ]);
      expect(m.memberCalls).toEqual(["G0:7", "G1:7", "G2:7", "G0:8", "G1:8", "G2:8", "G0:9", "G1:9", "G2:9"]);

      // 8 passes screening: still no within 10 minutes of the last answer, yes once it is asked again.
      m.members["G1:8"] = { user: { id: "8" } };
      m.emit("MESSAGE_CREATE", dm("806", "8"));
      await until(() => cursorOf(root)?.session?.seq === m.seq); // 806 handled (dropped) before the clock moves
      clock += 10 * 60_000;
      m.emit("MESSAGE_CREATE", dm("807", "8"));
      await until(() => got.length >= 4);
    } finally {
      ac.abort();
      await run;
    }
    expect(got.map((x) => x.id).slice(3)).toEqual(["discord:D8:807"]);
    expect(m.memberCalls.slice(9)).toEqual(["G0:8", "G1:8"]);
  });

  test("with others, catch-up applies guilds through the channel's server (REST messages carry no guild_id)", async () => {
    const m = mock();
    const root = home();
    CursorFile.for<DiscordCursor>(root, "discord").save({ channels: { C2: "1000", C3: "1000" } });
    m.channelInfo = { C2: { id: "C2", type: 0, guild_id: "G1" }, C3: { id: "C3", type: 0, guild_id: "G2" } };
    const mention = (id: string, chat: string, from: string) => msg(id, { channel_id: chat, author: { id: from }, content: "<@BOT> hi", mentions: [{ id: "BOT" }] });
    m.history["C2"] = [mention("1001", "C2", "7")];
    m.history["C3"] = [mention("1001", "C3", "7"), mention("1002", "C3", OWNER)];
    const got = await collect(adapter(m, root, { guilds: ["G1"] }), 2);
    expect(got.map((x) => [x.id, x.from])).toEqual([
      ["discord:C2:1001", "7"],
      ["discord:C3:1002", OWNER],
    ]);
    expect(cursorOf(root)!.channels).toEqual({ C2: "1001", C3: "1002" });
  });

  test("a message in a thread carries the thread as root, rootByOwner only when the owner started it; a channel it cannot look up is shared", async () => {
    const m = mock();
    m.channelInfo = {
      C2: { id: "C2", type: 0, guild_id: "G1" },
      T1: { id: "T1", type: 11, guild_id: "G1", parent_id: "C2", owner_id: OWNER },
      T2: { id: "T2", type: 12, guild_id: "G1", parent_id: "C2", owner_id: "7" },
    };
    m.channelStatus = { T3: 403 };
    const at = (id: string, chat: string, over: Partial<Msg> = {}) => msg(id, { channel_id: chat, guild_id: "G1", content: "<@BOT> hi", mentions: [{ id: "BOT" }], ...over });
    m.afterReady = [
      ["MESSAGE_CREATE", at("901", "T1")],
      ["MESSAGE_CREATE", at("902", "T1")],
      ["MESSAGE_CREATE", at("903", "T2")],
      ["MESSAGE_CREATE", at("904", "C2")],
      ["MESSAGE_CREATE", at("905", "T3")],
      ["MESSAGE_CREATE", msg("906", { channel_id: "D1" })],
      ["MESSAGE_UPDATE", at("903", "T2", { edited_timestamp: "2026-11-07T00:00:05.000Z" })],
    ];
    const got = await collect(adapter(m, home()), 7);
    expect(got.map((x) => [x.id.replace(/:edit:.*/, ":edit"), x.root, x.rootByOwner])).toEqual([
      ["discord:T1:901", "discord:C2:T1", true],
      ["discord:T1:902", "discord:C2:T1", true],
      ["discord:T2:903", "discord:C2:T2", undefined],
      ["discord:C2:904", undefined, undefined],
      ["discord:T3:905", "discord:T3:T3", undefined],
      ["discord:D1:906", undefined, undefined],
      ["discord:T2:903:edit", "discord:C2:T2", undefined],
    ]);
    expect(m.channelCalls.filter((c) => c === "T1")).toEqual(["T1"]); // looked up once
    expect(m.channelCalls).not.toContain("D1");
  });

  test("op 9 (session invalid) re-identifies, waiting at least 5s since the last identify", async () => {
    const m = mock();
    const root = home();
    const sleeps: number[] = [];
    const a = adapter(m, root, { sleeps, now: () => 1_000 });
    const ac = new AbortController();
    const run = a.receive(ac.signal, async () => {});
    await until(() => m.identifies === 1 && m.sockets.size === 1);
    await until(() => cursorOf(root)?.session?.sessionId === "S1"); // READY handled
    m.send({ op: 9, d: false });
    await until(() => m.identifies === 2);
    ac.abort();
    await run;
    expect(m.identifies).toBe(2);
    expect(sleeps.some((ms) => ms >= 1_000 && ms <= 5_000)).toBe(true);
    expect(sleeps).toContain(5_000);
  });

  test("a missed heartbeat ACK reconnects and resumes", async () => {
    const m = mock();
    const root = home();
    m.heartbeatInterval = 30;
    m.ack = false;
    const ac = new AbortController();
    const run = adapter(m, root).receive(ac.signal, async () => {});
    await until(() => m.resumes.length > 0);
    ac.abort();
    await run;
    expect(m.identifies).toBe(1);
    expect(m.resumes[0]!.session_id).toBe("S1");
  });

  test("close 4004 (bad token) and 4014 (disallowed intent) reject receive with what to fix", async () => {
    const m = mock();
    m.identifyClose = 4004;
    await expect(adapter(m, home()).receive(new AbortController().signal, async () => {})).rejects.toThrow(/rejected the bot token.*Reset Token/);
    const m2 = mock();
    m2.identifyClose = 4014;
    await expect(adapter(m2, home()).receive(new AbortController().signal, async () => {})).rejects.toThrow(/MESSAGE CONTENT INTENT.*options\.intents/);
  });

  test("a 401 from /gateway/bot rejects receive; a missing token rejects with where to set it", async () => {
    const m = mock();
    const root = home();
    const a = new DiscordAdapter({ source: "discord", owner: OWNER, options: { apiBase: m.base } }, root, { env: { SEORI_DISCORD_TOKEN: "bad" } });
    await expect(a.receive(new AbortController().signal, async () => {})).rejects.toThrow(/rejected the bot token/);
    const none = new DiscordAdapter({ source: "discord", owner: OWNER }, root, { env: {} });
    await expect(none.receive(new AbortController().signal, async () => {})).rejects.toThrow(/SEORI_DISCORD_TOKEN/);
  });

  test("abort returns promptly", async () => {
    const m = mock();
    const ac = new AbortController();
    const run = adapter(m, home()).receive(ac.signal, async () => {});
    await until(() => m.identifies === 1);
    const t = Date.now();
    ac.abort();
    await run;
    expect(Date.now() - t).toBeLessThan(200);
  });

  test("the identify gap holds across adapter instances, also after a fatal close", async () => {
    const m = mock();
    const root = home();
    m.identifyClose = 4014;
    await expect(adapter(m, root, { now: () => 10_000 }).receive(new AbortController().signal, async () => {})).rejects.toThrow(/MESSAGE CONTENT INTENT/);
    expect(cursorOf(root)!.lastIdentifyAt).toBe(10_000);
    m.identifyClose = undefined;
    const run = async (now: number) => {
      const sleeps: number[] = [];
      const ac = new AbortController();
      const before = m.identifies;
      const r = adapter(m, root, { sleeps, now: () => now }).receive(ac.signal, async () => {});
      await until(() => m.identifies > before);
      ac.abort();
      await r;
      return sleeps;
    };
    expect((await run(12_000))[0]).toBe(3_000); // a new instance 2 s later still waits out the 5 s gap
    const c = cursorOf(root)!;
    expect(c.lastIdentifyAt).toBe(12_000);
    delete c.session; // lost session: the next instance must identify again
    CursorFile.for<DiscordCursor>(root, "discord").save(c);
    expect((await run(1_000))[0]).toBe(5_000); // a clock that went backwards waits the gap, not the skew
    expect(m.identifies).toBe(3);
  });

  test("a socket that never says Hello is replaced after timeoutMs", async () => {
    let conns = 0;
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => void conns++, data: () => {} } });
    try {
      const ac = new AbortController();
      const run = adapter(mock(), home(), { options: { wsUrl: `ws://127.0.0.1:${silent.port}/gw`, timeoutMs: 50 } }).receive(ac.signal, async () => {});
      await until(() => conns >= 2, 2_000);
      ac.abort();
      await run;
      expect(conns).toBeGreaterThanOrEqual(2);
    } finally {
      silent.stop(true);
    }
  });

  /** An adapter whose injected sleep never ends, so only an abort-aware sleep lets receive return. */
  const slowSleeper = (m: MockDiscord, root: string, sleeps: number[], options: Record<string, unknown> = {}) =>
    new DiscordAdapter({ source: "discord", owner: OWNER, options: { apiBase: m.base, timeoutMs: 200, ...options } }, root, {
      env: { SEORI_DISCORD_TOKEN: "T0K" },
      sleep: (ms) => {
        sleeps.push(ms);
        return new Promise<void>(() => {});
      },
    });

  test("abort interrupts the /gateway/bot retry sleep", async () => {
    const m = mock();
    m.gatewayStatus = 503;
    const sleeps: number[] = [];
    const ac = new AbortController();
    const run = slowSleeper(m, home(), sleeps).receive(ac.signal, async () => {});
    await until(() => sleeps.length > 0);
    const t = Date.now();
    ac.abort();
    await run;
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Date.now() - t).toBeLessThan(200);
  });

  test("abort interrupts a catch-up retry sleep", async () => {
    const m = mock();
    m.historyStatus = 503;
    const root = home();
    CursorFile.for<DiscordCursor>(root, "discord").save({ channels: { C1: "1000" } });
    const sleeps: number[] = [];
    const ac = new AbortController();
    const run = slowSleeper(m, root, sleeps, { wsUrl: m.ws }).receive(ac.signal, async () => {});
    await until(() => m.historyCalls.length > 0 && sleeps.length > 0);
    const t = Date.now();
    ac.abort();
    await run;
    expect(m.historyCalls.length).toBeGreaterThan(0);
    expect(Date.now() - t).toBeLessThan(200);
  });

  test("a gateway down for longer than ADAPTER_OUTAGE_MS rejects receive with the last error", async () => {
    const m = mock();
    const ws = m.ws;
    m.server.stop(true); // connections are refused from now on
    let clock = 0;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2_000); // safety net only: without the outage check receive never ends
    const err = await adapter(m, home(), { now: () => (clock += 30_000), options: { wsUrl: ws } })
      .receive(ac.signal, async () => {})
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    clearTimeout(timer);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/no working Discord gateway connection for \d+ s; last error: gateway closed/);
  });
});

describe("DiscordAdapter send and check", () => {
  test("splits at 2000, replies with the first chunk, no pings, no previews, into the thread", async () => {
    const m = mock();
    const text = `${"a".repeat(1500)} ${"b".repeat(1500)}`;
    const r = await adapter(m, home()).send({ chat: "C1", thread: "T9", replyTo: "55:edit:123" }, text);
    expect(r).toEqual({ messageId: "900" });
    expect(m.posts.map((p) => p.channel)).toEqual(["T9", "T9"]);
    expect(m.posts[0]!.body).toEqual({ content: "a".repeat(1500), allowed_mentions: { parse: [] }, flags: 4, message_reference: { message_id: "55", fail_if_not_exists: false } });
    expect(m.posts[1]!.body).toEqual({ content: "b".repeat(1500), allowed_mentions: { parse: [] }, flags: 4 });
  });

  test("a 429 is retried after retry_after", async () => {
    const m = mock();
    const sleeps: number[] = [];
    m.postPlan = ["429", "ok"];
    expect(await adapter(m, home(), { sleeps }).send({ chat: "C1" }, "hi")).toEqual({ messageId: "900" });
    expect(sleeps).toEqual([50]);
    expect(m.posts[0]!.body["message_reference"]).toBeUndefined();
  });

  test("5xx and timeout are SendUncertain; a failed later chunk too; empty text and 4xx are definite", async () => {
    const m = mock();
    const a = adapter(m, home());
    m.postPlan = ["500"];
    await expect(a.send({ chat: "C1" }, "hi")).rejects.toBeInstanceOf(SendUncertain);
    m.postPlan = ["hang"];
    await expect(a.send({ chat: "C1" }, "hi")).rejects.toBeInstanceOf(SendUncertain);
    m.postPlan = ["ok", "400"];
    await expect(a.send({ chat: "C1" }, `${"a".repeat(1500)} ${"b".repeat(1500)}`)).rejects.toBeInstanceOf(SendUncertain);
    m.postPlan = ["400"];
    const definite = await a.send({ chat: "C1" }, "hi").catch((e: unknown) => e);
    expect(definite).toBeInstanceOf(Error);
    expect(definite).not.toBeInstanceOf(SendUncertain);
    const empty = await a.send({ chat: "C1" }, "  ").catch((e: unknown) => e);
    expect(empty).not.toBeInstanceOf(SendUncertain);
    expect(String(empty)).toContain("empty");
  });

  test("a channel id is one URL segment: a slash or dot segment never reaches another endpoint", async () => {
    const m = mock();
    const a = adapter(m, home());
    expect(await a.send({ chat: "../guilds/1" }, "x")).toEqual({ messageId: "900" });
    expect(m.posts.map((p) => p.channel)).toEqual(["..%2Fguilds%2F1"]);
    await expect(a.send({ chat: ".." }, "x")).rejects.toThrow(/is not an id/);
  });

  test("check names the bot; a bad token is a clear error", async () => {
    const m = mock();
    expect(await adapter(m, home()).check()).toBe("@seori (id BOT)");
    await expect(adapter(m, home(), { token: "nope" }).check()).rejects.toThrow(/rejected the bot token/);
  });
});

describe("DiscordAdapter pairing mode", () => {
  test("passes a DM from any non-bot user with its real sender; server channels, bots and edits never pass; no catch-up runs", async () => {
    const m = mock();
    const root = home();
    CursorFile.for<DiscordCursor>(root, "discord").save({ channels: { C7: "1" } });
    m.history["C7"] = [msg("2", { channel_id: "C7", author: { id: "old" } })];
    m.afterReady = [
      ["MESSAGE_CREATE", msg("101", { channel_id: "G1", guild_id: "S1", author: { id: "7" } })],
      ["MESSAGE_CREATE", msg("102", { channel_id: "D1", author: { id: "7", bot: true } })],
      ["MESSAGE_UPDATE", msg("100", { channel_id: "D1", author: { id: "7" }, edited_timestamp: "2026-11-07T00:01:00.000Z" })],
      ["MESSAGE_CREATE", msg("103", { channel_id: "D1", author: { id: "7" }, content: "pair me" })],
    ];
    const a = new DiscordAdapter({ source: "discord", owner: "", options: { apiBase: m.base, wsUrl: m.ws, timeoutMs: 200 } }, root, {
      env: { SEORI_DISCORD_TOKEN: "T0K" },
      sleep: async () => {},
      pairing: true,
    });
    const got = await collect(a, 1);
    expect(got).toEqual([{ id: "discord:D1:103", source: "discord", chat: "D1", from: "7", at: Date.parse("2026-11-07T00:00:00.000Z"), text: "pair me" }]);
    expect(m.historyCalls).toEqual([]);
  });
});
