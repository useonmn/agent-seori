// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { randomBytes } from "node:crypto";
import { Channel, type IdState, type MessengerRow } from "./channel.ts";
import { replyTarget } from "./messenger/common.ts";
import { Refusal } from "./harness.ts";
import {
  type ActionNotes, loadMessengers, type MessengerAdapter, type MessengerConfig, type SendTarget, SendUncertain, type ThreadChange, type ThreadResult,
  type ThreadTarget,
} from "./messenger/adapter.ts";
import { adapterFor as defaultAdapterFor } from "./messenger/index.ts";
import { SlackAdapter } from "./messenger/slack.ts";
import { type Draft, type DraftTarget, Outbox, targetLabel } from "./outbox.ts";

// `seori msg ...`: the lead answers messenger messages. A reply closes its ids only after the messenger returned a
// message id, so an id is never marked answered on a failed send; an uncertain send is recorded and refused afterwards
// until a human checks the chat and passes --again, so the lead never double-replies on its own. A `sending` event goes
// to the ledger before the messenger is called, so a reply killed mid-send (Esc, timeout, SIGTERM) is uncertain too, and
// the reply lock keeps two concurrent sends from both passing the check.
//
// While the lead extension is consuming, a send is checked exactly as above and then kept as a draft in the outbox
// (src/outbox.ts) instead of going out: the extension flushes the drafts once the lead's turn, and the advisor review at
// its end, are over, so a concern can still change a draft before the owner sees it. --now, or no live consumer (a
// human at a shell, the lead offline), sends at once as before.

export type MsgDeps = {
  readonly adapterFor: (c: MessengerConfig) => MessengerAdapter;
  readonly configs: readonly MessengerConfig[];
  readonly now: () => number;
};

/** What the CLI and the lead extension send with: the messengers in messengers.json, read now. */
export function msgDepsFor(root: string, now: () => number = Date.now): MsgDeps {
  return { adapterFor: (c) => defaultAdapterFor(c, root), configs: loadMessengers(root), now };
}

export type NoticeTarget = { readonly source: string; readonly chat: string; readonly thread?: string };

export type MsgSendOptions = {
  readonly replyTo?: readonly string[];
  readonly to?: NoticeTarget;
  /** Replace the text of this open draft (a reply or a notice). */
  readonly replace?: string;
  readonly text: string;
  readonly again?: boolean;
  /** Slack user-token mode: allow --to a conversation seori has no record of (--allow-unknown-chat). */
  readonly allowUnknownChat?: boolean;
  /** Send at once even while the lead extension is consuming (--now). */
  readonly sendNow?: boolean;
};

/**
 * SENT / HELD: sent now (HELD: the messenger may or may not have it; the CLI exits 3 like seori's other HELD results).
 * DRAFTED / REPLACED: kept in the outbox as `draft` until the lead's turn ends.
 */
export type MsgSendResult = {
  readonly status: "SENT" | "HELD" | "DRAFTED" | "REPLACED";
  readonly messageId?: string;
  readonly ids: readonly string[];
  readonly draft?: string;
};

/** `source:chat[:thread]`. Chat and thread may not be empty; a thread may itself contain colons. */
export function parseTo(spec: string): NoticeTarget {
  const [source, chat, ...rest] = spec.split(":");
  const thread = rest.join(":");
  if (!source || !chat || (rest.length > 0 && !thread)) throw new Refusal(`--to must be source:chat[:thread], got "${spec}"`);
  // Telegram sends Number(thread) as message_thread_id: NaN goes out as null and the message lands in the General topic.
  if (source === "telegram" && thread && !(/^[1-9]\d*$/.test(thread) && Number.isSafeInteger(Number(thread)))) {
    throw new Refusal(`--to ${spec}: the thread must be a Telegram topic id, a whole number above 0`);
  }
  return { source, chat, ...(thread ? { thread } : {}) };
}

function adapterFor(d: MsgDeps, source: string): MessengerAdapter {
  const config = d.configs.find((c) => c.source === source);
  if (!config) throw new Refusal(`no messenger "${source}" in messengers.json`);
  return d.adapterFor(config);
}

/**
 * Slack user-token mode posts as a real workspace member, so `--to` is fenced to conversations seori already knows: a chat
 * with a message in the lead channel (the owner's DM, the threads and channels it was written in). Anything else needs
 * --allow-unknown-chat. Bot mode and the other messengers are unchanged.
 */
