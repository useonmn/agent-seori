import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { lockFile, pidAlive } from "./store.ts";

// The lead channel: what the lead is told without a pane message. Messenger messages: `seori daemon` stores one here
// before it acknowledges it upstream; extensions/lead-channel.ts delivers it into the lead's omp session; it is closed
// only by a successful `seori msg send --reply-to` or by `seori msg close`. Watch events (src/watch/deliver.ts) take
// the same delivery path but need no reply: the extension closes them once the lead has seen them. Every file is
// append-only JSONL under $SEORI_HOME/lead/.

/** Upstream message ids are `<source>:<chat>:<message id>`, unique per messenger. */
export type MessengerRow = {
  readonly id: string;
  readonly kind: "messenger";
  readonly source: string;
  readonly chat: string;
  readonly thread?: string;
  /**
   * A reply in a thread outside DMs: the id of the thread's first message, and whether the platform says the owner
   * (`rootByOwner`) or seori itself (`rootBySeori`) wrote it (InboundMessage).
   */
  readonly root?: string;
  readonly rootByOwner?: true;
  readonly rootBySeori?: true;
  readonly from: string;
  /** Sent by someone other than the owner (the messenger's `others` opt-in); absent for the owner. */
  readonly notOwner?: true;
  readonly at: number;
  readonly text: string;
};

/** One event of a lead-owned watch; ids are `watch:<watch id>:<seq>`, seq counting that watch's rows from 1. */
export type WatchRow = {
  readonly id: string;
  readonly kind: "watch";
  readonly watchId: string;
  readonly name: string;
  readonly at: number;
  readonly text: string;
};

export type InboundRow = MessengerRow | WatchRow;

/**
 * A row an earlier seori stored from someone other than the owner (`sender.kind` person, agent or trusted, from the
 * removed talking-with-others): it counts as closed, so it is never delivered to the lead again.
 */
export const fromOther = (row: InboundRow): boolean => {
  const kind = (row as { readonly sender?: { readonly kind?: unknown } }).sender?.kind;
  return row.kind === "messenger" && kind !== undefined && kind !== "owner";
};

/** A message from someone other than the owner: the messenger's `others` opt-in (`notOwner`), or `fromOther`. */
const nonOwner = (row: InboundRow): boolean => row.kind === "messenger" && (row.notOwner === true || fromOther(row));

/**
 * The ids that are not the owner's alone, denied by default: everything except the owner's own messages that are a DM, a
 * top-level message or a thread's first message (no `root`), a reply in a thread whose first message the platform
 * says the owner wrote (`rootByOwner`), or a reply in a thread whose first message the platform says seori wrote
 * (`rootBySeori`) when the ledger shows that message answered only messages of the owner's alone (on Slack seori
 * answers a top-level message top-level, so the owner's follow-up thread hangs under seori's answer). A reply under
 * someone else's message, or under one of unknown author, is shared: whoever else is in that thread would see what is
 * posted there. Nothing is inferred from which rows happen to be stored.
 */
function othersOf(rows: readonly InboundRow[], ledger: () => readonly LedgerEvent[]): Set<string> {
  const messengers = rows.filter((row): row is MessengerRow => row.kind === "messenger");
  const plain = (row: MessengerRow): boolean => !nonOwner(row) && (row.root === undefined || row.rootByOwner === true);
  let answers: Set<string> | undefined;
  /** Whether `root` is `<source>:<chat>:<message id>` of a reply seori sent only to messages of the owner's alone. */
  const answersOwner = (root: string): boolean => {
    if (answers === undefined) {
      const byId = new Map(messengers.map((row) => [row.id, row]));
      const owner = new Set<string>();
      // One reply may answer several ids (`msg send --reply-to a,b`): answering anyone else as well makes it shared.
      const shared = new Set<string>();
      for (const e of ledger()) {
        if (e.ev !== "replied") continue;
        const row = byId.get(e.id);
        if (row) (plain(row) ? owner : shared).add(`${row.source}:${row.chat}:${e.messageId}`);
      }
      answers = new Set([...owner].filter((key) => !shared.has(key)));
    }
    return answers.has(root);
  };
  const ownerAlone = (row: MessengerRow): boolean =>
    plain(row) || (!nonOwner(row) && row.rootBySeori === true && row.root !== undefined && answersOwner(row.root));
  return new Set(messengers.filter((row) => !ownerAlone(row)).map((row) => row.id));
}

