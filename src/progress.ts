import { homedir } from "node:os";
import { Channel } from "./channel.ts";
import { loadConfig, type SeoriConfig } from "./config.ts";
import type { Deps, DutyEvent } from "./harness.ts";
import { loadHooks, substitute, type ArgvTemplate } from "./hooks.ts";
import { loadMessengers, SendUncertain, type MessengerConfig, type SendTarget } from "./messenger/adapter.ts";
import type { Lane } from "./store.ts";

// Progress posts: a lane started with `--thread <lead channel id>` works on one owner message. Duty posts the lane's
// newest report as a threaded reply under that message, at most every config.progressEveryMin minutes and only when the
// report changed, so the owner sees the work move without asking. Off unless config.json sets progressEveryMin.

/** hc terminal refs (`hc:t7`, `hc:t1b`): meaningless to the owner, and they say which terminal to type into. */
const PANE_ID_RE = /\bhc:t[0-9a-z]+\b/g;

/** A string as a literal for a `RegExp`. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where seori keeps its state ($SEORI_HOME): secrets.json, messengers.json and every lane record live there, and none
 * of it belongs in a chat. One path under it becomes `(state path)`.
 */
const statePathRe = (root: string): RegExp => new RegExp(`${escapeRe(root)}(?![\\w.-])[^\\s'\`]*`, "g");

/** Trailing punctuation is a sentence's, not the path's: `(state path).` keeps its full stop. */
const maskPath = (mask: string) => (all: string): string => `${mask}${/[.,;:!?)\]}]+$/.exec(all)?.[0] ?? ""}`;

/**
 * The text as it goes to a messenger. The owner needs the evidence a report cites, so only what is theirs or seori's is
 * taken out: the home directory becomes `~`, a path under the state root `(state path)`, and pane refs `<pane>`. Every
 * other absolute path (a test log, a clone) stays as the lane wrote it.
 */
export function scrubForOwner(text: string, home: string = homedir(), stateRoot?: string): string {
  const h = home.replace(/\/+$/, "");
  // The state root first: under the home directory, replacing the home first would leave `~/.seori/...` readable.
  const r = stateRoot?.replace(/\/+$/, "");
  const noState = r && r !== "/" ? text.replace(statePathRe(r), maskPath("(state path)")) : text;
  const noHome = h && h !== "/" ? noState.split(h).join("~") : noState;
  return noHome.replace(PANE_ID_RE, "<pane>");
}

/**
 * The header every post carries, word for word dori's (`skills/dori-mode/scripts/src/freshness.ts`), so the owner reads
 * the same thing from either harness.
 */
export const PROGRESS_HEADER = "Progress (from the lane's last report): ";

/** The post for a report: the header and the scrubbed report text. */
export const progressText = (report: string, stateRoot?: string, home?: string): string =>
  `${PROGRESS_HEADER}${scrubForOwner(report, home, stateRoot)}`;


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

/**
 * A working or waiting lane with a thread whose newest report is new and whose last post is progressEveryMin old.
 * `progressEveryMin: null` (the default) means posting is off, so nothing is ever due.
 */
export function progressDue(lane: Lane, config: SeoriConfig, now: number): string | undefined {
  if (config.progressEveryMin === null) return undefined;
  if (!lane.thread || (lane.status !== "working" && lane.status !== "waiting")) return undefined;
  const report = newestReport(lane);
  if (report === undefined || report === lane.posted?.text) return undefined;
  return now - (lane.posted?.at ?? lane.createdAt) >= config.progressEveryMin * 60_000 ? report : undefined;
}

const detailOf = (e: unknown): string => {
  const first = (e instanceof Error ? e.message : String(e)).trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
};

/** Which transport carried a post into the thread: dori's hook when it is set, else the configured messenger. */
type Transport = { readonly via: "hooks.threadReply" } | { readonly via: "messenger"; readonly config: MessengerConfig };

/**
 * Duty: posts each due lane's newest report (see progressDue) into its thread and records it as `posted` with a
 * "posted" log entry. With `hooks.threadReply` set, that argv runs with `{thread}`, `{text}` and `{key}` filled (dori's
 * mechanism); without it the configured messenger sends the same text. An uncertain send may have reached the owner and
 * counts as posted (never sent twice); a definite failure records nothing, so the next tick tries again, and its event
 * names the transport that failed.
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
  let hook: ArgvTemplate | undefined;
  try {
    hook = loadHooks(d.store.root).threadReply;
  } catch (e) {
    return due.map(({ lane }) => ({ lane: lane.key, action: "post-failed", detail: `hooks: ${detailOf(e)}` }));
  }
  // A hook needs no messenger: the command it runs is the owner's own sender.
  let messengers: MessengerConfig[] = [];
  if (!hook) {
    try {
      messengers = loadMessengers(d.store.root);
    } catch (e) {
      // duty's channel alerts tell the lead about a broken messengers.json; here each due lane just waits for a fix
      return due.map(({ lane }) => ({ lane: lane.key, action: "post-failed", detail: `messenger: messengers.json: ${detailOf(e)}` }));
    }
  }
  const events: DutyEvent[] = [];
  for (const { lane, report } of due) {
    const thread = lane.thread!;
    const text = progressText(report, d.store.root);
    let transport: Transport;
    let uncertain: string | undefined;
    if (hook) {
      transport = { via: "hooks.threadReply" };
      const [cmd, ...rest] = substitute(hook, { key: lane.key, text, thread });
      try {
        const res = cmd === undefined ? { code: 127, stdout: "", stderr: "empty argv" } : await d.exec(cmd, rest);
        // A hook that exits non-zero may or may not have sent: record nothing, so the next tick tries again.
        if (res.code !== 0) {
          const why = (res.stderr || res.stdout).trim().split("\n")[0] || `exit ${res.code}`;
          events.push({ lane: lane.key, action: "post-failed", detail: `hooks.threadReply: ${why}` });
          continue;
        }
      } catch (e) {
        events.push({ lane: lane.key, action: "post-failed", detail: `hooks.threadReply: ${detailOf(e)}` });
        continue;
      }
    } else {
      const where = threadTarget(d.store.root, thread);
      if (!where) {
        events.push({ lane: lane.key, action: "post-failed", detail: `messenger: thread ${thread} is not <source>:<chat>:<message id>` });
        continue;
      }
      const found = messengers.find((m) => m.source === where.source);
      if (!found) {
        events.push({ lane: lane.key, action: "post-failed", detail: `messenger: no messenger configured for source ${where.source}` });
        continue;
      }
      transport = { via: "messenger", config: found };
      try {
        await d.notify(found, where.target, text);
      } catch (e) {
        if (!(e instanceof SendUncertain)) {
          events.push({ lane: lane.key, action: "post-failed", detail: `messenger: ${detailOf(e)}` });
          continue;
        }
        uncertain = detailOf(e);
      }
    }
    // Re-read: the lane may have reported (or closed) while the send ran; only the post fields change here.
    const fresh = d.store.lane(lane.key) ?? lane;
    fresh.posted = { at: now, text: report };
    fresh.log.push({
      at: now,
      kind: "posted",
      text: uncertain === undefined ? `to ${thread} via ${transport.via}` : `to ${thread} via ${transport.via} (uncertain: ${uncertain})`,
    });
    d.store.saveLane(fresh);
    events.push({
      lane: lane.key,
      action: uncertain === undefined ? "posted" : "post-uncertain",
      detail: uncertain === undefined ? `via ${transport.via}` : `via ${transport.via} (uncertain: ${uncertain})`,
    });
  }
  return events;
}