function fenceUserTo(root: string, adapter: MessengerAdapter, to: NoticeTarget, allow: boolean | undefined): void {
  if (allow || !(adapter instanceof SlackAdapter) || !adapter.userMode) return;
  if (new Channel(root).inbound().some((r) => r.kind === "messenger" && r.source === to.source && r.chat === to.chat)) return;
  throw new Refusal(
    `${to.source}:${to.chat} is not a conversation seori knows (the owner's DM or a chat it was written in), and this Slack entry posts as a user account; ` +
      "pass --allow-unknown-chat if you mean to post there",
  );
}

export async function msgSend(root: string, o: MsgSendOptions, d: MsgDeps): Promise<MsgSendResult> {
  if ([o.replyTo, o.to, o.replace].filter((x) => x !== undefined).length !== 1) throw new Refusal("give exactly one of --reply-to, --to or --replace");
  if (!o.text.trim()) throw new Refusal("refusing to send an empty message");
  if (o.replace !== undefined) {
    if (o.sendNow) throw new Refusal("--replace changes a draft and --now sends at once; to send the drafts now, run seori msg flush");
    return replaceDraft(root, o.replace, o.text, o.again === true, d.now());
  }
  const draft = !o.sendNow && !new Channel(root).consumerOffline();

  if (o.to) {
    // A notice is not an answer to anything, so it neither needs nor touches the ledger.
    const adapter = adapterFor(d, o.to.source);
    fenceUserTo(root, adapter, o.to, o.allowUnknownChat);
    if (!draft) return sendNotice(adapter, o.to, o.text);
    // A new notice draft overlaps nothing, so it is appended without the outbox lock.
    const outbox = new Outbox(root);
    const id = newDraftId(outbox);
    outbox.append({ ev: "drafted", draft: id, at: d.now(), target: { kind: "notice", ...o.to }, text: o.text });
    return { status: "DRAFTED", ids: [], draft: id };
  }

  const ids = [...new Set(o.replyTo)];
  if (!ids.length) throw new Refusal("--reply-to needs at least one id");
  if (draft) return draftReply(root, ids, o, d);
  // A reply sent now next to an open draft for the same id would be followed by the draft: a second reply.
  const set = new Set(ids);
  const pending = new Outbox(root).open().find((x) => x.target.kind === "reply" && x.target.ids.some((id) => set.has(id)));
  if (pending) {
    throw new Refusal(
      `${targetLabel(pending.target)} has draft ${pending.draft} waiting to go out; change it with --replace ${pending.draft}, ` +
        `send it now with seori msg flush, or drop it with seori msg drop ${pending.draft} --why '...'`,
    );
  }
  return replyNow(new Channel(root), ids, o, d);
}

/** An uncertain notice is HELD like a reply (exit 3): it may have arrived, so the caller checks the chat instead of sending it twice. */
async function sendNotice(adapter: MessengerAdapter, to: NoticeTarget, text: string): Promise<MsgSendResult> {
  try {
    const { messageId } = await adapter.send({ chat: to.chat, ...(to.thread ? { thread: to.thread } : {}) }, text);
    return { status: "SENT", messageId, ids: [] };
  } catch (e) {
    if (e instanceof SendUncertain) return { status: "HELD", ids: [] };
    throw e;
  }
}

async function replyNow(channel: Channel, ids: readonly string[], o: { readonly text: string; readonly again?: boolean }, d: MsgDeps): Promise<MsgSendResult> {
  const release = channel.lockReply(d.now());
  if (!release) throw new Refusal(`BUSY: another seori msg send is replying right now (${channel.replyLockPath}); nothing was sent, retry shortly`);
  try {
    return await replyLocked(channel, ids, o, d);
  } finally {
    release();
  }
}

