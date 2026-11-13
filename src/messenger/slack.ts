import {
  type ActionNotes, ADAPTER_OUTAGE_MS, type InboundMessage, type MessengerAdapter, type MessengerConfig, type SendTarget, SendUncertain,
  type ThreadChange, type ThreadResult, type ThreadStatus, type ThreadTarget,
} from "./adapter.ts";
import { attachmentLine, CursorFile, editId, HttpError, httpJson, messageId, replyTarget, retryAfterMs, secret, splitText } from "./common.ts";

// Slack over Socket Mode: a bot token (xoxb-) for the Web API and an app-level token (xapp-, connections:write) to open
// the socket, so no public URL is needed. Socket Mode keeps no replay cursor, so seori keeps its own: the last committed
// message ts per channel, plus the recently active threads of each channel. Envelopes are acked only after onMessage
// resolved, and after every hello each known channel is caught up from conversations.history and its threads from
// conversations.replies, so messages sent while the socket was down are not lost.

/** Slack's documented text limit is 4000; a margin keeps a split chunk clear of it. */
const TEXT_LIMIT = 3900;
const BACKOFF_CAP_MS = 30_000;
/** A client ping goes out this often; a socket that sent nothing (no frame, no pong) by the next ping is dead. */
const DEFAULT_PING_INTERVAL_MS = 10_000;
/** Slack sends hello right after the socket opens; without one by then the connection is retried. */
const DEFAULT_HELLO_TIMEOUT_MS = 30_000;
/** Threads per channel catch-up reads with conversations.replies (the most recently active), and how long they stay. */
const THREAD_LIMIT = 20;
const THREAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_API = "https://slack.com/api";
const BOT_ENV = "SEORI_SLACK_BOT_TOKEN";
const APP_ENV = "SEORI_SLACK_APP_TOKEN";

/** Errors the owner has to fix in the Slack app settings; retrying cannot help. */
const FATAL_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type", "missing_scope"]);
/** conversations.history/replies errors meaning the channel is gone for the bot: it is forgotten, not retried forever. */
const GONE_ERRORS = new Set(["channel_not_found", "not_in_channel", "is_archived"]);
/** The bot may not read this one channel (e.g. a private channel without groups:history): catch-up skips it, others go on. */
const UNREADABLE_ERRORS = new Set(["missing_scope", "not_allowed_token_type"]);
/** chat.postMessage errors after which "some aspect of the operation" may have succeeded (Slack's docs): uncertain. */
const UNCERTAIN_SEND_ERRORS = new Set(["internal_error", "fatal_error"]);
const MAX_RATELIMIT_RETRIES = 5;
/** Slack threads have no names: a thread's status is one of these reactions on its first message. */
const STATUS_REACTIONS: Readonly<Record<ThreadStatus, string>> = { working: "arrows_counterclockwise", waiting: "double_vertical_bar", done: "white_check_mark" };
/** Agent mode: the working status shown under an owner's DM thread until seori replies (Slack renders "<app> <status>"). */
const DEFAULT_AGENT_STATUS = "is working on it...";
/** Slack drops a status after two minutes without a message, so it is set again this often while the lead works... */
const DEFAULT_STATUS_REFRESH_MS = 60_000;
/** ...but never for longer than this: a turn that never replies must not show "working" forever. */
const DEFAULT_STATUS_LIMIT_MS = 30 * 60_000;

/** `threads[channel][root ts]` = the newest ts seen in that thread. */
type Cursor = { channels: Record<string, string>; threads: Record<string, Record<string, string>> };
type SlackFile = { id?: string; name?: string; title?: string; mimetype?: string; size?: number; permalink?: string; url_private?: string };
type SlackMessage = {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: SlackFile[];
  edited?: { ts?: string };
  message?: SlackMessage;
};
type Frame = { type?: string; reason?: string; envelope_id?: string; payload?: { event?: SlackMessage } };
type ApiBody = Record<string, unknown> & { ok?: boolean; error?: string };
type Mode = "GET" | "POST" | "SEND";

type Receiving = {
  readonly cursor: Cursor;
  readonly file: CursorFile<Cursor>;
  /** `<channel>:<ts>` (or with `:edit:<stamp>`) delivered by this receive(): catch-up skips them. */
  readonly delivered: Set<string>;
  readonly botToken: string;
  readonly botUser: string;
  readonly onMessage: (m: InboundMessage) => Promise<void>;
  readonly signal: AbortSignal;
  /** Agent mode: `<channel>:<thread ts>` of DM threads showing the working status, until when it is kept up. */
  readonly working: Map<string, { channel: string; thread: string; until: number }>;
};