/**
 * How a reader sees the lead channel. By default only what is the owner's alone exists (see othersOf; watch events
 * too); `withOthers` also shows the rest, for the few readers that must see it: delivering it to the lead, replying to
 * or listing it. Where only the owner's message or thread may go, refuse an id in `othersIds()`.
 */
export type ChannelView = { readonly withOthers?: boolean };

/**
 * - delivered: the extension handed the id to omp (attempt counts from 1; mode is how).
 * - entered: the delivered message appeared in the lead's conversation.
 * - sending: `seori msg send --reply-to` is about to call the messenger. Written first, so a process killed mid-send
 *   leaves a trace: a `sending` with no later `replied` or `send-failed` counts as uncertain (see IdState.uncertain).
 * - replied: `seori msg send --reply-to` got a message id back from the messenger. Closes the id.
 * - send-failed: the messenger definitely did not take the reply; settles the `sending` before it, the id stays open.
 * - closed: `seori msg close`, or the extension for a watch row the lead has seen (why "seen") or that gave up
 *   (why "gave-up"). Closes the id.
 * - send-uncertain: a reply may or may not have reached the messenger; never retried automatically.
 * - gave-up: MAX_DELIVERIES deliveries without a reply or close; the extension stops redelivering.
 * - alerted: duty told the human about this id (once per id and reason).
 */
