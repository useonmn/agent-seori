import { ACTION_MAX_RETRY_AFTER_MS, ADAPTER_OUTAGE_MS, type InboundMessage, type MessengerAdapter, type MessengerConfig, type SendTarget, SendUncertain } from "./adapter.ts";
import { attachmentLine, CursorFile, editId, HttpError, httpJson, messageId, replyTarget, secret, splitText } from "./common.ts";

// Discord: inbound over the gateway websocket (DMs to the bot, and server channel messages that mention the bot or reply
// to it), catch-up and sends over REST. The gateway session (id, resume url, last committed sequence) is persisted so a
// restart RESUMEs and Discord replays what was missed instead of the bot burning one of its 1000 daily identifies; a lost
// session falls back to a fresh identify plus a REST catch-up of every tracked channel, from the last committed message id.
// With "others" on, people other than the owner are delivered only from the servers in the config's `guilds`, or in a DM
// when they are a member of one of them: anyone may add a public bot to a server of their own.

const DEFAULT_API = "https://discord.com/api/v10";
/** DIRECT_MESSAGES | GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT. */
const DEFAULT_INTENTS = 4096 | 1 | 512 | 32768;
const MESSAGE_LIMIT = 2000;
/** Flag on a created message: no link previews. */
const SUPPRESS_EMBEDS = 1 << 2;
/** Minimum time between two IDENTIFYs, across adapter instances too (persisted in cursor.json). */
const IDENTIFY_GAP_MS = 5_000;
/** How long a new socket may take to open and send op 10 Hello (unless options.timeoutMs says otherwise). */
const HELLO_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const PAGE = 100;
/** Close code for every close we start: 1000/1001 would end the session and make the next connect identify again. */
const RESUMABLE_CLOSE = 4000;
/** On abort, how long receive() waits for an onMessage in flight to finish so its commit lands. */
const ABORT_GRACE_MS = 1_000;
/** Thread channel types: announcement, public and private thread. */
const THREAD_TYPES: ReadonlySet<unknown> = new Set([10, 11, 12]);
/** How long a server membership answer for a DM sender stands before it is asked again (they may join or leave). */
const MEMBER_RECHECK_MS = 10 * 60_000;

type Session = { sessionId: string; resumeUrl: string; seq: number | null };
/**
 * cursor.json: the gateway session to resume, per channel the last message handled (delivered or dropped), and when
 * this bot last sent IDENTIFY, so a restarted daemon (a new adapter) still keeps IDENTIFY_GAP_MS between identifies.
 */
export type DiscordCursor = { session?: Session; channels: Record<string, string>; lastIdentifyAt?: number };

type Attachment = { filename?: string; content_type?: string; size?: number; url?: string };
type Message = {
  id: string;
  channel_id: string;
  /** Set on gateway messages from a server channel; absent in direct messages and in every REST answer. */
  guild_id?: string;
  type?: number;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  author?: { id?: string; bot?: boolean };
  /** Set when a webhook posted it: the author is then the webhook, not a person. */
  webhook_id?: string;
  mentions?: { id?: string }[];
  /** The message this one replies to (type 19). */
  referenced_message?: { author?: { id?: string } } | null;
  attachments?: Attachment[];
};
type Payload = { op: number; d?: unknown; s?: number | null; t?: string | null };
/**
 * What GET /channels/{id} says about a channel: a direct message, or a server channel with its server and, for a
 * thread, its InboundMessage root (the starter message's id: a thread started from a message has that message's id)
 * and whether the owner started it.
 */
type Place = { dm: boolean; guild?: string; thread?: { root: string; byOwner: boolean } };
/**
 * How one gateway connection ended: `healthy` means it got as far as handling events; `delayMs` overrides the backoff;
 * `error` says why an unhealthy one ended.
 */
type Outcome = { healthy: boolean; delayMs?: number; error?: string };

/** A configuration problem retrying cannot fix; receive() rejects with it. */
class Fatal extends Error {}

