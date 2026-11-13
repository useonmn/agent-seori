// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { join } from "node:path";
import { CursorFile, secret } from "./common.ts";
import { type OpenLine, type SlackAuth, type SlackCall, slackApi, slackPresence } from "./slack-presence.ts";

// `seori presence slack|discord`, the upstream design:
// Slack: a web-client socket on the user token and `d` cookie (slack-presence.ts), held by hold() once a minute, which
// prints `PRESENCE slack opened` (users.setPresence auto, then a new socket) or `PRESENCE slack tickled`; a failed tick
// prints `WARN <why>` and the next minute tries again. Stopping closes the socket and sets away.
// Discord: a gateway connection that identifies with status online and heartbeats. Unlike upstream, a closed
// connection (or op 7 / op 9) is followed by a new one after a backoff (5 s doubling to 300 s, reset only after a
// connection held 10 minutes), every identify counts against a budget persisted in $SEORI_HOME/presence/, and a
// rejected token or setup (close 4004, 4010-4014) exits 1 instead of identifying again.

export const BACKOFF_START_MS = 5_000;
export const BACKOFF_CAP_MS = 300_000;
/** A Discord connection that held at least this long resets the backoff. */
export const STABLE_MS = 10 * 60_000;
/** Discord identifies allowed per rolling IDENTIFY_WINDOW_MS (Discord allows 1,000 a day and resets the token past it). */
export const DISCORD_IDENTIFY_BUDGET = 200;
export const IDENTIFY_WINDOW_MS = 24 * 60 * 60_000;
/** Slack: how often hold() runs (upstream's `every(1, ...)`). */
export const SLACK_TICK_MS = 60_000;
/** How long setting away on release may take once stopped. */
export const RELEASE_TIMEOUT_MS = 10_000;
/** A gateway that has not sent hello (op 10) this long after opening is closed and replaced. */
export const HELLO_TIMEOUT_MS = 30_000;
export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

