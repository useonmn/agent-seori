import { homedir } from "node:os";
import { Channel } from "./channel.ts";
import { loadConfig, type SeoriConfig } from "./config.ts";
import type { Deps, DutyEvent } from "./harness.ts";
import { loadMessengers, SendUncertain, type MessengerConfig, type SendTarget } from "./messenger/adapter.ts";
import type { Lane } from "./store.ts";

// Progress posts: a lane started with `--thread <lead channel id>` works on one owner message. Duty posts the lane's
// newest report as a threaded reply under that message, at most every config.progressEveryMin minutes and only when the
// report changed, so the owner sees the work move without asking.

/** hc terminal refs (`hc:t7`, `hc:t1b`): meaningless to the owner, and they say which terminal to type into. */
const PANE_ID_RE = /\bhc:t[0-9a-z]+\b/g;

/** The text as it goes to a messenger: the home directory shown as `~` and hc terminal refs replaced with `<pane>`. */
export function scrubForOwner(text: string, home: string = homedir()): string {
  const h = home.replace(/\/+$/, "");
  const noHome = h && h !== "/" ? text.split(h).join("~") : text;
  return noHome.replace(PANE_ID_RE, "<pane>");
}

/** The post for a report: `[<key>] <report text>`, scrubbed. */
export const progressText = (key: string, report: string, home?: string): string => scrubForOwner(`[${key}] ${report}`, home);

/**
 * Where a thread id (`<source>:<chat>:<message id>`) is answered: the lead channel row when it is there (it knows the
 * topic or thread the message came in), else the id itself split at its first two colons. Undefined: not that shape.
 */
export function threadTarget(root: string, thread: string): { source: string; target: SendTarget } | undefined {
  const row = new Channel(root).inbound().find((r) => r.id === thread && r.kind === "messenger");
  if (row && row.kind === "messenger") {
    const replyTo = thread.slice(row.source.length + row.chat.length + 2);
    return { source: row.source, target: { chat: row.chat, ...(row.thread !== undefined ? { thread: row.thread } : {}), ...(replyTo ? { replyTo } : {}) } };
  }
  const [source, chat, ...rest] = thread.split(":");
  const replyTo = rest.join(":");
  if (!source || !chat || !replyTo) return undefined;
  return { source, target: { chat, replyTo } };
}

/** The lane's newest report text, or undefined when it has not reported yet. */
export function newestReport(lane: Lane): string | undefined {
  for (let i = lane.log.length - 1; i >= 0; i--) {
    const entry = lane.log[i];
    if (entry?.kind === "report") return entry.text;
  }
  return undefined;
}

/** A working or waiting lane with a thread whose newest report is new and whose last post is progressEveryMin old. */
export function progressDue(lane: Lane, config: SeoriConfig, now: number): string | undefined {
  if (!lane.thread || (lane.status !== "working" && lane.status !== "waiting")) return undefined;
  const report = newestReport(lane);
  if (report === undefined || report === lane.posted?.text) return undefined;
  return now - (lane.posted?.at ?? lane.createdAt) >= config.progressEveryMin * 60_000 ? report : undefined;
}

const detailOf = (e: unknown): string => {
  const first = (e instanceof Error ? e.message : String(e)).trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
};

/**
 * Duty: posts each due lane's newest report (see progressDue) to its thread through the configured messenger and
 * records it as `posted` with a "posted" log entry. An uncertain send may have reached the owner and counts as posted
 * (never sent twice); a definite failure records nothing, so the next tick tries again.
 */
export async function progressTick(d: Deps): Promise<DutyEvent[]> {
  const now = d.now();
  let config: SeoriConfig;
  try {
    config = loadConfig(d.store.root);
  } catch (e) {
    return [{ action: "progress-failed", detail: detailOf(e) }];
  }
  const due = d.store.lanes().flatMap((lane) => {
    const report = progressDue(lane, config, now);
    return report === undefined ? [] : [{ lane, report }];
  });
  if (due.length === 0) return [];
  let messengers: MessengerConfig[];
  try {
    messengers = loadMessengers(d.store.root);
  } catch (e) {
    // duty's channel alerts tell the lead about a broken messengers.json; here each due lane just waits for a fix
    return due.map(({ lane }) => ({ lane: lane.key, action: "post-failed", detail: `messengers.json: ${detailOf(e)}` }));
  }
  const events: DutyEvent[] = [];
  for (const { lane, report } of due) {
    const thread = lane.thread!;
    const where = threadTarget(d.store.root, thread);
    if (!where) {
      events.push({ lane: lane.key, action: "post-failed", detail: `thread ${thread} is not <source>:<chat>:<message id>` });
      continue;
    }
    const config = messengers.find((m) => m.source === where.source);
    if (!config) {
      events.push({ lane: lane.key, action: "post-failed", detail: `no messenger configured for source ${where.source}` });
      continue;
    }
    let uncertain: string | undefined;
    try {
      await d.notify(config, where.target, progressText(lane.key, report));
    } catch (e) {
      if (!(e instanceof SendUncertain)) {
        events.push({ lane: lane.key, action: "post-failed", detail: detailOf(e) });
        continue;
      }
      uncertain = detailOf(e);
    }
    // Re-read: the lane may have reported (or closed) while the messenger call ran; only the post fields change here.
    const fresh = d.store.lane(lane.key) ?? lane;
    fresh.posted = { at: now, text: report };
    fresh.log.push({ at: now, kind: "posted", text: uncertain === undefined ? `to ${thread}` : `to ${thread} (uncertain: ${uncertain})` });
    d.store.saveLane(fresh);
    events.push({ lane: lane.key, action: uncertain === undefined ? "posted" : "post-uncertain", ...(uncertain !== undefined ? { detail: uncertain } : {}) });
  }
  return events;
}
