import { homedir } from "node:os";
import { join } from "node:path";
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

/** Trailing punctuation is a sentence's, not the path's: `(state path).` keeps its full stop. */
const maskPath = (mask: string) => (all: string): string => `${mask}${/[.,;:!?)\]}]+$/.exec(all)?.[0] ?? ""}`;

/**
 * How long one `hooks.threadReply` run may take before it is killed and counted as a failed post. The tick awaits it, so
 * a sender that never returns would otherwise hold up inbox flushing, nudges and the rest of the duty pass.
 */
const THREAD_REPLY_TIMEOUT_MS = 30_000;

/**
 * The text as it goes to a messenger. The owner needs the evidence a report cites, so only what is theirs or seori's is
 * taken out: the home directory becomes `~`, a path under the state root `(state path)`, and pane refs `<pane>`. Every
 * other absolute path (a test log, a clone) stays as the lane wrote it.
 *
 * The state root is masked whether or not a caller passes one: it holds secrets.json and messengers.json, so leaving it
 * to the home replacement alone would print `~/.seori/secrets.json` to the owner. The mask is the literal path under the
 * real root: a report spelling it as `~/.seori/...` or `$SEORI_HOME/...` is not a path the lane could have read from
 * disk, and is left as written.
 */
export function scrubForOwner(text: string, home: string = homedir(), stateRoot?: string): string {
  const h = home.replace(/\/+$/, "");
  // The state root first: it sits under the home directory, and replacing the home first would leave `~/.seori/...`.
  // Unset means the documented default (~/.seori): reading $SEORI_HOME here would make the masking depend on the caller's
  // environment, and progressTick always passes the store's real root.
  const r = (stateRoot ?? join(home, ".seori")).replace(/\/+$/, "");
  // Stop at whitespace or any quote, so a quoted path keeps its closing quote: `see "(state path)" here`.
  const stopAtQuote = r && r !== "/" ? new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])[^\\s'"\`]*`, "g") : undefined;
  const noState = stopAtQuote ? text.replace(stopAtQuote, maskPath("(state path)")) : text;
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

/** The first line of a failure reason, capped at 200 characters. */
const firstLine = (s: string): string => {
  const first = s.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
};

const detailOf = (e: unknown): string => firstLine(e instanceof Error ? e.message : String(e));

/** Which transport carries a post into the thread: dori's hook when it is set, else the configured messenger. */
type Transport = "hooks.threadReply" | "messenger";

/**
 * Duty: posts each due lane's newest report (see progressDue) into its thread and records it as `posted` with a
 * "posted" log entry. With `hooks.threadReply` set, that argv runs with `{thread}`, `{text}` and `{key}` filled (dori's
 * mechanism); without it the configured messenger sends the same text. An uncertain send may have reached the owner and
 * counts as posted (never sent twice); a definite failure records nothing, so the next tick tries again, and its event
 * names the transport that failed. A hook run past `timeoutMs` is killed and counts as a definite failure.
 */
export async function progressTick(d: Deps, timeoutMs = THREAD_REPLY_TIMEOUT_MS): Promise<DutyEvent[]> {
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
  const channel = new Channel(d.store.root);
  for (const { lane, report } of due) {
    const thread = lane.thread!;
    if (channel.fromNonOwner(thread)) {
      events.push({ lane: lane.key, action: "post-failed", detail: `thread ${thread} is a message from someone other than the owner; lane progress never posts there` });
      continue;
    }
    const text = progressText(report, d.store.root);
    let via: Transport;
    let uncertain: string | undefined;
    if (hook) {
      via = "hooks.threadReply";
      const [cmd, ...rest] = substitute(hook, { key: lane.key, text, thread });
      let proc: { kill(): void } | undefined;
      // The tick awaits this, so it races a deadline: the exec promise itself can outlive a kill (a wrapper's
      // grandchild keeps the pipes open), and a sender that never returns must not hold up the rest of the pass.
      const deadline = Promise.withResolvers<"timeout">();
      const timer = setTimeout(() => deadline.resolve("timeout"), timeoutMs);
      try {
        const res =
          cmd === undefined
            ? { code: 127, stdout: "", stderr: "empty argv" }
            : await Promise.race([d.exec(cmd, rest, { onSpawn: (p) => (proc = p) }), deadline.promise]);
        if (res === "timeout") {
          proc?.kill();
          events.push({ lane: lane.key, action: "post-failed", detail: `hooks.threadReply: timed out after ${timeoutMs / 1000} s` });
          continue;
        }
        // A hook that exits non-zero may have sent anyway, but nothing is recorded: the next tick tries the same report.
        if (res.code !== 0) {
          const why = firstLine(res.stderr || res.stdout) || `exit ${res.code}`;
          events.push({ lane: lane.key, action: "post-failed", detail: `hooks.threadReply: ${why}` });
          continue;
        }
      } catch (e) {
        events.push({ lane: lane.key, action: "post-failed", detail: `hooks.threadReply: ${detailOf(e)}` });
        continue;
      } finally {
        clearTimeout(timer);
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
      via = "messenger";
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
      text: uncertain === undefined ? `to ${thread} via ${via}` : `to ${thread} via ${via} (uncertain: ${uncertain})`,
    });
    d.store.saveLane(fresh);
    events.push({
      lane: lane.key,
      action: uncertain === undefined ? "posted" : "post-uncertain",
      detail: uncertain === undefined ? `via ${via}` : `via ${via} (uncertain: ${uncertain})`,
    });
  }
  return events;
}
