// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { loadMessengers } from "./adapter.ts";
import { HttpError, httpJson, secret } from "./common.ts";

// `seori presence slack|discord`: keeps the configured account shown online until stopped. Each platform session runs
// until its socket closes; then a fresh session is opened after a backoff that starts at 5 s, doubles per fast failure
// up to 300 s, and resets once a session held for 60 s. A configuration error (a rejected token, a refused intent)
// stops the command with a clear message instead of looping.
//
// Discord: a gateway session that identifies with presence status "online" shows the bot online while it is open.
// Slack bot (default): Slack shows an Events API / Socket Mode bot active only through the app's "Always Show My Bot
// as Online" setting; no API call makes it active (users.setPresence takes only auto or away) and a Socket Mode
// connection does not count. So this mode calls users.setPresence auto with the bot token, which lifts a manual away,
// re-asserts it every 10 minutes, and sets away on release. It deliberately opens no Socket Mode connection: Slack
// spreads events across every open connection of the app, so a second one would take events from the daemon.
// Slack user (--user): a user account is active while a web-client-type socket is open (rtm sockets do not count), and
// an idle one is auto-awayed, so a tickle frame goes out every minute. Never answer a manual_presence_change event
// with setPresence: two writers echo each other into a flip-flop loop.

export const BACKOFF_START_MS = 5_000;
export const BACKOFF_CAP_MS = 300_000;
/** A session that held at least this long resets the backoff. */
export const STABLE_MS = 60_000;
/** Slack bot mode: how often users.setPresence auto is re-asserted. */
export const SLACK_REASSERT_MS = 10 * 60_000;
/** Slack user mode: how often a tickle frame keeps the client socket from going idle. */
export const SLACK_TICKLE_MS = 60_000;
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const SLACK_API = "https://slack.com/api";
/** Presence needs no events, so the session asks for none (and no privileged intent). */
const DISCORD_INTENTS = 0;