export type LedgerEvent =
  | { readonly id: string; readonly ev: "delivered"; readonly at: number; readonly attempt: number; readonly mode: "followUp" | "aside"; readonly session?: string }
  | { readonly id: string; readonly ev: "entered"; readonly at: number; readonly session?: string }
  | { readonly id: string; readonly ev: "sending"; readonly at: number }
  | { readonly id: string; readonly ev: "replied"; readonly at: number; readonly messageId: string }
  | { readonly id: string; readonly ev: "send-failed"; readonly at: number; readonly detail: string }
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
  /** A send-uncertain, or a `sending` not settled by a later replied/send-failed: the reply may be in the chat. */
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

  /** Ids of the rows in inbound.jsonl up to byte `scanned`, so appendInbound reads only what was appended since. */
  private readonly stored = new Set<string>();
  private scanned = 0;

  /**
   * Reads inbound.jsonl from `scanned` to its end and records the ids of its complete lines. True: the file ends in a
   * torn line (a writer that died mid-row); that piece stays unscanned until a newline completes it.
   */
  private scanInbound(): boolean {
    let size: number;
    try {
      size = statSync(this.inboundPath).size;
    } catch {
      return false;
    }
    if (size < this.scanned) {
      this.stored.clear(); // replaced by hand: start over
      this.scanned = 0;
    }
    if (size === this.scanned) return false;
    const buf = Buffer.alloc(size - this.scanned);
    let got = 0;
    const fd = openSync(this.inboundPath, "r");
    try {
      for (let n = 1; n > 0 && got < buf.length; got += n) n = readSync(fd, buf, got, buf.length - got, this.scanned + got);
    } finally {
      closeSync(fd);
    }
    const end = buf.subarray(0, got).lastIndexOf(0x0a) + 1;
    for (const line of buf.toString("utf8", 0, end).split("\n")) {
      try {
        const id = (JSON.parse(line) as Partial<InboundRow>).id;
        if (typeof id === "string") this.stored.add(id);
      } catch {
        // blank, or the torn remains of a crashed write
      }
    }
    this.scanned += end;
    return end < got;
  }

  /**
   * Appends a row and fsyncs before returning, so the caller may then acknowledge upstream. False: id already stored.
   * After a torn tail the row starts on a new line; glued onto the torn bytes it would never parse, a silent loss.
   */
  appendInbound(row: InboundRow): boolean {
    const torn = this.scanInbound();
    if (this.stored.has(row.id)) return false;
    const fd = openSync(this.inboundPath, "a");
    try {
      writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(row)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.scanInbound();
    return true;
  }

  /** A row of upstream message `id` (`<source>:<chat>:<message id>`) is stored: that id, or an edit of it (`<id>:edit:<stamp>`). */
  hasMessage(id: string): boolean {
    this.scanInbound();
    if (this.stored.has(id)) return true;
    for (const stored of this.stored) if (stored.startsWith(`${id}:edit:`)) return true;
    return false;
  }

  /** Stored rows, oldest first: the owner's alone and watch events, plus everything else with `withOthers`. */
  inbound(view: ChannelView = {}): InboundRow[] {
    const rows = readJsonl<InboundRow>(this.inboundPath);
    if (view.withOthers === true) return rows;
    const others = othersOf(rows, () => this.ledger());
    return rows.filter((row) => !others.has(row.id));
  }

  /** Ids that are not the owner's alone (see othersOf): where only the owner's message or thread may go, refuse them. */
  othersIds(): Set<string> {
    return othersOf(this.inbound({ withOthers: true }), () => this.ledger());
  }

  appendLedger(e: LedgerEvent): void {
    appendFileSync(this.ledgerPath, `${JSON.stringify(e)}\n`);
  }

  ledger(): LedgerEvent[] {
    return readJsonl<LedgerEvent>(this.ledgerPath);
  }

  /** One pass over the ledger grouped by id: the lead extension and duty call this every tick, for all history. */
  states(view: ChannelView = {}): IdState[] {
    type Acc = { deliveries: number; lastDeliveredAt?: number; entered: boolean; replied: boolean; closed: boolean; sendUncertain: boolean; inFlight: boolean; gaveUp: boolean; alerted: string[] };
    const byId = new Map<string, Acc>();
    for (const e of this.ledger()) {
      let a = byId.get(e.id);
      if (!a) {
        a = { deliveries: 0, entered: false, replied: false, closed: false, sendUncertain: false, inFlight: false, gaveUp: false, alerted: [] };
        byId.set(e.id, a);
      }
      switch (e.ev) {
        case "delivered":
          a.deliveries++;
          a.lastDeliveredAt = e.at;
          break;
        case "entered":
          a.entered = true;
          break;
        case "sending":
          a.inFlight = true;
          break;
        case "replied":
          a.replied = true;
          a.inFlight = false;
          break;
        case "send-failed":
          a.inFlight = false;
          break;
        case "closed":
          a.closed = true;
          break;
        case "send-uncertain":
          a.sendUncertain = true;
          break;
        case "gave-up":
          a.gaveUp = true;
          break;
        case "alerted":
          a.alerted.push(e.why);
          break;
      }
    }
    return this.inbound(view).map((row) => {
      const a = byId.get(row.id);
      if (!a) return { row, deliveries: 0, entered: false, replied: false, closed: fromOther(row), uncertain: false, gaveUp: false, alerted: [] };
      return {
        row,
        deliveries: a.deliveries,
        ...(a.lastDeliveredAt !== undefined ? { lastDeliveredAt: a.lastDeliveredAt } : {}),
        entered: a.entered,
        replied: a.replied,
        closed: a.closed || fromOther(row),
        uncertain: a.sendUncertain || a.inFlight,
        gaveUp: a.gaveUp,
        alerted: a.alerted,
      };
    });
  }

  /** Ids still waiting for a reply or close. */
  open(view: ChannelView = {}): IdState[] {
    return this.states(view).filter((s) => !s.replied && !s.closed);
  }

  lockConsumer(now: number): (() => void) | undefined {
    return lockFile(this.consumerLockPath, now);
  }

  /**
   * No lead extension is consuming: its lock is missing or held by a dead pid on this host. A lock from another host,
   * or one that cannot be read, cannot be judged here, so it counts as consuming rather than raising a false alarm.
   */
  consumerOffline(): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.consumerLockPath, "utf8");
    } catch {
      return true;
    }
    const lock = (() => { try { return JSON.parse(raw) as { pid?: unknown; host?: unknown }; } catch { return {}; } })();
    return lock.host === hostname() && typeof lock.pid === "number" && !pidAlive(lock.pid);
  }

  /** Held by `seori msg send --reply-to` across check → send → record, so two replies to one id can't both go out. */
  get replyLockPath(): string {
    return join(this.dir, "reply.lock");
  }

  lockReply(now: number): (() => void) | undefined {
    return lockFile(this.replyLockPath, now);
  }
}
