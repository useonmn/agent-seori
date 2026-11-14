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
  readonly from: string;
  readonly at: number;
  readonly text: string;
};

export type SendTarget = { readonly chat: string; readonly thread?: string; readonly replyTo?: string };

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
   * Resolves with the messenger's message id (the first chunk's, when long text is split). `target.replyTo` is the part
   * of a stored id after `<source>:<chat>:`; an `:edit:<stamp>` suffix there must be dropped (common.ts replyTarget).
   * Throws SendUncertain when the request may have reached the platform (also when some chunks of a split reply went
   * out and a later one failed), or any other Error for a definite failure.
   */
  send(target: SendTarget, text: string): Promise<{ messageId: string }>;
  /** Verifies credentials and returns who the bot is (e.g. "@seori_bot (id 123)"), for `seori messenger check`. */
  check(): Promise<string>;
  /**
   * Replaces the text of a message the bot sent; text longer than one platform message is refused. Idempotent, so a
   * request that may have arrived is simply retried; a definite refusal rejects with the platform's reason.
   */
  edit(target: SendTarget, message: string, text: string): Promise<void>;
}

export type MessengerConfig = {
  readonly source: string;
  /** The owner's sender id: their messages reach the lead as the owner's. */
  readonly owner: string;
  /**
   * Also deliver people other than the owner (never bots), under the same addressing rule: a DM to the bot, a mention
   * in a channel, or a reply in a thread the bot follows. Their messages reach the lead with their own sender id.
   */
  readonly others?: boolean;
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
    // Telegram: anyone can message a bot, and the adapter cannot see whether group privacy mode limits it to mentions.
    // Discord: anyone may share a server with a public bot; others there wait for a guild allowlist.
    if (c.others === true && (c.source === "telegram" || c.source === "discord")) {
      throw new ConfigError(`${path}: messengers[${i}].others is not supported for ${c.source}; only the owner is answered there`);
    }
    return { source: c.source, owner: c.owner, ...(c.others !== undefined ? { others: c.others } : {}), ...(c.options ? { options: c.options } : {}) };
  });
}
