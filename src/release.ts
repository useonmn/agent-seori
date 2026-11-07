// When extensions/lead-channel.ts flushes the lead's reply drafts (src/outbox.ts). The lead's omp runs omp's advisor
// with an agent-end review, and `seori up` sets advisor.syncBacklog: strict for the lead, so the review finishes before
// the run's agent_end. A review with a concern or worse steers a continuation: omp sends a custom message of type
// "advisor" (deliverAs steer, triggerTurn), and the lead may then fix a draft. So:
// - an agent_end that ends the turn schedules a flush RELEASE_GRACE_MS later, of the drafts last written at or before
//   that agent_end. A turn ends when nothing continues it, or when only background work (an async job, a subagent)
//   may resume it (`awaitingAsyncWork`): its review has already run;
// - an advisor message within that grace cancels it; the continuation's own agent_end schedules the next one;
// - any other new run does not cancel: the lead channel itself starts one right after agent_end for the next owner
//   message (followUp + triggerTurn), and lane prompts, duty and watch events start runs too, so cancelling on every
//   agent_start would leave drafts stuck under steady traffic. A draft that next run writes or changes is past the
//   cutoff, so it waits for that run's own end and review;
// - only drafts drafted since this extension first armed are taken: older ones were left by an earlier lead (maybe a
//   turn that crashed half-done, before its review), so duty's [DRAFTS] alert leaves them to the lead;
// - only the consumer-lock holder schedules: a second omp on the same home must not flush the real lead's drafts;
// - a session switch or shutdown cancels (the drafts stay open; duty tells the lead about old ones).
// Pure apart from the injected clock, timer and flush, so the rules are unit-tested.

/** Long enough for an advisor steer that lands just after agent_end; short, as the owner waits for the reply. */
export const RELEASE_GRACE_MS = 3000;

/** Runs `fn` after `ms`; the returned function cancels it. */
export type ScheduleTimer = (fn: () => void, ms: number) => () => void;

const prop = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;

/** omp's advisor steer: a custom message of type "advisor" (session-advisors.ts sendCustomMessage). */
export function isAdvisorMessage(message: unknown): boolean {
  return prop(message, "role") === "custom" && prop(message, "customType") === "advisor";
}

export class ReleaseScheduler {
  private cancelTimer: (() => void) | undefined;
  private running: Promise<void> | undefined;
  /** The cutoff of a turn end that fired while a flush was running: one more flush follows it. */
  private queued: number | undefined;
  /** When the extension first armed; nothing is flushed before. */
  private since: number | undefined;

  constructor(
    private readonly timer: ScheduleTimer,
    private readonly now: () => number,
    /**
     * Sends the open drafts drafted at or after `since` and last written at or before `until` (src/msg.ts FlushWindow);
     * its failures go to onError, never to the caller.
     */
    private readonly flush: (window: { readonly since: number; readonly until: number }) => Promise<void>,
    private readonly onError: (e: unknown) => void,
    private readonly graceMs: number = RELEASE_GRACE_MS,
  ) {}

  /** A flush is waiting out the grace. */
  get pending(): boolean {
    return this.cancelTimer !== undefined;
  }

  /** The extension armed in the lead session (session_start): drafts from then on are its own. */
  armed(): void {
    this.since ??= this.now();
  }

  /**
   * omp's agent_end. A scheduled continuation is not the end of the turn; a wait for background work is.
   * `consumer`: this omp holds the lead channel's consumer lock.
   */
  agentEnd(e: { readonly willContinue?: boolean; readonly awaitingAsyncWork?: boolean }, consumer: boolean): void {
    if (!consumer || this.since === undefined) return;
    if (e.willContinue === true && e.awaitingAsyncWork !== true) return;
    this.cancel();
    const until = this.now();
    this.cancelTimer = this.timer(() => {
      this.cancelTimer = undefined;
      void this.run(until);
    }, this.graceMs);
  }

  /** omp's agent_start: deliberately no effect (see the header). */
  agentStart(): void {}

  /** omp's message_start / message_end: an advisor steer holds the drafts for the continuation it starts. */
  message(message: unknown): void {
    if (isAdvisorMessage(message)) this.cancel();
  }

  /** A session switch or shutdown. */
  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** Resolves once no flush is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** One flush at a time; a turn end during a flush runs one more after it, for drafts it did not take. */
  private async run(until: number): Promise<void> {
    if (this.running) {
      this.queued = Math.max(this.queued ?? until, until);
      return;
    }
    this.running = (async () => {
      for (let next: number | undefined = until; next !== undefined; ) {
        this.queued = undefined;
        try {
          await this.flush({ since: this.since ?? Infinity, until: next });
        } catch (e) {
          this.onError(e);
        }
        next = this.queued;
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
}
