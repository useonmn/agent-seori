// seori's lead channel, inside the lead's omp (loaded with `-e` into the lead only). It turns the lead channel
// ($SEORI_HOME/lead/, see src/channel.ts) into custom messages in the lead's conversation and records every delivery
// in the ledger. The ledger is the only persistent state: a restarted omp, or a /new, /resume or /fork, carries every
// open id over (src/lead-delivery.ts decides when and how).
//
// Env (passed by `seori up` through `herdr agent start --env`): SEORI_HOME (the extension is inert without it) and
// SEORI_CMD (how the lead runs seori, quoted into the message; default `seori`).
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { Channel } from "../src/channel.ts";
import { DeliverySchedule, renderDelivery, type Trigger } from "../src/lead-delivery.ts";

const CUSTOM_TYPE = "seori-inbound";
/** New rows arriving together (a burst of messenger messages) become one delivery. */
const COALESCE_MS = 400;
/** fs.watch can miss events (network filesystems, editors replacing the file); the timer also drives retries. */
const TICK_MS = 1000;
/** How often the consumer lock is checked: still ours, or free again after the other consumer exited. */
const LOCK_CHECK_MS = 5000;

const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const prop = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;

export default function leadChannel(pi: ExtensionAPI) {
  const home = process.env["SEORI_HOME"];
  if (!home) return;
  const cmd = process.env["SEORI_CMD"] || "seori";
  const channel = new Channel(home);
  const schedule = new DeliverySchedule();

  // omp rebinds this factory to every subagent session; only the top-level session (the lead) may consume, or every
  // live subagent would get the owner's messages too (review-C F1). Decided at session_start, where ctx.agent exists.
  let active = false;
  let ctx: ExtensionContext | undefined;
  let release: (() => void) | undefined;
  let lockBody: string | undefined;
  let lockCheckedAt = 0;
  let toldHeld = false;
  let watcher: FSWatcher | undefined;
  let ticker: Timer | undefined;
  let pending: Timer | undefined;

  const say = (message: string, type: "info" | "warning") => {
    if (ctx?.hasUI) ctx.ui.notify(message, type);
    else pi.logger.warn(message);
  };

  /** One consumer per home, so two omps on the same home never both deliver (review-C F7). */
  const holdLock = (now: number): boolean => {
    if (release && now - lockCheckedAt < LOCK_CHECK_MS) return true;
    lockCheckedAt = now;
    if (release) {
      if (readOrUndefined(channel.consumerLockPath) === lockBody) return true;
      release = undefined; // removed by hand, or taken over as stale: take it again below or go quiet
    }
    release = channel.lockConsumer(now);
    if (release) {
      lockBody = readOrUndefined(channel.consumerLockPath);
      if (toldHeld) say("seori lead channel: consumer lock acquired; delivering messenger messages here.", "info");
      toldHeld = false;
      return true;
    }
    if (!toldHeld) {
      say(`seori lead channel: another omp holds ${channel.consumerLockPath}; this session will not deliver messenger messages.`, "warning");
      toldHeld = true;
    }
    return false;
  };

  const evaluate = (trigger: Trigger) => {
    if (!active || !ctx) return;
    const now = Date.now();
    if (!holdLock(now)) return;
    const decision = schedule.decide(channel.states(), now, ctx.isIdle(), trigger);
    for (const g of decision.giveUp) channel.appendLedger({ id: g.id, ev: "gave-up", at: now, attempts: g.attempts });
    if (!decision.deliver.length) return;
    const ids = decision.deliver.map((d) => d.row.id);
    pi.sendMessage(
      { customType: CUSTOM_TYPE, content: renderDelivery(decision.deliver, cmd), display: true, details: { ids } },
      // An idle aside after an Esc, or in plan mode, is folded in without a turn; followUp + triggerTurn starts one.
      decision.mode === "followUp" ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "aside" },
    );
    schedule.noteDelivered(ids, now);
    const session = ctx.sessionManager.getSessionId();
    for (const d of decision.deliver) channel.appendLedger({ id: d.row.id, ev: "delivered", at: now, attempt: d.attempt, mode: decision.mode, session });
  };

  const scanSoon = () => {
    if (!ctx || pending) return;
    pending = ctx.setTimeout(() => {
      pending = undefined;
      evaluate({ kind: "scan" });
    }, COALESCE_MS);
  };

  const arm = (c: ExtensionContext, trigger: Trigger) => {
    ctx = c;
    active = c.agent.kind === "main";
    if (!active) return;
    try {
      watcher ??= watch(channel.dir, (_event, file) => {
        if (file === null || file === basename(channel.inboundPath)) scanSoon();
      });
    } catch (e) {
      pi.logger.warn(`seori lead channel: fs.watch failed, polling only: ${e}`);
    }
    // A pending coalesce owns new rows, so a tick between two rows of one burst does not split it.
    ticker ??= c.setInterval(() => {
      if (!pending) evaluate({ kind: "timer" });
    }, TICK_MS);
    evaluate(trigger);
  };

  pi.on("session_start", (_e, c) => arm(c, { kind: "session_start" }));
  pi.on("session_switch", (_e, c) => arm(c, { kind: "session_switch" }));

  pi.on("message_end", (e, c) => {
    if (!active) return;
    // Read through `prop`: the message union is omp's, and only these fields matter here.
    if (prop(e.message, "role") !== "custom" || prop(e.message, "customType") !== CUSTOM_TYPE) return;
    const raw = prop(prop(e.message, "details"), "ids");
    if (!Array.isArray(raw)) return;
    const ids = raw.filter((id): id is string => typeof id === "string");
    schedule.noteEntered(ids);
    const at = Date.now();
    const session = c.sessionManager.getSessionId();
    for (const id of ids) channel.appendLedger({ id, ev: "entered", at, session });
  });

  pi.on("agent_end", (e, c) => {
    if (!active || e.willContinue) return; // a scheduled continuation is not the end of the turn
    ctx = c;
    const last = e.messages.findLast((m) => prop(m, "role") === "assistant");
    const stopReason = prop(last, "stopReason");
    evaluate({ kind: "agent_end", stopReason: typeof stopReason === "string" ? stopReason : "none" });
  });

  pi.on("session_shutdown", (_e, c) => {
    active = false;
    watcher?.close();
    watcher = undefined;
    if (ticker) c.clearTimer(ticker);
    ticker = undefined;
    if (pending) c.clearTimer(pending);
    pending = undefined;
    release?.();
    release = undefined;
  });
}