/** The refusals every reply gets, sent now or drafted: unknown ids, watch events, mixed chats, ALREADY_REPLIED, UNCERTAIN. */
function checkReply(channel: Channel, ids: readonly string[], again: boolean): IdState & { readonly row: MessengerRow } {
  const states = channel.states();
  const picked = ids.map((id) => {
    const s = states.find((x) => x.row.id === id);
    if (!s) throw new Refusal(`unknown message id ${id}`);
    if (s.row.kind === "watch") throw new Refusal(`${id} is a watch event: watch events need no reply (msg close closes one)`);
    return { ...s, row: s.row };
  });
  const first = picked[0]!;
  const other = picked.find((s) => s.row.source !== first.row.source || s.row.chat !== first.row.chat);
  if (other) throw new Refusal(`${first.row.id} and ${other.row.id} are in different chats; one reply goes to one chat`);

  if (!again) {
    const ledger = channel.ledger();
    for (const s of picked) {
      if (s.replied) {
        const earlier = ledger.find((e) => e.id === s.row.id && e.ev === "replied");
        const messageId = earlier?.ev === "replied" ? earlier.messageId : "?";
        throw new Refusal(`ALREADY_REPLIED ${s.row.id} (message ${messageId}); pass --again to send another reply`);
      }
      if (s.uncertain)
        throw new Refusal(`UNCERTAIN ${s.row.id}: an earlier reply may or may not have arrived; check the chat, then pass --again to resend`);
    }
  }
  return first;
}

/** The reply under the reply lock: states are read only once it is held, so a concurrent reply is already recorded. */
async function replyLocked(channel: Channel, ids: readonly string[], o: { readonly text: string; readonly again?: boolean }, d: MsgDeps): Promise<MsgSendResult> {
  const first = checkReply(channel, ids, o.again === true);
  // The upstream message id part of `<source>:<chat>:<message id>`; chat ids may contain colons, so slice by known parts.
  const replyTo = first.row.id.slice(first.row.source.length + first.row.chat.length + 2);
  const target: SendTarget = { chat: first.row.chat, ...(first.row.thread ? { thread: first.row.thread } : {}), replyTo };
  const adapter = adapterFor(d, first.row.source);
  const startedAt = d.now();
  for (const id of ids) channel.appendLedger({ id, ev: "sending", at: startedAt });
  try {
    const { messageId } = await adapter.send(target, o.text);
    const at = d.now();
    for (const id of ids) channel.appendLedger({ id, ev: "replied", at, messageId });
    return { status: "SENT", messageId, ids };
  } catch (e) {
    const at = d.now();
    if (!(e instanceof SendUncertain)) {
      // Definite failure: nothing reached the chat, so the ids stay open and the lead may simply try again.
      const detail = e instanceof Error ? e.message : String(e);
      for (const id of ids) channel.appendLedger({ id, ev: "send-failed", at, detail });
      throw e;
    }
    for (const id of ids) channel.appendLedger({ id, ev: "send-uncertain", at, detail: e.message });
    return { status: "HELD", ids };
  }
}

// ---------- drafts ----------

function newDraftId(outbox: Outbox): string {
  const taken = new Set(outbox.events().map((e) => e.draft));
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!taken.has(id)) return id;
  }
}

const lockOutbox = (outbox: Outbox, now: number, what: string): (() => void) => {
  const release = outbox.lock(now);
  if (!release) throw new Refusal(`BUSY: a seori msg flush is sending drafts right now (${outbox.lockPath}); ${what}, retry shortly`);
  return release;
};

/**
 * A reply draft: checked like a reply sent now, then recorded. A send to exactly the ids of an open draft replaces its
 * text, so the lead fixes a draft by sending again; any other overlap is refused, as one id gets one reply.
 */
function draftReply(root: string, ids: readonly string[], o: MsgSendOptions, d: MsgDeps): MsgSendResult {
  const outbox = new Outbox(root);
  const now = d.now();
  const release = lockOutbox(outbox, now, "nothing was drafted");
  try {
    const first = checkReply(new Channel(root), ids, o.again === true);
    adapterFor(d, first.row.source);
    const set = new Set(ids);
    const overlapping = outbox.open().filter((x) => x.target.kind === "reply" && x.target.ids.some((id) => set.has(id)));
    const only = overlapping[0];
    const t = only?.target;
    // Both id lists are free of duplicates, so equal length and every id shared means the same ids.
    if (only && overlapping.length === 1 && t?.kind === "reply" && t.ids.length === ids.length && t.ids.every((id) => set.has(id))) {
      outbox.append({ ev: "replaced", draft: only.draft, at: now, text: o.text, ...(o.again ? { again: true as const } : {}) });
      return { status: "REPLACED", ids, draft: only.draft };
    }
    if (only) {
      const label = targetLabel(only.target);
      throw new Refusal(
        `draft ${only.draft} already replies to ${label}; to change it, send again with exactly --reply-to ${label} or use --replace ${only.draft}`,
      );
    }
    const id = newDraftId(outbox);
    outbox.append({ ev: "drafted", draft: id, at: now, target: { kind: "reply", ids }, text: o.text, ...(o.again ? { again: true as const } : {}) });
    return { status: "DRAFTED", ids, draft: id };
  } finally {
    release();
  }
}

