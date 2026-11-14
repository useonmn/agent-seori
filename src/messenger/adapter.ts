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
  /**
   * A reply in a thread outside DMs: the id (`<source>:<chat>:<message id>`) of that thread's first message, and
   * whether the platform says the owner (`rootByOwner`) or the bot itself (`rootBySeori`) wrote that first message.
   * The lead channel counts the reply as the owner's alone only with `rootByOwner`, or with `rootBySeori` when that
   * message was seori's reply to a message of the owner's alone (channel.ts othersOf); an unknown author is someone else's.
   */
  readonly root?: string;
  readonly rootByOwner?: true;
  readonly rootBySeori?: true;
  readonly from: string;
  readonly at: number;
  readonly text: string;
};

/**
 * Where a message goes. `attached`: the message is about `replyTo` rather than part of the conversation (a duty alert,
 * a progress post), so it stays visibly attached to it even where a reply would not (see MessengerAdapter.send).
 */
export type SendTarget = { readonly chat: string; readonly thread?: string; readonly replyTo?: string; readonly attached?: true };

/** seori's reaction on a message it accepted: `read` once it is stored for the lead, `answered` once the lead answered it. */
export type Reaction = "read" | "answered";

/** An edit waits out a rate limit only this long; a longer one fails at once with when to retry, so the lead is not held. */
export const ACTION_MAX_RETRY_AFTER_MS = 10_000;

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
   * Resolves with the messenger's message id (the first chunk's, when long text is split); Slack also gives the ids of
   * the later chunks (`laterChunks`), since a thread under any of them hangs under seori's reply (rootBySeori). The
   * message goes to `target.chat`, in `target.thread` when set. `target.replyTo` is the part of a stored id after
   * `<source>:<chat>:` (an `:edit:<stamp>` suffix there must be dropped, common.ts replyTarget); platforms with inline
   * replies (Discord, Telegram) quote that message. Slack has none: a reply goes where the message was written, and
   * only an `attached` message without a thread is threaded under `replyTo`.
   * Throws SendUncertain when the request may have reached the platform (also when some chunks of a split reply went
   * out and a later one failed), or any other Error for a definite failure.
   */
  send(target: SendTarget, text: string): Promise<{ messageId: string; laterChunks?: readonly string[] }>;
  /** Verifies credentials and returns who the bot is (e.g. "@seori_bot (id 123)"), for `seori messenger check`. */
  check(): Promise<string>;
  /**
   * Replaces the text of a message the bot sent; text longer than one platform message is refused. Idempotent, so a
   * request that may have arrived is simply retried; a definite refusal rejects with the platform's reason.
   */
  edit(target: SendTarget, message: string, text: string): Promise<void>;
  /**
   * Marks one upstream message (`message`: its id as in `target.replyTo`, without an `:edit:` suffix) with seori's
   * reaction: `read` puts the eyes on it, `answered` replaces them with the platform's check mark (Slack
   * white_check_mark, Discord ✅, Telegram 👌, since ✅ is not among Telegram's allowed reactions). Idempotent: a mark
   * already in place, or eyes already gone, is no error. A refusal rejects; the caller logs it and carries on.
   */
  react(target: SendTarget, message: string, reaction: Reaction): Promise<void>;
  /**
   * Discord only: opens a thread named `name` on `message` (its id as in `target.replyTo`) in the server channel `chat`,
   * a job's own thread, and resolves with the thread's id; undefined where no thread can be opened on it (a DM, a
   * message already inside a thread). A message that already has a thread resolves with that thread, so a retry after
   * an uncertain request opens no second one. Any other failure rejects.
   */
  openThread?(chat: string, message: string, name: string): Promise<string | undefined>;
  /** Discord only: the current name of `thread`; rejects when `thread` is not a thread. */
  threadName?(thread: string): Promise<string>;
  /**
   * Discord only: renames `thread` (when `name` is given) and archives it (`archived: true`) or keeps it open, reopening
   * an archived one (`archived: false`). Idempotent.
   */
  editThread?(thread: string, edit: { readonly name?: string; readonly archived: boolean }): Promise<void>;
}

export type MessengerConfig = {
  readonly source: string;
  /** The owner's sender id: their messages reach the lead as the owner's. */
  readonly owner: string;
  /**
   * Also deliver people other than the owner (never bots), under the addressing rule: a DM to the bot, a mention in a
   * channel, or a reply in a thread the bot follows (Slack) or to the bot's message (Discord). Their messages reach the
   * lead with their own sender id.
   */
  readonly others?: boolean;
  /**
   * Discord only: the ids of the servers (guilds) whose members `others` covers, required with it. A non-owner is
   * delivered from a channel of one of these servers, or in a DM when they are a member of one of them.
   */
  readonly guilds?: readonly string[];
  /**
   * Discord only: the owner too needs a mention of the bot or a reply to it in a server channel, as `others` do. Unset,
   * every message of the owner's in a server channel or thread the bot can read reaches the lead.
   */
  readonly ownerNeedsMention?: boolean;
  readonly options?: Readonly<Record<string, unknown>>;
};

/** `$SEORI_HOME/messengers.json`: `{ "messengers": [ { "source": "fake", "owner": "u1", "others": true } ] }`. Missing file: none. */
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
    if (c.others !== undefined && typeof c.others !== "boolean") throw new ConfigError(`${path}: messengers[${i}].others must be true or false, got ${JSON.stringify(c.others)}`);
    if (c.guilds !== undefined) {
      if (c.source !== "discord") throw new ConfigError(`${path}: messengers[${i}].guilds is only for discord`);
      // Strings: a server id is above 2^53, so a JSON number would already have lost digits.
      if (!Array.isArray(c.guilds) || c.guilds.length === 0 || !c.guilds.every((g: unknown) => typeof g === "string" && /^\d+$/.test(g))) {
        throw new ConfigError(`${path}: messengers[${i}].guilds must be a non-empty array of Discord server ids as strings of digits, got ${JSON.stringify(c.guilds)}`);
      }
    }
    if (c.ownerNeedsMention !== undefined) {
      if (c.source !== "discord") throw new ConfigError(`${path}: messengers[${i}].ownerNeedsMention is only for discord`);
      if (typeof c.ownerNeedsMention !== "boolean") throw new ConfigError(`${path}: messengers[${i}].ownerNeedsMention must be true or false, got ${JSON.stringify(c.ownerNeedsMention)}`);
    }
    // Telegram: anyone can message a bot, and the adapter cannot see whether group privacy mode limits it to mentions.
    if (c.others === true && c.source === "telegram") throw new ConfigError(`${path}: messengers[${i}].others is not supported for telegram; only the owner is answered there`);
    // Discord: anyone may add a public bot to their server, so others are limited to servers the owner names.
    if (c.others === true && c.source === "discord" && c.guilds === undefined) {
      throw new ConfigError(`${path}: messengers[${i}].others on discord needs "guilds": the ids of the servers whose members may talk to seori`);
    }
    return {
      source: c.source,
      owner: c.owner,
      ...(c.others !== undefined ? { others: c.others } : {}),
      ...(c.guilds !== undefined ? { guilds: c.guilds } : {}),
      ...(c.ownerNeedsMention !== undefined ? { ownerNeedsMention: c.ownerNeedsMention } : {}),
      ...(c.options ? { options: c.options } : {}),
    };
  });
}
