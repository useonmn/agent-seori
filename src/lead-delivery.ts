import { type IdState, type InboundRow, MAX_DELIVERIES } from "./channel.ts";

// When extensions/lead-channel.ts hands a lead-channel id to omp, and how. Pure: no clock, no files, no omp, so the
// rules the reviews of the monitor-vs-loop prototypes asked for are unit-tested here
// (research/prototypes/monitor-vs-loop/results/review-A.md, review-C.md):
// - omp drops queued messages on /new, /resume and /fork, and a killed omp may never have shown one, so every
//   session start or switch carries the open ids over;
// - after an Esc, an idle `aside` is folded into the transcript without a turn, while an idle `followUp` with
//   triggerTurn starts one, so an idle lead always gets `followUp` and only a busy lead gets `aside`;
// - an aborted or failed turn, or a delivery that never showed up, gets redelivered after a short grace;
// - nobody may be told twice what they already answered: replied, closed, send-uncertain and gave-up ids are final.

/** How long a delivery may stay unseen, or an aborted turn may sit, before the id is delivered again. */
export const GRACE_MS = 10_000;

/** Wait before redelivering an unanswered id to an idle lead, by deliveries so far (index 0: after the 1st). */
export const BACKOFF_MS: readonly number[] = [2 * 60_000, 5 * 60_000];

export type Trigger =
  | { readonly kind: "scan" }
  | { readonly kind: "timer" }
  | { readonly kind: "session_start" }
  | { readonly kind: "session_switch" }
  | { readonly kind: "agent_end"; readonly stopReason: string };

/** new: first delivery. carried: the session changed since it was delivered. retry: delivered but not answered. */
export type Header = "new" | "carried" | "retry";

export type Mode = "followUp" | "aside";

export type Decision = {
  /** Delivered together in one message, oldest first. */
  readonly deliver: readonly { readonly row: InboundRow; readonly header: Header; readonly attempt: number }[];
  readonly mode: Mode;
  /** Ids that reached MAX_DELIVERIES and would be due again: record `gave-up` and stop. */
  readonly giveUp: readonly { readonly id: string; readonly attempts: number }[];
};

/**
 * What one lead session remembers between decisions, on top of the ledger: which ids this session delivered (and
 * whether omp showed them), and how its last turn ended. Memory only on purpose: a new process or session starts
 * empty and carries every open id over, so the ledger stays the only persistent state.
 */
export class DeliverySchedule {
  private readonly mine = new Map<string, { at: number; entered: boolean }>();
  private lastEnd: { at: number; stopReason: string } | undefined;

  noteDelivered(ids: readonly string[], now: number): void {
    for (const id of ids) this.mine.set(id, { at: now, entered: false });
  }

  noteEntered(ids: readonly string[]): void {
    for (const id of ids) {
      const m = this.mine.get(id);
      if (m) m.entered = true;
    }
  }

  /** Records the trigger's effect on this session's memory, then decides. Call noteDelivered for what you deliver. */
  decide(states: readonly IdState[], now: number, idle: boolean, trigger: Trigger): Decision {
    if (trigger.kind === "session_switch") {
      this.mine.clear();
      this.lastEnd = undefined;
    }
    if (trigger.kind === "agent_end") this.lastEnd = { at: now, stopReason: trigger.stopReason };
    const carry = trigger.kind === "session_start" || trigger.kind === "session_switch";
    const deliver: { row: InboundRow; header: Header; attempt: number }[] = [];
    const giveUp: { id: string; attempts: number }[] = [];
    for (const s of states) {
      if (s.replied || s.closed || s.uncertain || s.gaveUp) continue;
      if (s.deliveries === 0) {
        deliver.push({ row: s.row, header: "new", attempt: 1 });
        continue;
      }
      const header = carry ? "carried" : this.retryDue(s, now, idle, trigger) ? "retry" : undefined;
      if (!header) continue;
      // The cap is checked only when a redelivery is due, so the last delivery still gets its full chance to be answered.
      if (s.deliveries >= MAX_DELIVERIES) giveUp.push({ id: s.row.id, attempts: s.deliveries });
      else deliver.push({ row: s.row, header, attempt: s.deliveries + 1 });
    }
    return { deliver, mode: idle ? "followUp" : "aside", giveUp };
  }

  /**
   * Only an idle lead gets retries: a busy lead may still reach a pending aside at its next step boundary, and a
   * second copy would arrive next to the first.
   */
  private retryDue(s: IdState, now: number, idle: boolean, trigger: Trigger): boolean {
    if (!idle) return false;
    const mine = this.mine.get(s.row.id);
    if (mine) {
      // An idle omp has drained what it was going to show; a delivery still unseen was dropped.
      if (!mine.entered && now - mine.at >= GRACE_MS) return true;
      // Esc, an error or a length stop ended the turn the message was in; it may never have been answered.
      const end = this.lastEnd;
      if (end && end.stopReason !== "stop" && end.at >= mine.at && now - end.at >= GRACE_MS) return true;
    }
    // After the last delivery the longest backoff applies before it counts as given up.
    const wait = BACKOFF_MS[Math.min(s.deliveries, BACKOFF_MS.length) - 1]!;
    return trigger.kind === "timer" && s.lastDeliveredAt !== undefined && now - s.lastDeliveredAt >= wait;
  }
}

const HEADERS: Record<Header, string> = {
  new: "New messenger messages:",
  carried: "Carried over from an earlier session or delivery; reply only if you have not already:",
  retry: "Delivered before and still unanswered (no reply or close recorded):",
};

/** The one custom message the lead sees for a decision: how to answer, then each message grouped by header. */
export function renderDelivery(deliver: Decision["deliver"], cmd: string): string {
  const lines = [
    "seori lead channel: messages from your owner's messenger. Answer each one exactly once:",
    `  ${cmd} msg send --reply-to <id> --text '...'`,
    `  or, when no reply is needed: ${cmd} msg close <id> --why '...'`,
  ];
  for (const header of ["new", "carried", "retry"] as const) {
    const group = deliver.filter((d) => d.header === header);
    if (!group.length) continue;
    lines.push("", HEADERS[header]);
    for (const { row } of group) lines.push(`[${row.id}] ${row.source} from ${row.from}: ${row.text}`);
  }
  lines.push("", "Answer these, then continue your current task.");
  return lines.join("\n");
}