export type Platform = "slack" | "discord";
export type Timers = { setInterval(cb: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
export type GatewaySocket = { send(data: string): void; close(): void; onMessage(cb: (data: string) => void): void; onClose(cb: (code: number) => void): void };

export type PresenceDeps = {
  readonly openSlack: OpenLine;
  readonly openDiscord: () => GatewaySocket;
  readonly slackApi: (auth: SlackAuth) => SlackCall;
  readonly timers: Timers;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  readonly env?: Record<string, string | undefined>;
};

/** How a Discord connection ended: `code` says why and a new one follows; `fatal` stops the command. */
export type End = { readonly code: string } | { readonly fatal: string };

/** A missing or unreadable token: the command refuses (exit 2) instead of starting. */
export class PresenceConfigError extends Error {}

/** Error text bound for output: a socket URL's token parameter and any Slack token are replaced with REDACTED. */
export function redact(text: string): string {
  return text.replace(/([?&]token=)[^&\s#"']*/g, "$1REDACTED").replace(/xox[a-z]-[A-Za-z0-9-]+/g, "REDACTED");
}

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

/** Identifies in the last IDENTIFY_WINDOW_MS, persisted so a restart keeps counting. */
export function identifyBudget(path: string) {
  const file = new CursorFile<number[]>(path);
  const recent = (now: number) => {
    const all = file.load();
    return (Array.isArray(all) ? all : []).filter((t) => typeof t === "number" && now - t < IDENTIFY_WINDOW_MS).sort((x, y) => x - y);
  };
  return {
    /** 0 when an identify may go out now, else how long until the oldest counted one leaves the window. */
    waitMs(now: number): number {
      const r = recent(now);
      return r.length < DISCORD_IDENTIFY_BUDGET ? 0 : r[r.length - DISCORD_IDENTIFY_BUDGET]! + IDENTIFY_WINDOW_MS - now;
    },
    record(now: number): void {
      file.save([...recent(now), now]);
    },
  };
}

function closeEnd(code: number): End {
  if (code === 4004) return { fatal: `Discord rejected the bot token (gateway close 4004); reset it in the Developer Portal and update "discord": { "token": ... } in secrets.json or SEORI_DISCORD_TOKEN` };
  if (code >= 4010 && code <= 4014) return { fatal: `Discord refused the gateway setup (close ${code})` };
  return { code: String(code) };
}

/** One gateway connection: identify as online after hello, heartbeat with the last sequence. `on.end` reports its end. */
export const discordPresence = (
  open: () => GatewaySocket,
  token: string,
  clock: Timers,
  on: { readonly identify: () => void; readonly end: (end: End) => void },
) => {
  const ws = open();
  let seq: number | null = null;
  let beat: unknown;
  let helloTimer: unknown;
  let acked = true;
  let over = false;
  const stopHello = () => {
    if (helloTimer !== undefined) clock.clearInterval(helloTimer);
    helloTimer = undefined;
  };
  const stopBeat = () => {
    stopHello();
    if (beat !== undefined) clock.clearInterval(beat);
    beat = undefined;
  };
  const end = (e: End) => {
    if (over) return;
    over = true;
    stopBeat();
    on.end(e);
  };
  // The injected clock only has intervals: the hello timeout is one that is cleared by hello (or any end) before it can repeat.
  helloTimer = clock.setInterval(() => {
    ws.close();
    end({ code: "no-hello" });
  }, HELLO_TIMEOUT_MS);
  const heartbeat = () => ws.send(JSON.stringify({ op: 1, d: seq }));
  ws.onMessage((raw) => {
    const m = JSON.parse(raw) as { op: number; s?: number | null; d?: { heartbeat_interval?: number } };
    if (typeof m.s === "number") seq = m.s;
    if (m.op === 10 && m.d?.heartbeat_interval) {
      stopHello();
      beat = clock.setInterval(() => {
        if (!acked) {
          // No op 11 since the last beat: the connection is a zombie.
          ws.close();
          end({ code: "zombie" });
          return;
        }
        acked = false;
        heartbeat();
      }, m.d.heartbeat_interval);
      on.identify();
      ws.send(
        JSON.stringify({
          op: 2,
          d: {
            token,
            intents: DISCORD_INTENTS_GUILD_MESSAGES,
            properties: { os: process.platform, browser: "seori", device: "seori" },
            presence: { status: "online", since: null, activities: [], afk: false },
          },
        }),
      );
    } else if (m.op === 11) {
      acked = true;
    } else if (m.op === 1) {
      heartbeat();
    } else if (m.op === 7 || m.op === 9) {
      ws.close();
      end({ code: `op${m.op}` });
    }
  });
  ws.onClose((code) => end(closeEnd(code)));
  return {
    close() {
      over = true;
      stopBeat();
      ws.close();
    },
  };
};

/** Discord connections until `signal` aborts (exit 0) or one ends fatally (exit 1). */
async function holdDiscord(token: string, budgetPath: string, deps: PresenceDeps, signal: AbortSignal): Promise<number> {
  const budget = identifyBudget(budgetPath);
  let delay = BACKOFF_START_MS;
  let announced = false;
  while (!signal.aborted) {
    for (let wait = budget.waitMs(deps.now()); wait > 0 && !signal.aborted; wait = budget.waitMs(deps.now())) {
      deps.log(`PRESENCE_WAIT discord identify budget spent; next identify in ${Math.ceil(wait / 1000)}s`);
      await pause(wait, signal, deps.sleep);
    }
    if (signal.aborted) break;
    const { promise, resolve } = Promise.withResolvers<End>();
    const p = discordPresence(deps.openDiscord, token, deps.timers, { identify: () => budget.record(deps.now()), end: resolve });
    const opened = deps.now();
    if (!announced) {
      announced = true;
      deps.log("PRESENCE_READY discord");
    }
    const onAbort = () => {
      p.close();
      resolve({ code: "stopped" });
    };
    signal.addEventListener("abort", onAbort);
    const end = await promise;
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) break;
    if ("fatal" in end) {
      deps.error(redact(`PRESENCE_FAILED discord: ${end.fatal}`));
      return 1;
    }
    if (deps.now() - opened >= STABLE_MS) delay = BACKOFF_START_MS;
    deps.log(`PRESENCE_RECONNECT discord code=${end.code} retry_in=${delay / 1000}s`);
    await pause(delay, signal, deps.sleep);
    delay = Math.min(delay * 2, BACKOFF_CAP_MS);
  }
  return 0;
}

const warn = (e: unknown) => redact(`WARN ${e instanceof Error ? e.message : String(e)}`).slice(0, 300);

/** Slack: hold() every minute until `signal` aborts, then release (exit 0). */
async function holdSlack(auth: SlackAuth, deps: PresenceDeps, signal: AbortSignal): Promise<number> {
  const p = slackPresence(deps.slackApi(auth), deps.openSlack, auth);
  deps.log("PRESENCE_READY slack");
  while (!signal.aborted) {
    try {
      deps.log(`PRESENCE slack ${await p.hold(signal)}`);
    } catch (e) {
      if (!signal.aborted) deps.log(warn(e));
    }
    await pause(SLACK_TICK_MS, signal, deps.sleep);
  }
  // The stop signal is already aborted, so release gets its own deadline instead of waiting out an outage.
  const deadline = new AbortController();
  void deps.sleep(RELEASE_TIMEOUT_MS).then(() => deadline.abort());
  try {
    await p.release(deadline.signal);
  } catch (e) {
    deps.log(warn(e));
  }
  return 0;
}

function token(root: string, source: string, key: string, envName: string | undefined, env: Record<string, string | undefined>): string {
  try {
    return secret(root, source, key, envName, env);
  } catch (e) {
    throw new PresenceConfigError((e as Error).message);
  }
}

/** `seori presence <platform>`: Slack reads "slack".userToken and .cookie from secrets.json; Discord the bot token. */
export async function runPresence(root: string, platform: Platform, deps: PresenceDeps, signal: AbortSignal): Promise<number> {
  const env = deps.env ?? process.env;
  if (platform === "slack") {
    const auth = { token: token(root, "slack", "userToken", undefined, env), cookie: token(root, "slack", "cookie", undefined, env) };
    return holdSlack(auth, deps, signal);
  }
  const bot = token(root, "discord", "token", "SEORI_DISCORD_TOKEN", env);
  return holdDiscord(bot, join(root, "presence", "discord-identify.json"), deps, signal);
}

/** The real sockets, timers and Slack Web API. */
export function realPresenceDeps(): PresenceDeps {
  return {
    openSlack: (url, headers) => {
      // Bun's WebSocket takes an options object with headers; the DOM typing in scope only knows protocols.
      const BunWebSocket = WebSocket as unknown as new (url: string, init: Bun.WebSocketOptions) => WebSocket;
      const ws = new BunWebSocket(url, { headers: { ...headers } });
      return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
    },
    openDiscord: () => {
      const ws = new WebSocket(DISCORD_GATEWAY);
      return {
        send: (d) => ws.send(d),
        close: () => ws.close(),
        onMessage: (cb) => ws.addEventListener("message", (e) => cb(String(e.data))),
        onClose: (cb) => ws.addEventListener("close", (e) => cb(e.code)),
      };
    },
    slackApi: (auth) => slackApi(auth),
    timers: { setInterval: (cb, ms) => setInterval(cb, ms), clearInterval: (h) => clearInterval(h as Timer) },
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  };
}
