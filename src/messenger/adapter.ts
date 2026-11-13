import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../config.ts";

// One messenger (fake, telegram, slack, discord) behind one interface. `seori daemon` runs `receive` for each configured
// messenger; `seori msg send` calls `send`. Real platform adapters arrive in a later stage; `fake` is for tests.

export type InboundMessage = {
  /** `<source>:<chat>:<message id>`; the same upstream message always yields the same id. */
  readonly id: string;
  readonly source: string;
  readonly chat: string;
  readonly thread?: string;
  /** The sender's platform id. */
  readonly from: string;
  /** Who sent it (src/daemon.ts decides who reaches the lead). The bot's own messages are never delivered. */
  readonly sender: Sender;
  readonly at: number;
  readonly text: string;
  /** The message this one replies to, as a lead channel id, with its text when the platform sent it along. */
  readonly replyTo?: ReplyRef;
};

/**
 * owner: the configured owner (never a bot). agent: an author the platform marks as a bot or app (Slack bot_id or
 * subtype bot_message, Discord author.bot, Telegram from.is_bot). person: anyone else.
 */
export type SenderKind = "owner" | "person" | "agent";
export type Sender = { readonly kind: SenderKind; readonly id: string; readonly name?: string };

export type ReplyRef = { readonly id: string; readonly text?: string };

/** A message read back by id (`seori msg show`), or why it cannot be. */
export type FetchedMessage = { readonly from: string; readonly at: number; readonly text: string } | { readonly unavailable: string };

export type SendTarget = { readonly chat: string; readonly thread?: string; readonly replyTo?: string };

/** A job thread's state, shown as an emoji at the start of its name (on Slack, as a reaction on its first message). */
export type ThreadStatus = "working" | "waiting" | "done";
export const STATUS_EMOJI: Readonly<Record<ThreadStatus, string>> = { working: "🔄", waiting: "⏸", done: "✅" };
/** The reaction seori puts on each owner message while it handles it. */
export const EYES = "👀";

/**
 * A thread to act on: `thread` is the platform's thread or topic (Slack: the root ts; Discord: the thread channel, or
 * `chat` itself when the message came in inside a thread), `message` the message it was asked from.
 */
export type ThreadTarget = { readonly chat: string; readonly thread?: string; readonly message?: string };
export type ThreadChange = { readonly name?: string; readonly status?: ThreadStatus; readonly state?: "close" | "reopen" };
/** One line per part of an action the platform cannot do; empty when everything was done. */
export type ActionNotes = readonly string[];
/** What a thread change did: the name set, the status shown (Slack's reaction), the state changed; `notes` for the rest. */
export type ThreadResult = { readonly name?: string; readonly status?: ThreadStatus; readonly state?: "close" | "reopen"; readonly notes: ActionNotes };
/** Actions wait out a rate limit only this long; a longer one fails at once with when to retry, so the lead is not held. */
export const ACTION_MAX_RETRY_AFTER_MS = 10_000;

/** `name` with the status emoji in front, replacing a status emoji already there. */
export function threadName(name: string, status: ThreadStatus | undefined): string {
  const marks = Object.values(STATUS_EMOJI);
  const trimmed = name.trim();
  const mark = marks.find((m) => trimmed.startsWith(m));
  if (!status) return trimmed;
  const bare = mark ? trimmed.slice(mark.length).replace(/^\uFE0F/, "").trimStart() : trimmed;
  return `${STATUS_EMOJI[status]} ${bare}`;
}

/** The request may have reached the messenger (a timeout after sending, a dropped connection). Never retried automatically. */
export class SendUncertain extends Error {}

/**
 * Adapters retry transient errors inside receive and reject once they have failed continuously this long, so the
 * daemon records the outage (src/daemon.ts health) and duty can tell the lead. Shorter than the daemon's HEALTHY_AFTER_MS.
 */
export const ADAPTER_OUTAGE_MS = 2 * 60_000;

export interface MessengerAdapter {
  readonly source: string;
  /**
   * Runs until `signal` aborts. Calls `onMessage` for every upstream message in order and commits its upstream offset
   * only after `onMessage` resolved (at-least-once: a crash before the commit replays the message, and the daemon's
   * id dedupe absorbs it). A rejected `onMessage` stops the commit for that message.
   */
  receive(signal: AbortSignal, onMessage: (m: InboundMessage) => Promise<void>): Promise<void>;
  /**
   * Resolves with the messenger's message id (the first chunk's, when long text is split). `target.replyTo` is the part
   * of a stored id after `<source>:<chat>:`; an `:edit:<stamp>` suffix there must be dropped (common.ts replyTarget).
   * Throws SendUncertain when the request may have reached the platform (also when some chunks of a split reply went
   * out and a later one failed), or any other Error for a definite failure.
   */
  send(target: SendTarget, text: string): Promise<{ messageId: string }>;
  /** Verifies credentials and returns who the bot is (e.g. "@seori_bot (id 123)"), for `seori messenger check`. */
  check(): Promise<string>;
  /**
   * Adds (`on`) or removes the bot's eyes reaction on `message` in `chat`. This and the actions below are idempotent, so
   * a request that may have arrived is simply retried; a definite refusal rejects with the platform's reason.
   */
  react(chat: string, message: string, on: boolean): Promise<void>;
  /** Replaces the text of a message the bot sent; text longer than one platform message is refused. */
  edit(target: SendTarget, message: string, text: string): Promise<void>;
  /** Shows the typing indicator once. */
  typing(target: ThreadTarget): Promise<ActionNotes>;
  /** Sets a thread's name (with the status emoji in front) and closes or reopens it, as far as the platform can. */
  thread(target: ThreadTarget, change: ThreadChange): Promise<ThreadResult>;
  /** Reads one message of `chat` by its platform id; `unavailable` says why not (not found, the platform cannot). */
  fetchMessage(chat: string, message: string): Promise<FetchedMessage>;
}

export type MessengerConfig = {
  readonly source: string;
  /** The owner's sender id. Only the owner's messages reach the lead unless config.json talkWithOthers is on. */
  readonly owner: string;
  readonly options?: Readonly<Record<string, unknown>>;
};

/** `$SEORI_HOME/messengers.json`: `{ "messengers": [ { "source": "fake", "owner": "u1" } ] }`. Missing file: none. */
export function loadMessengers(root: string): MessengerConfig[] {
  const path = join(root, "messengers.json");
  if (!existsSync(path)) return [];
  let parsed: { messengers?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { messengers?: unknown };
  } catch (e) {
    throw new ConfigError(`${path}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(parsed.messengers)) throw new ConfigError(`${path}: "messengers" must be an array`);
  return parsed.messengers.map((m, i) => {
    const c = m as Partial<MessengerConfig>;
    if (typeof c.source !== "string" || typeof c.owner !== "string") throw new ConfigError(`${path}: messengers[${i}] needs string "source" and "owner"`);
    return { source: c.source, owner: c.owner, ...(c.options ? { options: c.options } : {}) };
  });
}
