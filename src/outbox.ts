import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { lockFile } from "./store.ts";

// The lead's outbox: replies and notices the lead wrote with `seori msg send` while its turn was still running. The
// lead's omp runs with an agent-end advisor review, and a reply sent mid-turn would reach the chat before that review;
// a concern then made the lead send a correction. So while the lead extension is consuming, a send is kept here as a
// draft, and extensions/lead-channel.ts flushes the open drafts once the turn has ended with no continuation
// (src/release.ts schedules it, src/msg.ts sends). Append-only JSONL at $SEORI_HOME/lead/outbox.jsonl, each line
// fsynced, so a recorded draft survives a crash.

/** Where a draft goes: a reply to messenger message ids, or a notice to a chat (thread optional). */
export type DraftTarget =
  | { readonly kind: "reply"; readonly ids: readonly string[] }
  | { readonly kind: "notice"; readonly source: string; readonly chat: string; readonly thread?: string };

/**
 * - drafted: `seori msg send` recorded a draft. `again`: the send passed --again, so the flush does too.
 * - replaced: the text of an open draft was changed (a second send to the same ids, or --replace).
 * - dropped: `seori msg drop`; the draft is never sent.
 * - sending: a flush is about to call the messenger. Written first, so a flush killed mid-send leaves a trace: a
 *   `sending` with no later `failed` or `released` may be in the chat, and the next flush does not send it again.
 * - failed: the messenger definitely did not take it; settles the `sending`, the draft stays open.
 * - released: sent, or sent with an uncertain outcome (recorded in the channel ledger for a reply); the draft is done.
 */
export type OutboxEvent =
  | { readonly ev: "drafted"; readonly draft: string; readonly at: number; readonly target: DraftTarget; readonly text: string; readonly again?: true }
  | { readonly ev: "replaced"; readonly draft: string; readonly at: number; readonly text: string; readonly again?: true }
  | { readonly ev: "dropped"; readonly draft: string; readonly at: number; readonly why: string }
  | { readonly ev: "sending"; readonly draft: string; readonly at: number }
  | { readonly ev: "failed"; readonly draft: string; readonly at: number; readonly detail: string }
  | { readonly ev: "released"; readonly draft: string; readonly at: number };

/** An open draft (neither released nor dropped) as its events add up. */
export type Draft = {
  readonly draft: string;
  /** When it was drafted: flushes go in this order, and duty's [DRAFTS] alert counts from it. */
  readonly at: number;
  readonly target: DraftTarget;
  readonly text: string;
  /** When the text was last written (drafted or replaced): a turn-end flush sends only drafts written before that end. */
  readonly editedAt: number;
  readonly again: boolean;
  /** A `sending` not settled by a later `failed` or `released`: an earlier flush was killed mid-send. */
  readonly inFlight: boolean;
};

/** `ids` for a reply, `source:chat[:thread]` for a notice: how the CLI names a draft's target. */
export function targetLabel(t: DraftTarget): string {
  return t.kind === "reply" ? t.ids.join(",") : [t.source, t.chat, ...(t.thread !== undefined ? [t.thread] : [])].join(":");
}

export class Outbox {
  readonly path: string;
  /** Held by every outbox write but a new draft (replace, drop) and across a whole flush, so a draft is sent once. */
  readonly lockPath: string;

  constructor(readonly root: string) {
    const dir = join(root, "lead");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "outbox.jsonl");
    this.lockPath = join(dir, "outbox.lock");
  }

  append(e: OutboxEvent): void {
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, `${JSON.stringify(e)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  events(): OutboxEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as OutboxEvent];
        } catch {
          return []; // a torn last line from a crashed writer is skipped, never fatal
        }
      });
  }

  /** Open drafts in creation order. */
  open(): Draft[] {
    const byId = new Map<string, { draft: string; at: number; target: DraftTarget; text: string; editedAt: number; again: boolean; inFlight: boolean; done: boolean }>();
    for (const e of this.events()) {
      if (e.ev === "drafted") {
        byId.set(e.draft, { draft: e.draft, at: e.at, target: e.target, text: e.text, editedAt: e.at, again: e.again === true, inFlight: false, done: false });
        continue;
      }
      const d = byId.get(e.draft);
      if (!d) continue;
      switch (e.ev) {
        case "replaced":
          d.text = e.text;
          d.editedAt = e.at;
          if (e.again) d.again = true;
          break;
        case "sending":
          d.inFlight = true;
          break;
        case "failed":
          d.inFlight = false;
          break;
        case "dropped":
        case "released":
          d.done = true;
          break;
      }
    }
    return [...byId.values()]
      .filter((d) => !d.done)
      .map((d) => ({ draft: d.draft, at: d.at, target: d.target, text: d.text, editedAt: d.editedAt, again: d.again, inFlight: d.inFlight }));
  }

  /** Reply ids that have an open draft: the channel treats them as answered-to-be (IdState.drafted). */
  draftedIds(): Set<string> {
    return new Set(this.open().flatMap((d) => (d.target.kind === "reply" ? d.target.ids : [])));
  }

  lock(now: number): (() => void) | undefined {
    return lockFile(this.lockPath, now);
  }
}