/** Slack answered `{ ok: false, error }`: a definite failure (the request was taken and refused). */
export class SlackApiError extends HttpError {
  constructor(
    readonly method: string,
    readonly error: string,
    status: number,
    body: unknown,
  ) {
    super(`slack ${method} failed: ${error}`, status, body);
  }
}

/** onMessage rejected: receive() rethrows its error so the daemon restarts it, and catch-up redelivers the message. */
class OnMessageFailed extends Error {}

/** Compares two Slack ts strings ("1700000000.000100") by their numeric parts; floats would lose the microseconds. */
export function compareTs(a: string, b: string): number {
  const [as = "0", af = ""] = a.split(".");
  const [bs = "0", bf = ""] = b.split(".");
  const sec = BigInt(as) - BigInt(bs);
  if (sec !== 0n) return sec < 0n ? -1 : 1;
  const frac = BigInt(af.padEnd(6, "0") || "0") - BigInt(bf.padEnd(6, "0") || "0");
  return frac === 0n ? 0 : frac < 0n ? -1 : 1;
}

/** The ts just before `ts`, so `oldest=<it>&inclusive=false` still returns `ts` itself. */
function tsBefore(ts: string): string {
  const [s = "0", f = ""] = ts.split(".");
  const micro = BigInt(f.padEnd(6, "0") || "0");
  if (micro > 0n) return `${s}.${String(micro - 1n).padStart(6, "0")}`;
  return `${BigInt(s) - 1n}.999999`;
}

function tsMs(ts: string): number {
  const [s = "0", f = ""] = ts.split(".");
  return Number(s) * 1000 + Math.floor(Number(f.padEnd(6, "0").slice(0, 6) || "0") / 1000);
}

/** Slack escapes &, < and > in message text; the lead reads the plain characters. */
const unescape = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** Escaped outgoing text cannot form `<!channel>`, `<@U…>` or `<#C…>` control sequences, so a reply never pings anyone. */
const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function bodyText(m: SlackMessage): string {
  const lines = (m.files ?? []).map((f) => {
    const detail = [f.mimetype, typeof f.size === "number" ? `${f.size} bytes` : undefined].filter(Boolean).join(", ");
    return attachmentLine(f.name ?? f.title ?? f.id ?? "file", detail, f.permalink ?? f.url_private ?? f.id ?? "");
  });
  const text = unescape(m.text ?? "").trim();
  return [...(text ? [text] : []), ...lines].join("\n");
}

export class SlackAdapter implements MessengerAdapter {
  readonly source: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pingIntervalMs: number;
  private readonly helloTimeoutMs: number;
  private readonly pairing: boolean;
  private readonly cursorRoot: string;
  /**
   * `options.agent`: the Slack app is an agent app (Agents & AI Apps). Each owner DM then gets seori's reply in its own
   * thread (`thread_ts`, or the message itself for a top-level one, which opens a session thread) and a working status
   * (assistant.threads.setStatus) while the lead handles it; Slack clears it when seori replies in that thread.
   */
  private readonly agent: boolean;
  private readonly agentStatus: string;
  private readonly statusRefreshMs: number;
  private readonly statusLimitMs: number;
  private readonly every: (tick: () => Promise<void>, ms: number) => () => void;