/** An id as one URL path segment, so a value with a slash or a dot segment can never reach another endpoint. */
function seg(id: string): string {
  if (/^\.+$/.test(id)) throw new Error(`discord: ${JSON.stringify(id)} is not an id`);
  return encodeURIComponent(id);
}

/** Snowflake order (numeric, as BigInt: ids exceed 2^53). */
function snowflakeCmp(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  }
}

function withGatewayQuery(url: string): string {
  const u = new URL(url);
  u.searchParams.set("v", "10");
  u.searchParams.set("encoding", "json");
  return u.toString();
}

export class DiscordAdapter implements MessengerAdapter {
  readonly source: string;
  private readonly owner: string;
  private readonly others: boolean;
  /** The servers whose members `others` covers (MessengerConfig.guilds). */
  private readonly guilds: ReadonlySet<string>;
  private readonly api: string;
  private readonly wsUrl: string | undefined;
  private readonly intents: number;
  private readonly timeoutMs: number | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cursor: CursorFile<DiscordCursor>;
  private state: DiscordCursor = { channels: {} };
  /** Ids delivered by this process, so a message seen both by catch-up and by the gateway reaches the lead once. */
  private readonly delivered = new Set<string>();
  private identifyUrl: string | undefined;
  /** Catch-up runs after the first READY/RESUMED of a process and after every READY, until one pass completes. */
  private catchupPending = true;
  private readonly pairing: boolean;
  /** The bot's own user id (READY, or /users/@me after a resume): what a mention or a reply must point at. */
  private botId: string | undefined;
  /** Per channel id, what GET /channels/{id} said (a DM seen on the gateway is known without asking). */
  private readonly places = new Map<string, Place>();
  /** Per non-owner DM sender, whether they are a member of an allowlisted server, and when that was asked. */
  private readonly members = new Map<string, { member: boolean; at: number }>();

  constructor(
    config: MessengerConfig,
    private readonly root: string,
    /**
     * `pairing`: owner pairing (src/pair.ts) only, never the daemon. Accepts a new live direct message from any non-bot
     * sender instead of the configured owner (no REST catch-up, no edits), so `seori msg pair` can learn the owner's id.
     * `cursorRoot`: where the cursor lives instead of `root` (pairing points it at a temp dir).
     */
    deps: { env?: Record<string, string | undefined>; sleep?: (ms: number) => Promise<void>; now?: () => number; pairing?: boolean; cursorRoot?: string } = {},
  ) {
    this.source = config.source;
    this.owner = config.owner;
    this.others = config.others === true;
    this.guilds = new Set(config.guilds ?? []);
    const o = config.options ?? {};
    this.api = (typeof o["apiBase"] === "string" ? o["apiBase"] : DEFAULT_API).replace(/\/+$/, "");
    this.wsUrl = typeof o["wsUrl"] === "string" ? o["wsUrl"] : undefined;
    this.intents = typeof o["intents"] === "number" ? o["intents"] : DEFAULT_INTENTS;
    this.timeoutMs = typeof o["timeoutMs"] === "number" ? o["timeoutMs"] : undefined;
    this.env = deps.env ?? process.env;
    this.sleepFn = deps.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = deps.now ?? Date.now;
    this.pairing = deps.pairing === true;
    this.cursor = CursorFile.for<DiscordCursor>(deps.cursorRoot ?? root, config.source);
  }

  private token(): string {
    return secret(this.root, this.source, "token", "SEORI_DISCORD_TOKEN", this.env);
  }

  private headers(token: string): Record<string, string> {
    return { authorization: `Bot ${token}`, "user-agent": "DiscordBot (https://github.com/useonmn/agent-seori, 1)" };
  }

  private tokenRejected(where: string): Fatal {
    return new Fatal(
      `${this.source}: Discord rejected the bot token (${where}). Reset it in the Developer Portal (your app → Bot → Reset Token) and update SEORI_DISCORD_TOKEN or "${this.source}": { "token": ... } in secrets.json`,
    );
  }