function replaceDraft(root: string, draft: string, text: string, again: boolean, now: number): MsgSendResult {
  const outbox = new Outbox(root);
  const release = lockOutbox(outbox, now, "nothing was replaced");
  try {
    const x = outbox.open().find((o) => o.draft === draft);
    if (!x) throw new Refusal(`no open draft ${draft} (seori msg drafts lists them)`);
    if (x.inFlight) throw new Refusal(`draft ${draft} may already be in the chat: a flush was stopped while sending it; run seori msg flush`);
    outbox.append({ ev: "replaced", draft, at: now, text, ...(again ? { again: true as const } : {}) });
    return { status: "REPLACED", ids: x.target.kind === "reply" ? x.target.ids : [], draft };
  } finally {
    release();
  }
}

/** `seori msg drop`: the draft is never sent; its reply ids are open again. */
export function msgDrop(root: string, draft: string, why: string, now: number): void {
  const outbox = new Outbox(root);
  const release = lockOutbox(outbox, now, "nothing was dropped");
  try {
    if (!outbox.open().some((o) => o.draft === draft)) throw new Refusal(`no open draft ${draft} (seori msg drafts lists them)`);
    outbox.append({ ev: "dropped", draft, at: now, why });
  } finally {
    release();
  }
}

/** One line per open draft, oldest first: draft, age, kind and target, the first 60 characters of the text JSON-escaped. */
export function msgDrafts(root: string, now: number): string[] {
  return new Outbox(root).open().map((x) => `${x.draft}  ${age(now - x.at)}  ${x.target.kind} ${targetLabel(x.target)}  ${JSON.stringify(x.text.slice(0, 60))}`);
}

export type FlushOutcome = {
  readonly draft: string;
  readonly target: DraftTarget;
  readonly status: "SENT" | "HELD" | "FAILED";
  readonly messageId?: string;
  readonly detail?: string;
};

/**
 * `seori msg flush`, and the lead extension at the end of a turn: sends every open draft, oldest first, through the
 * same path as a send now. Sent or uncertain: released (an uncertain reply is send-uncertain in the ledger, as
 * always). A definite failure, a refusal included: the draft stays open and is reported. The outbox lock is held
 * throughout, so two flushes never send one draft twice; a `sending` mark before each send keeps a flush killed
 * mid-send from sending it again next time.
 */
/**
 * Which open drafts a flush takes; the CLI's flush takes all. The lead extension's turn-end flush takes the drafts
 * drafted at or after `since` (when it started, so a crashed earlier lead's leftovers go to duty's [DRAFTS] alert
 * instead) and last written at or before `until` (that turn's end, so a draft the next run wrote or changed waits for
 * that run's own end and its review).
 */
export type FlushWindow = { readonly since?: number; readonly until?: number };

/** The open drafts a flush with `window` would send. */
export function draftsIn(root: string, window: FlushWindow = {}): Draft[] {
  return new Outbox(root).open().filter((x) => x.at >= (window.since ?? -Infinity) && x.editedAt <= (window.until ?? Infinity));
}

export async function msgFlush(root: string, d: MsgDeps, window: FlushWindow = {}): Promise<FlushOutcome[]> {
  const outbox = new Outbox(root);
  const channel = new Channel(root);
  const release = outbox.lock(d.now());
  if (!release) throw new Refusal(`BUSY: another seori msg flush is sending drafts right now (${outbox.lockPath}); retry shortly`);
  const outcomes: FlushOutcome[] = [];
  try {
    for (const x of draftsIn(root, window)) {
      if (x.inFlight) {
        // An earlier flush was stopped mid-send: it may be in the chat, so it is released as uncertain, never resent.
        const detail = "an earlier flush was stopped while sending it";
        if (x.target.kind === "reply") {
          const states = channel.states();
          for (const id of x.target.ids) {
            if (!states.find((s) => s.row.id === id)?.replied) channel.appendLedger({ id, ev: "send-uncertain", at: d.now(), detail });
          }
        }
        outbox.append({ ev: "released", draft: x.draft, at: d.now() });
        outcomes.push({ draft: x.draft, target: x.target, status: "HELD", detail });
        continue;
      }
      outbox.append({ ev: "sending", draft: x.draft, at: d.now() });
      try {
        const t = x.target;
        const r = t.kind === "notice"
          ? await sendNotice(adapterFor(d, t.source), t, x.text)
          : await replyNow(channel, t.ids, { text: x.text, again: x.again }, d);
        outbox.append({ ev: "released", draft: x.draft, at: d.now() });
        outcomes.push({ draft: x.draft, target: t, status: r.status === "SENT" ? "SENT" : "HELD", ...(r.messageId !== undefined ? { messageId: r.messageId } : {}) });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        outbox.append({ ev: "failed", draft: x.draft, at: d.now(), detail });
        outcomes.push({ draft: x.draft, target: x.target, status: "FAILED", detail });
      }
    }
  } finally {
    release();
  }
  return outcomes;
}