export type Platform = "slack" | "discord";
export type Line = { send(frame: string): void; close(code?: number): void };
export type LineEvents = { onMessage(data: string): void; onClose(code: number): void };
export type OpenLine = (url: string, headers: Readonly<Record<string, string>>, on: LineEvents) => Line;
export type Timers = { setInterval(cb: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
/** One Slack Web API call; resolves the `ok: true` body, throws SlackCallError on `ok: false`. */
export type SlackCall = (method: string, token: string, params: Record<string, string>, cookie?: string) => Promise<Record<string, unknown>>;

export type PresenceDeps = {
  readonly open: OpenLine;
  readonly timers: Timers;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  readonly slackCall: SlackCall;
  readonly env?: Record<string, string | undefined>;
};

/** How a session ended: `code` says why and a new session follows; `fatal` stops the command. */
type End = { readonly code: string } | { readonly fatal: string };
type Session = (signal: AbortSignal, ready: () => void) => Promise<End>;

/** A missing or unreadable token: the command refuses (exit 2) instead of starting. */
export class PresenceConfigError extends Error {}

export class SlackCallError extends Error {
  constructor(readonly method: string, readonly error: string) {
    super(`slack ${method} failed: ${error}`);
  }
}

const SLACK_FATAL = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type", "missing_scope", "invalid_cookie"]);

function pause(ms: number, signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    signal.removeEventListener("abort", done);
    resolve();
  };
  signal.addEventListener("abort", done);
  sleep(ms).then(done, done);
  return promise;
}

/** Runs sessions until `signal` aborts (exit 0) or one ends fatally (exit 1). */
export async function holdPresence(platform: Platform, session: Session, deps: PresenceDeps, signal: AbortSignal): Promise<number> {
  let delay = BACKOFF_START_MS;
  let announced = false;
  const ready = () => {
    if (announced) return;
    announced = true;
    deps.log(`PRESENCE_READY ${platform}`);
  };
  while (!signal.aborted) {
    const started = deps.now();
    const end = await session(signal, ready);
    if (signal.aborted) return 0;
    if ("fatal" in end) {
      deps.error(`PRESENCE_FAILED ${platform}: ${end.fatal}`);
      return 1;
    }
    if (deps.now() - started >= STABLE_MS) delay = BACKOFF_START_MS;
    deps.log(`PRESENCE_RECONNECT ${platform} code=${end.code} retry_in=${delay / 1000}s`);
    await pause(delay, signal, deps.sleep);
    delay = Math.min(delay * 2, BACKOFF_CAP_MS);
  }
  return 0;
}

/** One gateway connection that identifies as online; ends on close, op 7, op 9 or a missed heartbeat ack. */
export function discordSession(token: string, url: string, deps: PresenceDeps): Session {
  return (signal, ready) => {
    const { promise, resolve } = Promise.withResolvers<End>();
    let seq: number | null = null;
    let beat: unknown;
    let acked = true;
    let done = false;
    let line: Line | undefined;
    const send = (p: unknown) => {
      try {
        line?.send(JSON.stringify(p));
      } catch {
        // closing: the close event ends the session
      }
    };
    const finish = (end: End, close: boolean) => {
      if (done) return;
      done = true;
      if (beat !== undefined) deps.timers.clearInterval(beat);
      signal.removeEventListener("abort", onAbort);
      if (close) {
        try {
          line?.close(1000);
        } catch {
          // already closed
        }
      }
      resolve(end);
    };
    const onAbort = () => finish({ code: "stopped" }, true);
    signal.addEventListener("abort", onAbort);
    try {
      line = deps.open(url, {}, {
        onMessage(raw) {
          if (done) return;
          let m: { op?: number; s?: number | null; t?: string | null; d?: { heartbeat_interval?: number } };
          try {
            m = JSON.parse(raw);
          } catch {
            return;
          }
          if (typeof m.s === "number") seq = m.s;
          switch (m.op) {
            case 10: {
              const interval = Number(m.d?.heartbeat_interval) || 41_250;
              beat = deps.timers.setInterval(() => {
                if (!acked) return finish({ code: "heartbeat-not-acked" }, true); // zombie connection
                acked = false;
                send({ op: 1, d: seq });
              }, interval);
              send({
                op: 2,
                d: {
                  token,
                  intents: DISCORD_INTENTS,
                  properties: { os: process.platform, browser: "seori", device: "seori" },
                  presence: { status: "online", since: null, activities: [], afk: false },
                },
              });
              return;
            }
            case 11:
              acked = true;
              return;
            case 1:
              send({ op: 1, d: seq });
              return;
            case 7:
              return finish({ code: "op7" }, true);
            case 9:
              return finish({ code: "op9" }, true);
            case 0:
              if (m.t === "READY") ready();
              return;
          }
        },
        onClose(code) {
          if (code === 4004) return finish({ fatal: `Discord rejected the bot token (gateway close 4004); reset it in the Developer Portal and update "discord": { "token": ... } in secrets.json or SEORI_DISCORD_TOKEN` }, false);
          if (code === 4014) return finish({ fatal: "Discord refused a disallowed intent (gateway close 4014)" }, false);
          if (code >= 4010 && code <= 4013) return finish({ fatal: `Discord rejected the gateway setup (close ${code}); check options.wsUrl` }, false);
          finish({ code: String(code) }, false);
        },
      });
    } catch (e) {
      finish({ fatal: `cannot open the Discord gateway at ${url}: ${(e as Error).message}` }, false);
    }
    return promise;
  };
}

function slackEnd(e: unknown, which: string): End {
  if (e instanceof SlackCallError && SLACK_FATAL.has(e.error)) return { fatal: `Slack rejected the ${which} (${e.error} on ${e.method})` };
  if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return { fatal: `Slack rejected the ${which} (HTTP ${e.status})` };
  return { code: e instanceof SlackCallError ? e.error : "network" };
}

/** Bot mode: users.setPresence auto now and every SLACK_REASSERT_MS; ends when a call fails. */
export function slackBotSession(botToken: string, deps: PresenceDeps): Session {
  const which = `bot token ("slack".botToken in secrets.json or SEORI_SLACK_BOT_TOKEN; needs users:write)`;
  return async (signal, ready) => {
    while (!signal.aborted) {
      try {
        await deps.slackCall("users.setPresence", botToken, { presence: "auto" });
      } catch (e) {
        if (signal.aborted) break;
        return slackEnd(e, which);
      }
      ready();
      deps.log("PRESENCE slack auto");
      await pause(SLACK_REASSERT_MS, signal, deps.sleep);
    }
    return { code: "stopped" };
  };
}

/** The client-type socket URL for a user token (ported from upstream). */
export async function clientSocketUrl(call: SlackCall, token: string, cookie: string): Promise<string> {
  const res = await call("client.getWebSocketURL", token, {}, cookie);
  if (typeof res["primary_websocket_url"] !== "string" || typeof res["routing_context"] !== "string") throw new SlackCallError("client.getWebSocketURL", "unexpected_shape");
  const url = new URL(res["primary_websocket_url"]);
  const params: Record<string, string> = {
    token,
    sync_desync: "1",
    slack_client: "desktop",
    start_args: "?agent=client&org_wide_aware=true&connect_only=true&ms_latest=true",
    no_query_on_subscribe: "1",
    flannel: "3",
    lazy_channels: "1",
    gateway_server: res["routing_context"],
    batch_presence_aware: "1",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** User mode: one client-type socket, tickled every minute; ends when it closes. setPresence auto only on the first. */
export function slackUserSession(token: string, cookie: string, deps: PresenceDeps): Session {
  const which = `user token or cookie ("slack".userToken and "slack".cookie in secrets.json)`;
  let first = true;
  return async (signal, ready) => {
    let url: string;
    try {
      if (first) await deps.slackCall("users.setPresence", token, { presence: "auto" }, cookie);
      first = false;
      url = await clientSocketUrl(deps.slackCall, token, cookie);
    } catch (e) {
      if (signal.aborted) return { code: "stopped" };
      return slackEnd(e, which);
    }
    if (signal.aborted) return { code: "stopped" };
    const { promise, resolve } = Promise.withResolvers<End>();
    let done = false;
    let tickle: unknown;
    let id = 0;
    let line: Line | undefined;
    const finish = (end: End, close: boolean) => {
      if (done) return;
      done = true;
      if (tickle !== undefined) deps.timers.clearInterval(tickle);
      signal.removeEventListener("abort", onAbort);
      if (close) {
        try {
          line?.close(1000);
        } catch {
          // already closed
        }
      }
      resolve(end);
    };
    const onAbort = () => finish({ code: "stopped" }, true);
    signal.addEventListener("abort", onAbort);
    try {
      line = deps.open(url, { Cookie: `d=${cookie}`, Origin: "https://app.slack.com" }, {
        onMessage(raw) {
          if (done) return;
          let m: { type?: string; presence?: string };
          try {
            m = JSON.parse(raw);
          } catch {
            return;
          }
          if (m.type === "hello") ready();
          // manual_presence_change is the owner's own choice: never answered (see the top of this file).
          else if (m.type === "manual_presence_change") deps.log(`PRESENCE slack manual_presence_change ${m.presence ?? "?"} (left as set)`);
        },
        onClose(code) {
          finish({ code: String(code) }, false);
        },
      });
    } catch (e) {
      finish({ fatal: `cannot open the Slack client socket: ${(e as Error).message}` }, false);
      return promise;
    }
    if (!done) tickle = deps.timers.setInterval(() => {
      try {
        line?.send(JSON.stringify({ type: "tickle", id: ++id }));
      } catch {
        // closing: the close event ends the session
      }
    }, SLACK_TICKLE_MS);
    return promise;
  };
}

function token(root: string, key: string, envName: string | undefined, env: Record<string, string | undefined>, source: string): string {
  try {
    return secret(root, source, key, envName, env);
  } catch (e) {
    throw new PresenceConfigError((e as Error).message);
  }
}

/** `seori presence <platform>`: tokens from the messenger config (secrets.json, or the messengers' SEORI_* env). */
export async function runPresence(root: string, platform: Platform, opts: { readonly user?: boolean }, deps: PresenceDeps, signal: AbortSignal): Promise<number> {
  const env = deps.env ?? process.env;
  const options = loadMessengers(root).find((c) => c.source === platform)?.options ?? {};
  if (platform === "discord") {
    const url = typeof options["wsUrl"] === "string" ? options["wsUrl"] : DISCORD_GATEWAY;
    return holdPresence("discord", discordSession(token(root, "token", "SEORI_DISCORD_TOKEN", env, "discord"), url, deps), deps, signal);
  }
  let session: Session;
  let release: () => Promise<unknown>;
  if (opts.user) {
    const userToken = token(root, "userToken", undefined, env, "slack");
    const cookie = token(root, "cookie", undefined, env, "slack");
    session = slackUserSession(userToken, cookie, deps);
    release = () => deps.slackCall("users.setPresence", userToken, { presence: "away" }, cookie);
  } else {
    const botToken = token(root, "botToken", "SEORI_SLACK_BOT_TOKEN", env, "slack");
    session = slackBotSession(botToken, deps);
    release = () => deps.slackCall("users.setPresence", botToken, { presence: "away" });
  }
  const code = await holdPresence("slack", session, deps, signal);
  if (!signal.aborted) return code;
  try {
    await release();
    deps.log("PRESENCE slack away");
  } catch (e) {
    deps.error(`PRESENCE slack: could not set away on release: ${(e as Error).message}`);
  }
  return code;
}

/** The real sockets, timers and Slack Web API. */
export function realPresenceDeps(root: string, platform: Platform): PresenceDeps {
  const options = loadMessengers(root).find((c) => c.source === platform)?.options ?? {};
  const apiBase = (typeof options["apiBase"] === "string" ? options["apiBase"] : SLACK_API).replace(/\/+$/, "");
  return {
    open: (url, headers, on) => {
      // Bun's WebSocket takes an options object with headers; the DOM typing in scope only knows protocols.
      const BunWebSocket = WebSocket as unknown as new (url: string, init: Bun.WebSocketOptions) => WebSocket;
      const ws = new BunWebSocket(url, { headers: { ...headers } });
      ws.addEventListener("message", (e) => on.onMessage(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)));
      ws.addEventListener("close", (e) => on.onClose(e.code));
      return { send: (f) => ws.send(f), close: (code) => ws.close(code) };
    },
    timers: { setInterval: (cb, ms) => setInterval(cb, ms), clearInterval: (h) => clearInterval(h as Timer) },
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    slackCall: async (method, tok, params, cookie) => {
      const headers: Record<string, string> = { authorization: `Bearer ${tok}`, ...(cookie ? { cookie: `d=${cookie}` } : {}) };
      const res = await httpJson(`${apiBase}/${method}`, { method: "POST", headers, body: params }, { mutating: false });
      const body = (res.body ?? {}) as Record<string, unknown>;
      if (body["ok"] !== true) throw new SlackCallError(method, typeof body["error"] === "string" ? body["error"] : "unexpected_answer");
      return body;
    },
  };
}
