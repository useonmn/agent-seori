import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { lockFile } from "./store.ts";

// The lead channel: messenger messages for the lead. `seori daemon` stores a message here before it acknowledges it
// upstream; extensions/lead-channel.ts delivers it into the lead's omp session; it is closed only by a successful
// `seori msg send --reply-to` or by `seori msg close`. Every file is append-only JSONL under $SEORI_HOME/lead/.

/** Upstream message ids are `<source>:<chat>:<message id>`, unique per messenger. */
export type InboundRow = {
  readonly id: string;
  readonly kind: "messenger";
  readonly source: string;
  readonly chat: string;
  readonly thread?: string;
  readonly from: string;
  readonly at: number;
  readonly text: string;
};

/**
 * - delivered: the extension handed the id to omp (attempt counts from 1; mode is how).
 * - entered: the delivered message appeared in the lead's conversation.
 * - replied: `seori msg send --reply-to` got a message id back from the messenger. Closes the id.
 * - closed: `seori msg close`. Closes the id.
 * - send-uncertain: a reply may or may not have reached the messenger; never retried automatically.
 * - gave-up: MAX_DELIVERIES deliveries without a reply or close; the extension stops redelivering.
 * - alerted: duty told the human about this id (once per id and reason).
 */
export type LedgerEvent =
  | { readonly id: string; readonly ev: "delivered"; readonly at: number; readonly attempt: number; readonly mode: "followUp" | "aside"; readonly session?: string }
  | { readonly id: string; readonly ev: "entered"; readonly at: number; readonly session?: string }
  | { readonly id: string; readonly ev: "replied"; readonly at: number; readonly messageId: string }
  | { readonly id: string; readonly ev: "closed"; readonly at: number; readonly why: string }
  | { readonly id: string; readonly ev: "send-uncertain"; readonly at: number; readonly detail: string }
  | { readonly id: string; readonly ev: "gave-up"; readonly at: number; readonly attempts: number }
  | { readonly id: string; readonly ev: "alerted"; readonly at: number; readonly why: string };

export const MAX_DELIVERIES = 3;

export type IdState = {
  readonly row: InboundRow;
  readonly deliveries: number;
  readonly lastDeliveredAt?: number;
  readonly entered: boolean;
  readonly replied: boolean;
  readonly closed: boolean;
  readonly uncertain: boolean;
  readonly gaveUp: boolean;
  readonly alerted: readonly string[];
};

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as T];
          } catch {
            return []; // a torn last line from a crashed writer is skipped, never fatal
          }
        })
    : [];

export class Channel {
  readonly dir: string;
  constructor(readonly root: string) {
    this.dir = join(root, "lead");
    mkdirSync(this.dir, { recursive: true });
  }

  get inboundPath(): string {
    return join(this.dir, "inbound.jsonl");
  }

  get ledgerPath(): string {
    return join(this.dir, "ledger.jsonl");
  }

  /** The single consumer (the lead extension) holds this; a second omp on the same home stays inert. */
  get consumerLockPath(): string {
    return join(this.dir, "consumer.lock");
  }

  /** Appends a row and fsyncs before returning, so the caller may then acknowledge upstream. False: id already stored. */
  appendInbound(row: InboundRow): boolean {
    if (this.inbound().some((r) => r.id === row.id)) return false;
    const fd = openSync(this.inboundPath, "a");
    try {
      writeSync(fd, `${JSON.stringify(row)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  inbound(): InboundRow[] {
    return readJsonl<InboundRow>(this.inboundPath);
  }

  appendLedger(e: LedgerEvent): void {
    appendFileSync(this.ledgerPath, `${JSON.stringify(e)}\n`);
  }

  ledger(): LedgerEvent[] {
    return readJsonl<LedgerEvent>(this.ledgerPath);
  }

  states(): IdState[] {
    const events = this.ledger();
    return this.inbound().map((row) => {
      const mine = events.filter((e) => e.id === row.id);
      const deliveries = mine.filter((e) => e.ev === "delivered");
      return {
        row,
        deliveries: deliveries.length,
        ...(deliveries.length ? { lastDeliveredAt: deliveries.at(-1)!.at } : {}),
        entered: mine.some((e) => e.ev === "entered"),
        replied: mine.some((e) => e.ev === "replied"),
        closed: mine.some((e) => e.ev === "closed"),
        uncertain: mine.some((e) => e.ev === "send-uncertain"),
        gaveUp: mine.some((e) => e.ev === "gave-up"),
        alerted: mine.flatMap((e) => (e.ev === "alerted" ? [e.why] : [])),
      };
    });
  }

  /** Ids still waiting for a reply or close. */
  open(): IdState[] {
    return this.states().filter((s) => !s.replied && !s.closed);
  }

  lockConsumer(now: number): (() => void) | undefined {
    return lockFile(this.consumerLockPath, now);
  }
}