/** The line `seori msg flush` prints for one draft (the lead extension logs the same). */
export function flushLine(o: FlushOutcome): string {
  const what = `${o.draft} ${targetLabel(o.target)}`;
  if (o.status === "SENT") return `SENT ${what} message=${o.messageId}`;
  if (o.status === "HELD") return `HELD ${what}: the messenger may or may not have it${o.detail ? ` (${o.detail})` : ""}; check the chat, it is not sent again`;
  return `FAILED ${what}: ${o.detail}; the draft stays open: flush again, or drop it`;
}

// ---------- react, edit, typing, thread ----------
// These act on the messenger at once (never drafted) and never touch the ledger: none of them answers an id.

/** Where typing or a thread change goes: a chat and thread, plus the message it was asked from (`--of`). */
export type Where = { readonly source: string; readonly target: ThreadTarget };

function messengerRow(root: string, id: string): MessengerRow {
  const row = new Channel(root).inbound().find((r) => r.id === id);
  if (!row) throw new Refusal(`unknown message id ${id}`);
  if (row.kind !== "messenger") throw new Refusal(`${id} is a watch event, not a messenger message`);
  return row;
}

/** The platform's id of the message (an `:edit:` suffix dropped); chat ids may contain colons, so slice by known parts. */
const upstreamId = (row: MessengerRow): string => replyTarget(row.id.slice(row.source.length + row.chat.length + 2));

/** `--to source:chat[:thread]`, or `--of <id>`: the chat and thread that lead channel message came in. */
export function whereOf(root: string, o: { readonly to?: string; readonly of?: string }): Where {
  if ((o.to === undefined) === (o.of === undefined)) throw new Refusal("give exactly one of --to or --of");
  if (o.to !== undefined) {
    const t = parseTo(o.to);
    return { source: t.source, target: { chat: t.chat, ...(t.thread !== undefined ? { thread: t.thread } : {}) } };
  }
  const row = messengerRow(root, o.of!);
  return { source: row.source, target: { chat: row.chat, ...(row.thread !== undefined ? { thread: row.thread } : {}), message: upstreamId(row) } };
}

export const whereLabel = (w: Where): string => [w.source, w.target.chat, ...(w.target.thread !== undefined ? [w.target.thread] : [])].join(":");

/** `seori msg react`: the eyes reaction on an owner's message, added or removed. */
export async function msgReact(root: string, id: string, on: boolean, d: MsgDeps): Promise<void> {
  const row = messengerRow(root, id);
  await adapterFor(d, row.source).react(row.chat, upstreamId(row), on);
}

/** `seori msg edit --to`: new text for a message seori sent (its id as `msg send` printed it). */
export async function msgEdit(root: string, to: NoticeTarget, message: string, text: string, d: MsgDeps, allowUnknownChat?: boolean): Promise<void> {
  if (!/^[\w.-]+$/.test(message) || /^\.+$/.test(message)) throw new Refusal(`--message must be a message id (letters, digits, dot, dash), got "${message}"`);
  if (!text.trim()) throw new Refusal("refusing to edit a message to empty text");
  const adapter = adapterFor(d, to.source);
  fenceUserTo(root, adapter, to, allowUnknownChat);
  await adapter.edit({ chat: to.chat, ...(to.thread !== undefined ? { thread: to.thread } : {}) }, message, text);
}

/**
 * `seori msg edit --reply-of <id>`: new text for seori's FIRST reply to that message (the acknowledgement that serves as
 * the job's status message), found in the ledger, so a drafted or flushed reply can be edited without its message id.
 * Returns the edited message id.
 */