  constructor(
    private readonly config: MessengerConfig,
    private readonly root: string,
    /**
     * `pairing`: owner pairing (src/pair.ts) only, never the daemon. Accepts a new live direct message from any non-bot
     * sender instead of the configured owner (no history catch-up, no edits), so `seori msg pair` can learn the owner's id.
     * `cursorRoot`: where the cursor lives instead of `root` (pairing points it at a temp dir).
     * `every`: runs the working-status refresh every `ms` until the returned stop is called (a setInterval by default).
     */
    deps: { env?: Record<string, string | undefined>; sleep?: (ms: number) => Promise<void>; now?: () => number; every?: (tick: () => Promise<void>, ms: number) => () => void; pairing?: boolean; cursorRoot?: string } = {},
  ) {
    this.source = config.source;
    const base = config.options?.["apiBase"];
    this.apiBase = (typeof base === "string" ? base : DEFAULT_API).replace(/\/+$/, "");
    const timeout = config.options?.["timeoutMs"];
    this.timeoutMs = typeof timeout === "number" ? timeout : undefined;
    const ping = config.options?.["pingIntervalMs"];
    this.pingIntervalMs = typeof ping === "number" ? ping : DEFAULT_PING_INTERVAL_MS;
    const hello = config.options?.["helloTimeoutMs"];
    this.helloTimeoutMs = typeof hello === "number" ? hello : DEFAULT_HELLO_TIMEOUT_MS;
    this.env = deps.env ?? process.env;
    this.sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
    this.now = deps.now ?? Date.now;
    this.every = deps.every ?? ((tick, ms) => {
      const timer = setInterval(() => void tick(), ms);
      return () => clearInterval(timer);
    });
    this.pairing = deps.pairing === true;
    this.cursorRoot = deps.cursorRoot ?? root;
    this.agent = config.options?.["agent"] === true;
    const status = config.options?.["agentStatus"];
    this.agentStatus = typeof status === "string" && status.trim() ? status : DEFAULT_AGENT_STATUS;
    const refresh = config.options?.["statusRefreshMs"];
    this.statusRefreshMs = typeof refresh === "number" ? refresh : DEFAULT_STATUS_REFRESH_MS;
    const limit = config.options?.["statusLimitMs"];
    this.statusLimitMs = typeof limit === "number" ? limit : DEFAULT_STATUS_LIMIT_MS;
  }

  private botToken(): string {
    return secret(this.root, this.source, "botToken", BOT_ENV, this.env);
  }

  private appToken(): string {
    return secret(this.root, this.source, "appToken", APP_ENV, this.env);
  }

