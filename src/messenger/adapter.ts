import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** The request may have reached the messenger (a timeout after sending, a dropped connection). Never retried automatically. */
export class SendUncertain extends Error {}

export interface MessengerAdapter {
  readonly source: string;
  /**
   * Runs until `signal` aborts. Calls `onMessage` for every upstream message in order and commits its upstream offset
   * only after `onMessage` resolved (at-least-once: a crash before the commit replays the message, and the daemon's
   * id dedupe absorbs it). A rejected `onMessage` stops the commit for that message.
   */
  receive(signal: AbortSignal, onMessage: (m: InboundMessage) => Promise<void>): Promise<void>;
  /** Resolves with the messenger's message id. Throws SendUncertain, or any other Error for a definite failure. */
  send(target: SendTarget, text: string): Promise<{ messageId: string }>;
}

export type MessengerConfig = {
  readonly source: string;
  /** Only messages from this sender id reach the lead (the same owner-only rule as dori). */
  readonly owner: string;
  readonly options?: Readonly<Record<string, unknown>>;
};

/** `$SEORI_HOME/messengers.json`: `{ "messengers": [ { "source": "fake", "owner": "u1" } ] }`. Missing file: none. */
export function loadMessengers(root: string): MessengerConfig[] {
  const path = join(root, "messengers.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { messengers?: unknown };
  if (!Array.isArray(parsed.messengers)) throw new Error(`${path}: "messengers" must be an array`);
  return parsed.messengers.map((m, i) => {
    const c = m as Partial<MessengerConfig>;
    if (typeof c.source !== "string" || typeof c.owner !== "string") throw new Error(`${path}: messengers[${i}] needs string "source" and "owner"`);
    return { source: c.source, owner: c.owner, ...(c.options ? { options: c.options } : {}) };
  });
}