export async function msgEditReplyOf(root: string, id: string, text: string, d: MsgDeps): Promise<string> {
  const row = messengerRow(root, id);
  const first = new Channel(root).ledger().find((e) => e.id === id && e.ev === "replied");
  if (first?.ev !== "replied") throw new Refusal(`no reply to ${id} has been sent yet; --reply-of edits a reply seori already sent`);
  if (!text.trim()) throw new Refusal("refusing to edit a message to empty text");
  await adapterFor(d, row.source).edit({ chat: row.chat, ...(row.thread !== undefined ? { thread: row.thread } : {}) }, first.messageId, text);
  return first.messageId;
}

export async function msgTyping(w: Where, d: MsgDeps): Promise<ActionNotes> {
  return adapterFor(d, w.source).typing(w.target);
}

export async function msgThread(w: Where, change: ThreadChange, d: MsgDeps): Promise<ThreadResult> {
  if (change.name === undefined && change.status === undefined && change.state === undefined) {
    throw new Refusal("nothing to change: give --name, --status, --close or --reopen");
  }
  return adapterFor(d, w.source).thread(w.target, change);
}

/**
 * `seori msg show <id>`: one message by its lead channel id, from the lead channel when it is stored there (with what it
 * replies to), else read from the messenger. `ok` false: the messenger could not give it (the first line says why).
 */
export async function msgShow(root: string, id: string, d: MsgDeps): Promise<{ readonly ok: boolean; readonly lines: string[] }> {
  const row = new Channel(root).inbound().find((r) => r.id === id);
  if (row?.kind === "messenger") {
    const reply = row.replyTo ? ` (reply to ${row.replyTo.id})` : "";
    return { ok: true, lines: [`MESSAGE ${id} from ${row.from} at ${new Date(row.at).toISOString()}${reply}`, row.text] };
  }
  const parts = replyTarget(id).split(":");
  if (parts.length < 3 || parts.some((p) => !p)) throw new Refusal(`msg show takes a lead channel id source:chat:message, got "${id}"`);
  const [source, ...rest] = parts;
  const message = rest.pop()!;
  const got = await adapterFor(d, source!).fetchMessage(rest.join(":"), message);
  if ("unavailable" in got) return { ok: false, lines: [`UNAVAILABLE ${id}: ${got.unavailable}`] };
  return { ok: true, lines: [`MESSAGE ${id} from ${got.from} at ${new Date(got.at).toISOString()}`, got.text] };
}

/** The lines `seori msg thread` prints: what the messenger did (or SKIPPED when it did nothing), then one NOTE per limit. */
export function threadLine(label: string, r: ThreadResult): string[] {
  const did = [
    ...(r.name !== undefined ? [`name=${JSON.stringify(r.name)}`] : r.status !== undefined ? [`status=${r.status}`] : []),
    ...(r.state === "close" ? ["closed"] : r.state === "reopen" ? ["reopened"] : []),
  ];
  return [did.length ? `THREAD ${label} ${did.join(" ")}` : `SKIPPED thread ${label}`, ...r.notes.map((n) => `NOTE ${n}`)];
}

/** Closes an id without replying (handled elsewhere, not worth an answer). */
export function msgClose(root: string, id: string, why: string, now: number): void {
  const channel = new Channel(root);
  const s = channel.states().find((x) => x.row.id === id);
  if (!s) throw new Refusal(`unknown message id ${id}`);
  if (s.replied) throw new Refusal(`${id} is already replied`);
  if (s.closed) throw new Refusal(`${id} is already closed`);
  channel.appendLedger({ id, ev: "closed", at: now, why });
}

function stateOf(s: IdState): string {
  if (s.replied) return "replied";
  if (s.closed) return "closed";
  if (s.drafted) return "drafted";
  if (s.uncertain) return "uncertain";
  if (s.gaveUp) return "gave-up";
  if (s.entered) return "entered";
  if (s.deliveries) return `delivered ${s.deliveries}`;
  return "open";
}

function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** One line per id: id, state, age, kind, sender (a watch's name), the first 60 characters of the text JSON-escaped (one line, no control bytes). */
export function msgList(root: string, o: { readonly all?: boolean }, now: number): string[] {
  const channel = new Channel(root);
  const shown = o.all ? channel.states() : channel.open();
  return shown.map((s) => {
    const { row } = s;
    return `${row.id}  ${stateOf(s)}  ${age(now - row.at)}  ${row.kind}  ${row.kind === "watch" ? row.name : row.from}  ${JSON.stringify(row.text.slice(0, 60))}`;
  });
}