  /** One Web API call. `ratelimited` (HTTP 200 or 429) waits and retries: Slack did not take the request. */
  private async api(method: string, token: string, params: Record<string, unknown> | undefined, mode: Mode, signal?: AbortSignal): Promise<ApiBody> {
    const headers = { authorization: `Bearer ${token}` };
    for (let attempt = 0; ; attempt++) {
      const opts = { mutating: mode === "SEND", sleep: this.sleep, ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}) };
      const res =
        mode === "GET"
          ? await httpJson(`${this.apiBase}/${method}${params ? `?${new URLSearchParams(params as Record<string, string>)}` : ""}`, { method: "GET", headers, ...(signal ? { signal } : {}) }, opts)
          : await httpJson(`${this.apiBase}/${method}`, { method: "POST", headers, ...(params ? { body: params } : {}), ...(signal ? { signal } : {}) }, opts);
      const body = (res.body ?? {}) as ApiBody;
      if (body.ok === true) return body;
      const error = typeof body.error === "string" ? body.error : `unexpected answer ${JSON.stringify(res.body)}`;
      if (error === "ratelimited" && attempt < MAX_RATELIMIT_RETRIES) {
        await this.sleep(retryAfterMs(res.headers, body));
        continue;
      }
      throw new SlackApiError(method, error, res.status, body);
    }
  }

  /** A clear configuration error for the owner when `e` is one retrying cannot fix; otherwise undefined. */
  private fatal(e: unknown, appToken: boolean): Error | undefined {
    const which = appToken ? `app token (xapp-, ${APP_ENV} or "${this.source}".appToken)` : `bot token (xoxb-, ${BOT_ENV} or "${this.source}".botToken)`;
    if (e instanceof SlackApiError && FATAL_ERRORS.has(e.error)) {
      if (e.error === "missing_scope") {
        const needed = typeof e.body === "object" && e.body !== null && "needed" in e.body ? e.body.needed : undefined;
        return new Error(`slack ${this.source}: the ${which} lacks scope ${typeof needed === "string" ? needed : "(unknown)"} for ${e.method}; add it in the Slack app settings (OAuth & Permissions) and reinstall the app`);
      }
      if (e.error === "not_allowed_token_type") {
        return new Error(`slack ${this.source}: wrong kind of token for ${e.method}; appToken must be an xapp- app-level token with connections:write, botToken an xoxb- bot token`);
      }
      return new Error(`slack ${this.source}: Slack rejected the ${which} (${e.error}); create a new token in the Slack app settings and update it`);
    }
    if (e instanceof HttpError && !(e instanceof SlackApiError) && (e.status === 401 || e.status === 403)) {
      return new Error(`slack ${this.source}: Slack rejected the ${which} (HTTP ${e.status}); check the token`);
    }
    return undefined;
  }

  async receive(signal: AbortSignal, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    const working: Receiving["working"] = new Map();
    const stopRefresh = this.agent ? this.every(() => this.refreshWorking(working), this.statusRefreshMs) : undefined;
    try {
      await this.receiveLoop(signal, onMessage, working);
    } finally {
      stopRefresh?.();
    }
  }

  private async receiveLoop(signal: AbortSignal, onMessage: (m: InboundMessage) => Promise<void>, working: Receiving["working"]): Promise<void> {
    const botToken = this.botToken();
    const appToken = this.appToken();
    const file = CursorFile.for<Cursor>(this.cursorRoot, this.source);
    const saved = file.load();
    const cursor: Cursor = { channels: { ...(saved?.channels ?? {}) }, threads: { ...(saved?.threads ?? {}) } };
    const delivered = new Set<string>();
    let botUser: string | undefined;
    let failures = 0;
    /** When receive last stopped being healthy (hello seen and catch-up done); undefined while healthy. */
    let failingSince: number | undefined;
    let lastError = "";
    while (!signal.aborted) {
      const started = this.now();
      let healthy = false;
      let usingAppToken = false;
      try {
        if (botUser === undefined) botUser = String((await this.api("auth.test", botToken, undefined, "GET", signal)).user_id ?? "");
        usingAppToken = true;
        const url = (await this.api("apps.connections.open", appToken, undefined, "POST", signal)).url;
        usingAppToken = false;
        if (typeof url !== "string") throw new Error("apps.connections.open returned no url");
        const ctx: Receiving = { cursor, file, delivered, botToken, botUser, onMessage, signal, working };
        const end = await this.session(url, ctx, () => {
          healthy = true;
          failures = 0;
          failingSince = undefined;
        });
        if (end === "aborted") return;
        if (healthy) continue; // Slack asked for a new connection: reconnect at once with a fresh URL
        lastError = "Slack asked to reconnect before the socket was up";
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof OnMessageFailed) throw e.cause;
        const fatal = e instanceof FatalSlack ? e : this.fatal(e, usingAppToken);
        if (fatal) throw fatal;
        // anything else (network, 5xx, a dropped or dead socket, an unexpected answer) is transient
        lastError = e instanceof Error ? e.message : String(e);
      }
      const at = this.now();
      failingSince ??= healthy ? at : started;
      if (at - failingSince > ADAPTER_OUTAGE_MS) {
        // A blip stays internal; an outage this long rejects so the daemon records it and restarts receive.
        throw new Error(`slack ${this.source}: no working connection for ${Math.round((at - failingSince) / 1000)} s; last error: ${lastError}`);
      }
      failures++;
      await this.pause(Math.min(BACKOFF_CAP_MS, 500 * 2 ** (failures - 1)), signal);
    }
  }

  private pause(ms: number, signal: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (signal.aborted) return Promise.resolve();
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void this.sleep(ms).then(done);
    return promise;
  }

  /**
   * One socket, frames handled strictly in order. Resolves "refresh" when Slack asked to reconnect, "aborted" on abort;
   * throws when the socket closes or goes dead. `onHealthy` runs once hello came and catch-up finished. A watchdog
   * pings every pingIntervalMs and ends a socket that answered nothing (no frame, no pong) for a whole interval, or
   * sent no hello within helloTimeoutMs: a half-open TCP flow (sleep, network change) never closes by itself.
   */
  private async session(url: string, ctx: Receiving, onHealthy: () => void): Promise<"refresh" | "aborted"> {
    const ws = new WebSocket(url) as WebSocket & { ping?: () => void };
    const queue: string[] = [];
    let ended: string | undefined;
    let heard = true; // the first tick sends the first ping; only the next one may judge
    let hello = false;
    let wake: (() => void) | undefined;
    const poke = () => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    const end = (why: string) => {
      ended ??= why;
      poke();
    };
    ws.addEventListener("message", (e) => {
      heard = true;
      queue.push(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
      poke();
    });
    ws.addEventListener("pong" as "message", () => {
      heard = true;
    });
    ws.addEventListener("close", (e) => end(`the Socket Mode connection closed (code ${e.code})`));
    ws.addEventListener("error", () => end("the Socket Mode connection failed"));
    ctx.signal.addEventListener("abort", poke);
    const watchdog = setInterval(() => {
      if (!heard) return end(`the Socket Mode connection answered no ping within ${this.pingIntervalMs} ms`);
      heard = false;
      try {
        ws.ping?.();
      } catch {
        // not open yet or already closing: the next tick decides
      }
    }, this.pingIntervalMs);
    const helloTimer = setTimeout(() => {
      if (!hello) end(`Slack sent no hello within ${this.helloTimeoutMs} ms`);
    }, this.helloTimeoutMs);
    const ack = (id: string | undefined) => {
      if (!id) return;
      try {
        ws.send(JSON.stringify({ envelope_id: id }));
      } catch {
        // socket already gone: Slack redelivers the unacked envelope, and catch-up covers the rest
      }
    };
    try {
      for (;;) {
        if (ctx.signal.aborted) return "aborted";
        const raw = queue.shift();
        if (raw === undefined) {
          if (ended !== undefined) throw new Error(ended);
          const { promise, resolve } = Promise.withResolvers<void>();
          wake = resolve;
          await promise;
          continue;
        }
        let frame: Frame;
        try {
          frame = JSON.parse(raw) as Frame;
        } catch {
          continue;
        }
        if (frame.type === "hello") {
          hello = true;
          await this.catchUp(ctx);
          onHealthy();
        } else if (frame.type === "disconnect") {
          if (frame.reason === "link_disabled") {
            throw new FatalSlack(`slack ${this.source}: Socket Mode is turned off for this Slack app (link_disabled); turn it on under Settings > Socket Mode`);
          }
          return "refresh";
        } else if (frame.type === "events_api") {
          const event = frame.payload?.event;
          if (event) await this.handle(event, ctx, false);
          ack(frame.envelope_id);
        } else {
          ack(frame.envelope_id); // slash commands, interactivity: not used by seori
        }
      }
    } finally {
      clearInterval(watchdog);
      clearTimeout(helloTimer);
      ctx.signal.removeEventListener("abort", poke);
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  /** Every page of a conversations.history/replies answer after `oldest` (exclusive). */
  private async pages(method: string, params: Record<string, string>, ctx: Receiving): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let next: string | undefined;
    do {
      const query: Record<string, string> = { ...params, inclusive: "false", limit: "200", ...(next ? { cursor: next } : {}) };
      const body = await this.api(method, ctx.botToken, query, "GET", ctx.signal);
      if (Array.isArray(body.messages)) messages.push(...(body.messages as SlackMessage[]));
      const meta = body.response_metadata;
      const cursor = typeof meta === "object" && meta !== null && "next_cursor" in meta ? meta.next_cursor : undefined;
      next = body.has_more === true && typeof cursor === "string" && cursor ? cursor : undefined;
    } while (next);
    return messages;
  }

  /**
   * Fetches what each known channel got after its committed ts, oldest first, and handles it like a live event: its
   * top-level history, plus the replies of its tracked threads and of new parents with replies after the cursor
   * (conversations.history holds no thread replies). A channel the bot can no longer read is skipped, not fatal.
   */
  private async catchUp(ctx: Receiving): Promise<void> {
    for (const channel of Object.keys(ctx.cursor.channels)) {
      const oldest = ctx.cursor.channels[channel];
      if (!oldest) continue;
      let messages: SlackMessage[];
      try {
        messages = await this.pages("conversations.history", { channel, oldest }, ctx);
      } catch (e) {
        if (!(e instanceof SlackApiError)) throw e;
        if (UNREADABLE_ERRORS.has(e.error)) continue; // kept: once the scope is added, catch-up resumes from the cursor
        if (!GONE_ERRORS.has(e.error)) throw e;
        delete ctx.cursor.channels[channel];
        delete ctx.cursor.threads[channel];
        ctx.file.save(ctx.cursor);
        continue;
      }
      const byTs = new Map<string, SlackMessage>();
      const roots = new Set(Object.keys(ctx.cursor.threads[channel] ?? {}));
      for (const m of messages) {
        if (!m.ts) continue;
        byTs.set(m.ts, m);
        if (m.thread_ts === m.ts && (m.reply_count ?? 0) > 0 && m.latest_reply && compareTs(m.latest_reply, oldest) > 0) roots.add(m.ts);
      }
      for (const root of roots) {
        let replies: SlackMessage[];
        try {
          replies = await this.pages("conversations.replies", { channel, ts: root, oldest }, ctx);
        } catch (e) {
          if (!(e instanceof SlackApiError)) throw e;
          if (e.error === "thread_not_found") {
            delete ctx.cursor.threads[channel]?.[root];
            ctx.file.save(ctx.cursor);
            continue;
          }
          if (UNREADABLE_ERRORS.has(e.error) || GONE_ERRORS.has(e.error)) continue;
          throw e;
        }
        // The parent comes first in every answer; a broadcast reply is in history too.
        for (const r of replies) if (r.ts && r.ts !== root && compareTs(r.ts, oldest) > 0 && !byTs.has(r.ts)) byTs.set(r.ts, r);
      }
      const ordered = [...byTs.values()].sort((a, b) => compareTs(a.ts ?? "0", b.ts ?? "0"));
      for (const m of ordered) await this.handle({ ...m, channel }, ctx, true);
    }
  }

  private advance(channel: string, ts: string, ctx: Receiving): void {
    const current = ctx.cursor.channels[channel];
    if (current === undefined || compareTs(ts, current) <= 0) return;
    ctx.cursor.channels[channel] = ts;
    ctx.file.save(ctx.cursor);
  }

  /**
   * Remembers that thread `root` in a known channel saw `ts`, so catch-up reads its replies. Only the THREAD_LIMIT most
   * recently active threads younger than THREAD_MAX_AGE_MS are kept. A new thread is saved at once (before delivery, so
   * a rejected reply is still caught up); a newer ts in a known thread rides on the next cursor save.
   */
  private track(channel: string, root: string, ts: string, ctx: Receiving): void {
    if (ctx.cursor.channels[channel] === undefined) return;
    const threads = (ctx.cursor.threads[channel] ??= {});
    const seen = threads[root];
    if (seen !== undefined) {
      if (compareTs(ts, seen) > 0) threads[root] = ts;
      return;
    }
    threads[root] = ts;
    const cutoff = tsMs(ts) - THREAD_MAX_AGE_MS;
    const keep = Object.entries(threads)
      .filter(([, last]) => tsMs(last) >= cutoff)
      .sort(([, a], [, b]) => compareTs(b, a))
      .slice(0, THREAD_LIMIT);
    ctx.cursor.threads[channel] = Object.fromEntries(keep);
    ctx.file.save(ctx.cursor);
  }

  private async deliver(m: InboundMessage, key: string, ctx: Receiving): Promise<void> {
    try {
      await ctx.onMessage(m);
    } catch (e) {
      throw new OnMessageFailed("onMessage rejected", { cause: e });
    }
    ctx.delivered.add(key);
  }

  /** One message event (live or from history). Commits its ts once handled; never for an edit (history has no edits). */
  private async handle(ev: SlackMessage, ctx: Receiving, fromHistory: boolean): Promise<void> {
    const channel = ev.channel;
    if (!channel || (ev.type !== "message" && ev.type !== "app_mention")) return;
    const dm = ev.channel_type === "im" || (ev.channel_type === undefined && channel.startsWith("D"));
    if (ev.subtype === "message_changed") return this.handleEdit(ev, channel, dm, ctx);
    const ts = ev.ts;
    if (!ts) return;
    // A thread_broadcast is a thread reply also sent to the channel: the owner's words like any other message.
    if (ev.subtype !== undefined && ev.subtype !== "file_share" && ev.subtype !== "thread_broadcast") {
      if (ev.subtype === "bot_message") this.advance(channel, ts, ctx);
      return;
    }
    const key = `${channel}:${ts}`;
    if (ctx.delivered.has(key)) return;
    const owner = this.pairing
      ? dm && !fromHistory && typeof ev.user === "string" && ev.user !== "" && !ev.bot_id && ev.user !== ctx.botUser
      : ev.user === this.config.owner && !ev.bot_id;
    // Catch-up reads every message of a channel; outside DMs only those addressed to the bot are commands.
    const addressed = dm || !fromHistory || (ctx.botUser !== "" && (ev.text ?? "").includes(`<@${ctx.botUser}>`));
    const text = owner && addressed ? bodyText(ev) : "";
    if (!text) {
      if (ctx.botUser !== "" && ev.user === ctx.botUser) {
        this.track(channel, ev.thread_ts ?? ts, ts, ctx); // the owner may answer in seori's thread
        if (dm) this.stopWorking(channel, ev.thread_ts, ctx);
      }
      return this.advance(channel, ts, ctx);
    }
    if (ctx.cursor.channels[channel] === undefined) {
      // First message from this channel: it becomes known, its cursor just before this message, so a crash replays it.
      ctx.cursor.channels[channel] = tsBefore(ts);
      ctx.file.save(ctx.cursor);
    }
    this.track(channel, ev.thread_ts ?? ts, ts, ctx); // seori replies under this message: catch-up reads that thread
    const agentThread = dm && this.agent && !this.pairing;
    const thread = dm && !agentThread ? ev.thread_ts : (ev.thread_ts ?? ts);
    const from = this.pairing ? (ev.user as string) : this.config.owner;
    await this.deliver({ id: messageId(this.source, channel, ts), source: this.source, chat: channel, ...(thread ? { thread } : {}), from, at: tsMs(ts), text }, key, ctx);
    if (agentThread && thread) this.showWorking(channel, thread, ctx.working);
    this.advance(channel, ts, ctx);
  }

  /** Agent mode: the lead has the owner's message, so the thread shows the working status until seori replies there. */
  private showWorking(channel: string, thread: string, working: Receiving["working"]): void {
    working.set(`${channel}:${thread}`, { channel, thread, until: this.now() + this.statusLimitMs });
    void this.setStatus(channel, thread, this.agentStatus, working);
  }

  /**
   * seori posted in a DM: a reply in a working thread ends it (Slack clears the status by itself); a top-level message
   * answers every working thread of that DM, whose status is cleared explicitly. The entries go first, so no refresh
   * puts a status back.
   */
  private stopWorking(channel: string, thread: string | undefined, ctx: Receiving): void {
    for (const [key, w] of ctx.working) {
      if (w.channel !== channel || (thread !== undefined && thread !== w.thread)) continue;
      ctx.working.delete(key);
      if (thread === undefined) void this.setStatus(channel, w.thread, "", ctx.working);
    }
  }

  /**
   * Sets every working status again (Slack drops one after two minutes) and clears those past the limit; settles once
   * every call it made did.
   */
  private async refreshWorking(working: Receiving["working"]): Promise<void> {
    const now = this.now();
    const calls: Promise<void>[] = [];
    for (const [key, w] of working) {
      if (now < w.until) {
        calls.push(this.setStatus(w.channel, w.thread, this.agentStatus, working));
        continue;
      }
      working.delete(key);
      calls.push(this.setStatus(w.channel, w.thread, "", working));
    }
    await Promise.all(calls);
  }

  /**
   * The status is a courtesy: a failure never stops receiving or a reply. It is reported on stderr (the daemon pane), and
   * a definite refusal (not an agent app, a missing scope) ends the refresh of that thread so it is not repeated forever.
   */
  private async setStatus(channel: string, thread: string, status: string, working: Receiving["working"]): Promise<void> {
    try {
      await this.api("assistant.threads.setStatus", this.botToken(), { channel_id: channel, thread_ts: thread, status }, "POST");
    } catch (e) {
      if (e instanceof SlackApiError) working.delete(`${channel}:${thread}`);
      console.error(`slack ${this.source}: working status for ${channel}:${thread} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleEdit(ev: SlackMessage, channel: string, dm: boolean, ctx: Receiving): Promise<void> {
    const m = ev.message;
    const stamp = m?.edited?.ts;
    if (this.pairing || !m?.ts || !stamp || m.bot_id || m.user !== this.config.owner) return; // unfurls also arrive as message_changed, without `edited`
    const key = `${channel}:${m.ts}:edit:${stamp}`;
    if (ctx.delivered.has(key)) return;
    const text = bodyText(m);
    if (!text) return;
    const thread = dm && !this.agent ? m.thread_ts : (m.thread_ts ?? m.ts);
    await this.deliver(
      { id: editId(this.source, channel, m.ts, stamp), source: this.source, chat: channel, ...(thread ? { thread } : {}), from: this.config.owner, at: tsMs(stamp), text: `(edited) ${text}` },
      key,
      ctx,
    );
  }

  async send(target: SendTarget, text: string): Promise<{ messageId: string }> {
    const chunks = splitText(escape(text), TEXT_LIMIT);
    if (!chunks.length) throw new Error("slack: refusing to send an empty message");
    const token = this.botToken();
    const thread = target.thread ?? (target.replyTo ? replyTarget(target.replyTo) : undefined);
    const post = async (chunk: string): Promise<string> => {
      const body = await this.api(
        "chat.postMessage",
        token,
        { channel: target.chat, text: chunk, ...(thread ? { thread_ts: thread } : {}), unfurl_links: false, unfurl_media: false, link_names: false },
        "SEND",
      );
      if (typeof body.ts !== "string") throw new SendUncertain(`slack chat.postMessage answered without a ts: ${JSON.stringify(body)}`);
      return body.ts;
    };
    let first: string;
    try {
      first = await post(chunks[0]!);
    } catch (e) {
      if (e instanceof SlackApiError && UNCERTAIN_SEND_ERRORS.has(e.error)) throw new SendUncertain(`slack chat.postMessage: ${e.error}; the message may have been posted`);
      throw this.fatal(e, false) ?? e;
    }
    for (let i = 1; i < chunks.length; i++) {
      try {
        await post(chunks[i]!);
      } catch (e) {
        throw new SendUncertain(`slack: chunk ${i + 1} of ${chunks.length} failed after earlier chunks were posted: ${(e as Error).message ?? e}`);
      }
    }
    return { messageId: first };
  }

  /** Adds or removes one reaction; already there (or already gone) counts as done. */
  private async reaction(channel: string, ts: string, name: string, on: boolean): Promise<void> {
    try {
      await this.api(on ? "reactions.add" : "reactions.remove", this.botToken(), { channel, timestamp: ts, name }, "POST");
    } catch (e) {
      if (e instanceof SlackApiError && e.error === (on ? "already_reacted" : "no_reaction")) return;
      throw this.fatal(e, false) ?? e;
    }
  }

  async react(chat: string, message: string, on: boolean): Promise<void> {
    await this.reaction(chat, message, "eyes", on);
  }

  async edit(target: SendTarget, message: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("slack: refusing to edit a message to empty text");
    const escaped = escape(text);
    if (escaped.length > TEXT_LIMIT) throw new Error(`slack: an edited message holds at most ${TEXT_LIMIT} characters, got ${escaped.length}`);
    try {
      await this.api("chat.update", this.botToken(), { channel: target.chat, ts: message, text: escaped }, "POST");
    } catch (e) {
      throw this.fatal(e, false) ?? e;
    }
  }

  async typing(_target: ThreadTarget): Promise<ActionNotes> {
    return ["slack: bots have no typing indicator (in agent mode seori shows its own working status)"];
  }

  /** The status is one reaction on the thread's first message (the root ts, else the message asked from). */
  async thread(target: ThreadTarget, change: ThreadChange): Promise<ThreadResult> {
    const root = target.thread ?? target.message;
    if (root === undefined) return { notes: ["slack: no thread or message given, so there is no thread to mark; the status message carries the status"] };
    if (change.status !== undefined) {
      for (const [status, name] of Object.entries(STATUS_REACTIONS)) {
        if (status !== change.status) await this.reaction(target.chat, root, name, false);
      }
      await this.reaction(target.chat, root, STATUS_REACTIONS[change.status], true);
    }
    const notes: string[] = [];
    if (change.name !== undefined) notes.push("slack: threads have no names; the status is shown as a reaction on the thread's first message");
    if (change.state !== undefined) notes.push("slack: threads cannot be closed or reopened; the ✅ reaction marks it done");
    return { ...(change.status !== undefined ? { status: change.status } : {}), notes };
  }

  async check(): Promise<string> {
    const botToken = this.botToken();
    const appToken = this.appToken();
    let me: ApiBody;
    try {
      me = await this.api("auth.test", botToken, undefined, "GET");
    } catch (e) {
      throw this.fatal(e, false) ?? e;
    }
    try {
      await this.api("apps.connections.open", appToken, undefined, "POST");
    } catch (e) {
      throw this.fatal(e, true) ?? e;
    }
    return `bot @${String(me.user)} in team ${String(me.team)}`;
  }
}

/** A configuration problem found on the socket (link_disabled): receive() rejects with it. */
class FatalSlack extends Error {}