  private save(): void {
    this.cursor.save(this.state);
  }

  /** Sleeps `ms` (through the injected sleep) or until `signal` aborts, whichever comes first. */
  private pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ms <= 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done);
    this.sleepFn(ms).then(done, done);
    return promise;
  }

  async receive(signal: AbortSignal, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    const token = this.token();
    const saved = this.cursor.load();
    this.state = {
      ...(saved?.session ? { session: saved.session } : {}),
      channels: { ...(saved?.channels ?? {}) },
      ...(typeof saved?.lastIdentifyAt === "number" ? { lastIdentifyAt: saved.lastIdentifyAt } : {}),
    };
    this.catchupPending = true;
    let failures = 0;
    let delay = 0;
    /** The start of receive or the end of the last healthy connection: how long the gateway has been failing. */
    let lastOk = this.now();
    let lastError = "";
    while (!signal.aborted) {
      await this.pause(delay, signal);
      if (signal.aborted) return;
      let outcome: Outcome;
      try {
        const session = this.state.session;
        let url: string;
        if (session) {
          url = session.resumeUrl;
        } else {
          // Identify is capped at 1000 a day; a crash, restart or invalid-session loop must not burn it. Capped at the
          // gap itself, so a clock that went backwards cannot stall receive.
          const last = this.state.lastIdentifyAt;
          if (last !== undefined) await this.pause(Math.min(IDENTIFY_GAP_MS, last + IDENTIFY_GAP_MS - this.now()), signal);
          if (signal.aborted) return;
          url = await this.gatewayUrl(token, signal);
        }
        outcome = await this.connect(url, token, session, signal, onMessage);
      } catch (e) {
        if (e instanceof Fatal) throw new Error(e.message);
        if (signal.aborted) return;
        outcome = { healthy: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (signal.aborted) return;
      if (outcome.healthy) {
        failures = 0;
        lastOk = this.now();
      } else {
        if (outcome.error) lastError = outcome.error;
        const failingMs = this.now() - lastOk;
        // A blip stays internal; an outage this long rejects so the daemon records it (health) and restarts receive.
        if (failingMs > ADAPTER_OUTAGE_MS) throw new Error(`${this.source}: no working Discord gateway connection for ${Math.round(failingMs / 1000)} s; last error: ${lastError || "unknown"}`);
      }
      delay = outcome.delayMs ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures++);
    }
  }

  private async gatewayUrl(token: string, signal: AbortSignal): Promise<string> {
    if (this.wsUrl) return this.wsUrl;
    if (this.identifyUrl) return this.identifyUrl;
    try {
      const res = await httpJson(`${this.api}/gateway/bot`, { headers: this.headers(token), signal }, { mutating: false, sleep: (ms) => this.pause(ms, signal), timeoutMs: this.timeoutMs });
      const url = (res.body as { url?: unknown } | undefined)?.url;
      if (typeof url !== "string") throw new Error(`${this.source}: GET /gateway/bot returned no url`);
      this.identifyUrl = url;
      return url;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw this.tokenRejected("401 on GET /gateway/bot");
      throw e;
    }
  }

  /** One gateway connection: resolves when it ends and should be replaced, rejects with Fatal on a configuration error. */
  private connect(url: string, token: string, session: Session | undefined, signal: AbortSignal, onMessage: (m: InboundMessage) => Promise<void>): Promise<Outcome> {
    const { promise, resolve, reject } = Promise.withResolvers<Outcome>();
    let ws: WebSocket;
    try {
      ws = new WebSocket(withGatewayQuery(url));
    } catch (e) {
      return Promise.reject(new Fatal(`${this.source}: cannot open the Discord gateway at ${url}: ${(e as Error).message}`));
    }
    // Nothing else bounds the handshake: a socket that never opens or never says Hello is replaced.
    const helloMs = this.timeoutMs ?? HELLO_TIMEOUT_MS;
    let hello: Timer | undefined = setTimeout(() => end({ healthy: false, error: `no gateway Hello within ${helloMs} ms` }), helloMs);
    let closed = false;
    let settled = false;
    let healthy = false;
    let acked = true;
    let lastSeq: number | null = session?.seq ?? null;
    let beat: Timer | undefined;
    /** Events are handled one at a time, in order; the chain is what a reconnect waits for before the next socket. */
    let work: Promise<void> = Promise.resolve();

    const send = (p: Payload) => {
      try {
        ws.send(JSON.stringify(p));
      } catch {
        // the close handler decides what happens next
      }
    };
    const settle = (o: Outcome | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(beat);
      clearTimeout(hello);
      signal.removeEventListener("abort", onAbort);
      if (o instanceof Error) return reject(o);
      // Never let two connections handle events at once: wait for the event in hand to finish (and commit). On abort,
      // wait only briefly, so a hung onMessage cannot hold up shutdown.
      const grace = signal.aborted ? setTimeout(() => resolve(o), ABORT_GRACE_MS) : undefined;
      work.then(() => {
        clearTimeout(grace);
        resolve(o);
      });
    };
    /** Ends this connection from our side; the close code keeps the session resumable. */
    const end = (o: Outcome | Error) => {
      closed = true;
      try {
        ws.close(RESUMABLE_CLOSE);
      } catch {
        // already closing
      }
      settle(o);
    };
    const onAbort = () => end({ healthy });
    signal.addEventListener("abort", onAbort);

    const heartbeat = (interval: number, first: boolean) => {
      beat = setTimeout(
        () => {
          if (closed) return;
          if (!acked) return end({ healthy, delayMs: 0, error: "heartbeat not acknowledged" }); // zombie connection: reconnect and resume
          acked = false;
          send({ op: 1, d: lastSeq });
          heartbeat(interval, false);
        },
        first ? interval * Math.random() : interval,
      );
    };

    const handle = async (p: Payload) => {
      if (closed) return;
      try {
        await this.dispatch(p, onMessage, signal);
      } catch (e) {
        if (e instanceof Fatal) return end(e);
        if (!closed) end({ healthy: false, error: e instanceof Error ? e.message : String(e) }); // onMessage rejected or catch-up failed: resume replays from the committed seq
        return;
      }
      healthy = true;
      if (typeof p.s === "number" && this.state.session) {
        this.state.session.seq = p.s;
        this.save();
      }
    };

    ws.onmessage = (ev) => {
      if (closed) return;
      let p: Payload;
      try {
        p = JSON.parse(String(ev.data)) as Payload;
      } catch {
        return;
      }
      switch (p.op) {
        case 10: {
          clearTimeout(hello);
          hello = undefined;
          const interval = Number((p.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval) || 41_250;
          heartbeat(interval, true);
          if (session) {
            send({ op: 6, d: { token, session_id: session.sessionId, seq: session.seq } });
          } else {
            this.state.lastIdentifyAt = this.now();
            this.save(); // before sending: a fatal close or a crash right after must still hold the next instance back
            send({ op: 2, d: { token, intents: this.intents, properties: { os: process.platform, browser: "seori", device: "seori" } } });
          }
          return;
        }
        case 11:
          acked = true;
          return;
        case 1:
          send({ op: 1, d: lastSeq });
          return;
        case 7:
          return end({ healthy, delayMs: 0, error: "gateway asked to reconnect (op 7)" });
        case 9: {
          if (p.d === true) return end({ healthy, delayMs: 1000, error: "session invalidated (op 9, resumable)" });
          delete this.state.session;
          this.save();
          return end({ healthy, delayMs: 1000 + Math.random() * 4000, error: "session invalidated (op 9)" });
        }
        case 0:
          if (typeof p.s === "number") lastSeq = p.s;
          work = work.then(() => handle(p));
          return;
      }
    };
    ws.onclose = (ev) => {
      closed = true;
      if (settled) return;
      const code = ev.code;
      if (code === 4004) return settle(this.tokenRejected("gateway close 4004"));
      if (code === 4014)
        return settle(
          new Fatal(
            `${this.source}: Discord refused a privileged intent (gateway close 4014). Enable MESSAGE CONTENT INTENT in the Developer Portal (your app → Bot → Privileged Gateway Intents), or set options.intents without 32768 (owner DMs are still readable without it)`,
          ),
        );
      if (code >= 4010 && code <= 4013)
        return settle(new Fatal(`${this.source}: Discord rejected the gateway setup (close ${code}: ${ev.reason || "invalid shard, version or intents"}); check options.intents is a valid intents bitmask`));
      if (code === 4007 || code === 4009) {
        delete this.state.session; // invalid seq / session timed out: only a fresh identify helps
        this.save();
      }
      settle({ healthy, error: `gateway closed (${code}${ev.reason ? `: ${ev.reason}` : ""})` });
    };
    return promise;
  }

  private async dispatch(p: Payload, onMessage: (m: InboundMessage) => Promise<void>, signal: AbortSignal): Promise<void> {
    switch (p.t) {
      case "READY": {
        const d = p.d as { session_id?: string; resume_gateway_url?: string; user?: { id?: unknown } };
        if (typeof d?.user?.id === "string" && d.user.id) this.botId = d.user.id;
        if (typeof d?.session_id === "string" && typeof d.resume_gateway_url === "string") {
          this.state.session = { sessionId: d.session_id, resumeUrl: d.resume_gateway_url, seq: typeof p.s === "number" ? p.s : null };
          this.save();
        }
        this.catchupPending = true; // a fresh session replays nothing: the gap must come from REST
        return this.catchup(onMessage, signal);
      }
      case "RESUMED":
        return this.catchup(onMessage, signal);
      case "MESSAGE_CREATE":
      case "MESSAGE_UPDATE": {
        const m = p.d as Message;
        // A server message on the gateway carries its guild_id (a thread it is in is not said); a DM has none.
        const place: Place = m?.guild_id === undefined ? { dm: true } : { dm: false, guild: m.guild_id };
        if (p.t === "MESSAGE_UPDATE") return this.edited(m, onMessage, place, signal);
        if (place.dm && typeof m?.channel_id === "string") this.places.set(m.channel_id, place);
        return this.created(m, onMessage, place, signal);
      }
    }
  }

  private body(m: Message): string {
    const lines = (m.attachments ?? []).map((a) => {
      const detail = [a.content_type, typeof a.size === "number" ? `${a.size} bytes` : undefined].filter(Boolean).join(", ");
      return attachmentLine(a.filename ?? "file", detail, a.url ?? "");
    });
    const content = m.content ?? "";
    return [content, ...lines].filter((l) => l.length > 0).join("\n");
  }

  private remember(id: string): void {
    this.delivered.add(id);
    if (this.delivered.size > 10_000) this.delivered.delete(this.delivered.values().next().value as string);
  }

  /**
   * Who `m` is from when it may reach the lead, before the DM membership check (`member`): the owner, or with "others"
   * on another person in a DM or in a channel of a server in `guilds`. Never a bot or a webhook.
   */
  private candidate(m: Message, place: Place): string | undefined {
    const id = m.author?.id;
    if (typeof id !== "string" || id === "" || m.author?.bot === true || m.webhook_id !== undefined) return undefined;
    if (id === this.owner) return id;
    return this.others && (place.dm || (place.guild !== undefined && this.guilds.has(place.guild))) ? id : undefined;
  }

  /**
   * Whether `user` is a member of a server in `guilds` (GET /guilds/{id}/members/{user}, no privileged intent needed) who
   * has passed its membership screening. 403 (the bot is not in that server) and 404 (not a member) count as no. An
   * answer is asked again after MEMBER_RECHECK_MS; any other failure throws, so the connection ends and Discord
   * replays the message instead of it being skipped.
   */
  private async member(user: string, signal: AbortSignal): Promise<boolean> {
    const known = this.members.get(user);
    if (known !== undefined && this.now() - known.at < MEMBER_RECHECK_MS) return known.member;
    let member = false;
    for (const guild of this.guilds) {
      try {
        const res = await httpJson(
          `${this.api}/guilds/${seg(guild)}/members/${seg(user)}`,
          { headers: this.headers(this.token()), signal },
          { mutating: false, sleep: (ms) => this.pause(ms, signal), timeoutMs: this.timeoutMs },
        );
        member = (res.body as { pending?: unknown } | undefined)?.pending !== true;
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) throw this.tokenRejected("401 on GET /guilds/{id}/members/{id}");
        if (e instanceof HttpError && (e.status === 403 || e.status === 404)) continue;
        throw e;
      }
      if (member) break;
    }
    this.members.delete(user); // set again below, so the oldest answer is the first one evicted
    this.members.set(user, { member, at: this.now() });
    if (this.members.size > 10_000) this.members.delete(this.members.keys().next().value as string);
    return member;
  }

  /**
   * InboundMessage root of a message in `chat`: a thread's root, with rootByOwner when the owner started the thread.
   * Nothing for a DM or a plain server channel. A channel the bot may not look up counts as a thread of unknown author,
   * so the owner's message there is never the owner's alone.
   */
  private async rootOf(chat: string, place: Place, signal: AbortSignal): Promise<{ root?: string; rootByOwner?: true }> {
    if (place.dm) return {};
    const known = await this.place(chat, signal);
    if (known === undefined) return { root: messageId(this.source, chat, chat) };
    if (known.thread === undefined) return {};
    return { root: known.thread.root, ...(known.thread.byOwner ? { rootByOwner: true as const } : {}) };
  }

  /**
   * Whether `m` is meant for the bot. A DM always is; in a server channel (threads included) only a mention of the bot or
   * a reply to one of its messages: seori answers with a reply, so answering that reply continues the conversation.
   */
  private async addressed(m: Message, dm: boolean, signal: AbortSignal): Promise<boolean> {
    if (dm) return true;
    const bot = await this.bot(signal);
    return m.mentions?.some((u) => u.id === bot) === true || m.referenced_message?.author?.id === bot;
  }

  private async bot(signal: AbortSignal): Promise<string> {
    if (this.botId !== undefined) return this.botId;
    let body: unknown;
    try {
      body = (await httpJson(`${this.api}/users/@me`, { headers: this.headers(this.token()), signal }, { mutating: false, sleep: (ms) => this.pause(ms, signal), timeoutMs: this.timeoutMs })).body;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw this.tokenRejected("401 on GET /users/@me");
      throw e;
    }
    const id = (body as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !id) throw new Error(`${this.source}: GET /users/@me returned no id`);
    return (this.botId = id);
  }

  /**
   * A new message, from the gateway or catch-up (`place`: where it is). A message from an accepted sender that is
   * addressed to the bot is delivered; the channel cursor moves past every message.
   */
  private async created(m: Message, onMessage: (m: InboundMessage) => Promise<void>, place: Place, signal: AbortSignal): Promise<void> {
    if (typeof m?.id !== "string" || typeof m.channel_id !== "string") return;
    const chat = m.channel_id;
    const committed = this.state.channels[chat];
    if (committed !== undefined && snowflakeCmp(m.id, committed) <= 0) return;
    const id = messageId(this.source, chat, m.id);
    if (this.delivered.has(id)) return;
    const from = this.pairing ? (place.dm && typeof m.author?.id === "string" && m.author.id !== "" && m.author.bot !== true ? m.author.id : undefined) : this.candidate(m, place);
    let delivered = false;
    if (from !== undefined && (m.type === undefined || m.type === 0 || m.type === 19)) {
      const text = this.body(m);
      // A non-owner in a DM must also be a member of a server in `guilds`.
      if (text && (await this.addressed(m, place.dm, signal)) && (this.pairing || from === this.owner || !place.dm || (await this.member(from, signal)))) {
        const at = Date.parse(m.timestamp ?? "");
        await onMessage({ id, source: this.source, chat, ...(await this.rootOf(chat, place, signal)), from, at: Number.isFinite(at) ? at : this.now(), text });
        this.remember(id);
        delivered = true;
      }
    }
    // Only channels the owner writes in, or where a message reached the lead, are tracked (and caught up).
    if (delivered || (m.author?.id === this.owner && m.author.bot !== true) || committed !== undefined) {
      this.state.channels[chat] = m.id;
      this.save();
    }
  }

  private async edited(m: Message, onMessage: (m: InboundMessage) => Promise<void>, place: Place, signal: AbortSignal): Promise<void> {
    if (this.pairing || typeof m?.id !== "string" || typeof m.channel_id !== "string" || !m.edited_timestamp) return;
    const from = this.candidate(m, place);
    if (from === undefined) return;
    const editedAt = Date.parse(m.edited_timestamp);
    const stamp = Number.isFinite(editedAt) ? String(editedAt) : m.edited_timestamp;
    const id = editId(this.source, m.channel_id, m.id, stamp);
    if (this.delivered.has(id)) return;
    const text = this.body(m);
    if (!text || !(await this.addressed(m, place.dm, signal)) || (from !== this.owner && place.dm && !(await this.member(from, signal)))) return;
    await onMessage({ id, source: this.source, chat: m.channel_id, ...(await this.rootOf(m.channel_id, place, signal)), from, at: Number.isFinite(editedAt) ? editedAt : this.now(), text: `(edited) ${text}` });
    this.remember(id);
  }

  /**
   * What `chat` is (Place); undefined when the bot may not see it (403: kept, so catch-up resumes once access is back) or
   * it is gone (404: forgotten, like a channel Slack reports gone).
   */
  private async place(chat: string, signal: AbortSignal): Promise<Place | undefined> {
    const known = this.places.get(chat);
    if (known !== undefined) return known;
    let c: { type?: unknown; guild_id?: unknown; parent_id?: unknown; owner_id?: unknown } | undefined;
    try {
      const res = await httpJson(`${this.api}/channels/${seg(chat)}`, { headers: this.headers(this.token()), signal }, { mutating: false, sleep: (ms) => this.pause(ms, signal), timeoutMs: this.timeoutMs });
      c = res.body as typeof c;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw this.tokenRejected("401 on GET /channels/{id}");
      if (e instanceof HttpError && e.status === 404) {
        delete this.state.channels[chat];
        this.save();
        return undefined;
      }
      if (e instanceof HttpError && e.status === 403) return undefined;
      throw e;
    }
    const place: Place =
      c?.type === 1
        ? { dm: true }
        : {
            dm: false,
            ...(typeof c?.guild_id === "string" ? { guild: c.guild_id } : {}),
            ...(THREAD_TYPES.has(c?.type)
              ? { thread: { root: messageId(this.source, typeof c?.parent_id === "string" ? c.parent_id : chat, chat), byOwner: c?.owner_id === this.owner } }
              : {}),
          };
    this.places.set(chat, place);
    return place;
  }

  /** Every tracked channel from its committed message id, oldest first, a page of 100 at a time. */
  private async catchup(onMessage: (m: InboundMessage) => Promise<void>, signal: AbortSignal): Promise<void> {
    if (!this.catchupPending || this.pairing) return;
    const token = this.token();
    for (const chat of Object.keys(this.state.channels)) {
      const place = await this.place(chat, signal);
      if (place === undefined) continue; // channel gone or no access: nothing to catch up
      for (;;) {
        const after = this.state.channels[chat];
        if (after === undefined) break;
        let page: Message[];
        try {
          const res = await httpJson(
            `${this.api}/channels/${seg(chat)}/messages?after=${encodeURIComponent(after)}&limit=${PAGE}`,
            { headers: this.headers(token), signal },
            { mutating: false, sleep: (ms) => this.pause(ms, signal), timeoutMs: this.timeoutMs },
          );
          page = Array.isArray(res.body) ? (res.body as Message[]) : [];
        } catch (e) {
          if (e instanceof HttpError && e.status === 401) throw this.tokenRejected("401 on GET /channels/{id}/messages");
          if (e instanceof HttpError && (e.status === 403 || e.status === 404)) break; // channel gone or no access: nothing to catch up
          throw e;
        }
        page.sort((a, b) => snowflakeCmp(a.id, b.id));
        for (const m of page) await this.created(m, onMessage, place, signal);
        if (page.length < PAGE) break;
        const last = page[page.length - 1]!.id;
        if (snowflakeCmp(this.state.channels[chat] ?? after, last) < 0) this.state.channels[chat] = last;
        if (this.state.channels[chat] === after) break; // no progress: never loop on the same page
      }
    }
    this.catchupPending = false;
  }

  async send(target: SendTarget, text: string): Promise<{ messageId: string }> {
    const chunks = splitText(text, MESSAGE_LIMIT);
    if (chunks.length === 0) throw new Error(`${this.source}: refusing to send an empty message`);
    const token = this.token();
    const channel = target.thread ?? target.chat;
    let first: string | undefined;
    for (const [i, content] of chunks.entries()) {
      const body: Record<string, unknown> = { content, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS };
      if (i === 0 && target.replyTo) body["message_reference"] = { message_id: replyTarget(target.replyTo), fail_if_not_exists: false };
      try {
        const res = await httpJson(`${this.api}/channels/${seg(channel)}/messages`, { method: "POST", headers: this.headers(token), body }, { mutating: true, sleep: this.sleepFn, timeoutMs: this.timeoutMs });
        const id = (res.body as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string") throw new SendUncertain(`${this.source}: Discord accepted the message but returned no id`);
        first ??= id;
      } catch (e) {
        if (first !== undefined) throw new SendUncertain(`${this.source}: part ${i + 1} of ${chunks.length} failed after part 1 went out: ${(e as Error).message}`);
        if (e instanceof HttpError && e.status === 401) throw new Error(this.tokenRejected("401 on send").message);
        throw e;
      }
    }
    return { messageId: first! };
  }

  /** One idempotent REST action; a refusal rejects with Discord's answer. */
  private async act(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = this.token();
    try {
      const res = await httpJson(`${this.api}${path}`, { method, headers: this.headers(token), ...(body !== undefined ? { body } : {}) }, { mutating: false, retries: 2, sleep: this.sleepFn, timeoutMs: this.timeoutMs, maxRetryAfterMs: ACTION_MAX_RETRY_AFTER_MS });
      return res.body;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new Error(this.tokenRejected(`401 on ${method} ${path}`).message);
      if (e instanceof HttpError) throw new Error(`${this.source}: ${method} ${path} failed: ${e.message}`);
      throw e;
    }
  }

  async edit(target: SendTarget, message: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error(`${this.source}: refusing to edit a message to empty text`);
    if (text.length > MESSAGE_LIMIT) throw new Error(`${this.source}: an edited message holds at most ${MESSAGE_LIMIT} characters, got ${text.length}`);
    await this.act("PATCH", `/channels/${seg(target.thread ?? target.chat)}/messages/${seg(message)}`, { content: text, allowed_mentions: { parse: [] } });
  }

  async check(): Promise<string> {
    const token = this.token();
    try {
      const res = await httpJson(`${this.api}/users/@me`, { headers: this.headers(token) }, { mutating: false, sleep: this.sleepFn, timeoutMs: this.timeoutMs });
      const me = res.body as { id?: string; username?: string };
      return `@${me.username ?? "?"} (id ${me.id ?? "?"})`;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new Error(this.tokenRejected("401 on GET /users/@me").message);
      throw e;
    }
  }
}
