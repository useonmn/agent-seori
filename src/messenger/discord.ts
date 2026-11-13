import {
  ACTION_MAX_RETRY_AFTER_MS, type ActionNotes, ADAPTER_OUTAGE_MS, EYES, type FetchedMessage, type InboundMessage, type MessengerAdapter, type MessengerConfig, type SendTarget, SendUncertain,
  type ThreadChange, threadName, type ThreadResult, type ThreadTarget,
} from "./adapter.ts";
import { attachmentLine, CursorFile, editId, HttpError, httpJson, messageId, replyTarget, secret, splitText } from "./common.ts";

// Discord: inbound over the gateway websocket (owner DMs and guild channels the owner writes in), catch-up and sends over
// REST. The gateway session (id, resume url, last committed sequence) is persisted so a restart RESUMEs and Discord
// replays what was missed instead of the bot burning one of its 1000 daily identifies; a lost session falls back to a
// fresh identify plus a REST catch-up of every channel the owner has written in, from the last committed message id.

const DEFAULT_API = "https://discord.com/api/v10";
/** DIRECT_MESSAGES | GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT. */
const DEFAULT_INTENTS = 4096 | 1 | 512 | 32768;
const MESSAGE_LIMIT = 2000;
const THREAD_NAME_LIMIT = 100;
/** Channel types of an announcement, public and private thread. */
const THREAD_TYPES = new Set([10, 11, 12]);
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
  /** Set on gateway messages from a server channel; absent in direct messages. */
  guild_id?: string;
  type?: number;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  author?: { id?: string; bot?: boolean };
  attachments?: Attachment[];
  /** On a reply (type 19): the message it answers, and that message itself when Discord sent it along. */
  message_reference?: { message_id?: string; channel_id?: string };
  referenced_message?: { content?: string } | null;
};
type Payload = { op: number; d?: unknown; s?: number | null; t?: string | null };
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
        const d = p.d as { session_id?: string; resume_gateway_url?: string };
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
        return this.created(p.d as Message, onMessage);
      case "MESSAGE_UPDATE":
        return this.edited(p.d as Message, onMessage);
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

  /** A new message, from the gateway or catch-up. Owner messages are delivered; the channel cursor moves past every message. */
  private async created(m: Message, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    if (typeof m?.id !== "string" || typeof m.channel_id !== "string") return;
    const chat = m.channel_id;
    const committed = this.state.channels[chat];
    if (committed !== undefined && snowflakeCmp(m.id, committed) <= 0) return;
    const id = messageId(this.source, chat, m.id);
    if (this.delivered.has(id)) return;
    const owner = this.pairing
      ? m.guild_id === undefined && typeof m.author?.id === "string" && m.author.id !== "" && m.author.bot !== true
      : m.author?.id === this.owner && m.author.bot !== true;
    if (owner && (m.type === undefined || m.type === 0 || m.type === 19)) {
      const text = this.body(m);
      if (text) {
        const at = Date.parse(m.timestamp ?? "");
        const from = this.pairing ? (m.author?.id as string) : this.owner;
        const ref = m.message_reference;
        const replyTo = m.type === 19 && typeof ref?.message_id === "string"
          ? { id: messageId(this.source, ref.channel_id ?? chat, ref.message_id), ...(m.referenced_message?.content ? { text: m.referenced_message.content } : {}) }
          : undefined;
        await onMessage({ id, source: this.source, chat, from, sender: { kind: "owner", id: from }, at: Number.isFinite(at) ? at : this.now(), text, ...(replyTo ? { replyTo } : {}) });
        this.remember(id);
      }
    }
    // Only channels the owner writes in are tracked (and caught up); others' chatter in unrelated channels is not.
    if (owner || committed !== undefined) {
      this.state.channels[chat] = m.id;
      this.save();
    }
  }

  private async edited(m: Message, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    if (this.pairing || typeof m?.id !== "string" || typeof m.channel_id !== "string" || !m.edited_timestamp || m.author?.id !== this.owner || m.author.bot === true) return;
    const editedAt = Date.parse(m.edited_timestamp);
    const stamp = Number.isFinite(editedAt) ? String(editedAt) : m.edited_timestamp;
    const id = editId(this.source, m.channel_id, m.id, stamp);
    if (this.delivered.has(id)) return;
    const text = this.body(m);
    if (!text) return;
    await onMessage({ id, source: this.source, chat: m.channel_id, from: this.owner, sender: { kind: "owner", id: this.owner }, at: Number.isFinite(editedAt) ? editedAt : this.now(), text: `(edited) ${text}` });
    this.remember(id);
  }

  /** Every tracked channel from its committed message id, oldest first, a page of 100 at a time. */
  private async catchup(onMessage: (m: InboundMessage) => Promise<void>, signal: AbortSignal): Promise<void> {
    if (!this.catchupPending || this.pairing) return;
    const token = this.token();
    for (const chat of Object.keys(this.state.channels)) {
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
        for (const m of page) await this.created(m, onMessage);
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

  async react(chat: string, message: string, on: boolean): Promise<void> {
    await this.act(on ? "PUT" : "DELETE", `/channels/${seg(chat)}/messages/${seg(message)}/reactions/${seg(EYES)}/@me`);
  }

  async edit(target: SendTarget, message: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error(`${this.source}: refusing to edit a message to empty text`);
    if (text.length > MESSAGE_LIMIT) throw new Error(`${this.source}: an edited message holds at most ${MESSAGE_LIMIT} characters, got ${text.length}`);
    await this.act("PATCH", `/channels/${seg(target.thread ?? target.chat)}/messages/${seg(message)}`, { content: text, allowed_mentions: { parse: [] } });
  }

  async typing(target: ThreadTarget): Promise<ActionNotes> {
    await this.act("POST", `/channels/${seg(target.thread ?? target.chat)}/typing`);
    return [];
  }

  /**
   * A thread is a channel: renamed and archived with one PATCH. The channel type is read first, so a message that came
   * in outside a thread (a DM, a server channel) can never rename the channel it was posted in.
   */
  async thread(target: ThreadTarget, change: ThreadChange): Promise<ThreadResult> {
    const id = target.thread ?? target.chat;
    const channel = (await this.act("GET", `/channels/${seg(id)}`)) as { type?: unknown; thread_metadata?: { archived?: unknown } } | undefined;
    if (!THREAD_TYPES.has(Number(channel?.type))) return { notes: [`${this.source}: channel ${id} is not a thread, so there is no thread to rename or close; the status message carries the status`] };
    // Discord refuses any change to an archived thread but unarchiving it: a rename with --close unarchives in the same
    // PATCH and archives again after; without --close or --reopen a closed thread is left as it is.
    const archived = channel?.thread_metadata?.archived === true;
    if (archived && change.state === undefined) {
      return { notes: change.name !== undefined || change.status !== undefined ? [`${this.source}: thread ${id} is closed; pass --reopen to rename it`] : [] };
    }
    if (archived && change.state === "close") {
      if (change.name === undefined) return { state: "close", notes: [] };
      const name = threadName(change.name, change.status);
      if (name.length > THREAD_NAME_LIMIT) throw new Error(`${this.source}: a thread name holds at most ${THREAD_NAME_LIMIT} characters, got ${name.length}`);
      await this.act("PATCH", `/channels/${seg(id)}`, { name, archived: false });
      await this.act("PATCH", `/channels/${seg(id)}`, { archived: true });
      return { name, state: "close", notes: [] };
    }
    const notes: string[] = [];
    const patch: Record<string, unknown> = {};
    if (change.name !== undefined) {
      const name = threadName(change.name, change.status);
      if (name.length > THREAD_NAME_LIMIT) throw new Error(`${this.source}: a thread name holds at most ${THREAD_NAME_LIMIT} characters, got ${name.length}`);
      patch["name"] = name;
    } else if (change.status !== undefined) {
      notes.push(`${this.source}: pass --name with --status; the status is part of the thread's name`);
    }
    if (change.state !== undefined) patch["archived"] = change.state === "close";
    if (Object.keys(patch).length) await this.act("PATCH", `/channels/${seg(id)}`, patch);
    return {
      ...(typeof patch["name"] === "string" ? { name: patch["name"] } : {}),
      ...(change.state !== undefined ? { state: change.state } : {}),
      notes,
    };
  }

  async fetchMessage(chat: string, message: string): Promise<FetchedMessage> {
    const token = this.token();
    try {
      const res = await httpJson(`${this.api}/channels/${seg(chat)}/messages/${seg(message)}`, { headers: this.headers(token) }, { mutating: false, retries: 2, sleep: this.sleepFn, timeoutMs: this.timeoutMs, maxRetryAfterMs: ACTION_MAX_RETRY_AFTER_MS });
      const m = res.body as Message;
      const at = Date.parse(m.timestamp ?? "");
      return { from: m.author?.id ?? "?", at: Number.isFinite(at) ? at : 0, text: this.body(m) };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return { unavailable: "not found" };
      if (e instanceof HttpError && e.status === 403) return { unavailable: "the bot may not read that channel" };
      if (e instanceof HttpError && e.status === 401) throw new Error(this.tokenRejected("401 on GET message").message);
      throw e;
    }
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
