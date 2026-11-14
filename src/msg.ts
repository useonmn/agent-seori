// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { Channel, fromOther, type IdState, type MessengerRow } from "./channel.ts";
import { Refusal } from "./harness.ts";
import { loadMessengers, SendUncertain, type MessengerAdapter, type MessengerConfig, type SendTarget } from "./messenger/adapter.ts";
import { adapterFor as defaultAdapterFor } from "./messenger/index.ts";

// `seori msg ...`: the lead answers messenger messages. A reply closes its ids only after the messenger returned a
// message id, so an id is never marked answered on a failed send; an uncertain send is recorded and refused afterwards
// until a human checks the chat and passes --again, so the lead never double-replies on its own. A `sending` event goes
// to the ledger before the messenger is called, so a reply killed mid-send (Esc, timeout, SIGTERM) is uncertain too, and
// the reply lock keeps two concurrent sends from both passing the check.
//
// Every send goes out at once: the owner waits for the answer, so nothing is held back. The lead's omp runs omp's
// advisor, and if the advisor raises a concern after the reply went out, the correction is an ordinary second reply to
// the same id, sent with --again.

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
  readonly text: string;
  readonly again?: boolean;
};

/**
 * SENT: the messenger accepted it. HELD: it may or may not have it (the CLI exits 3 like seori's other HELD results);
 * a held reply is recorded as uncertain and never resent on its own.
 */
export type MsgSendResult = {
  readonly status: "SENT" | "HELD";
  readonly messageId?: string;
  readonly ids: readonly string[];
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

export async function msgSend(root: string, o: MsgSendOptions, d: MsgDeps): Promise<MsgSendResult> {
  if ([o.replyTo, o.to].filter((x) => x !== undefined).length !== 1) throw new Refusal("give exactly one of --reply-to or --to");
  if (!o.text.trim()) throw new Refusal("refusing to send an empty message");

  if (o.to) {
    // A notice is not an answer to anything, so it neither needs nor touches the ledger.
    const adapter = adapterFor(d, o.to.source);
    return sendNotice(adapter, o.to, o.text);
  }

  const ids = [...new Set(o.replyTo)];
  if (!ids.length) throw new Refusal("--reply-to needs at least one id");
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

/** The refusals every reply gets: unknown ids, watch events, mixed chats, ALREADY_REPLIED, UNCERTAIN. */
function checkReply(channel: Channel, ids: readonly string[], again: boolean): IdState & { readonly row: MessengerRow } {
  const states = channel.states({ withOthers: true }); // the lead answers other people too
  const picked = ids.map((id) => {
    const s = states.find((x) => x.row.id === id);
    if (!s) throw new Refusal(`unknown message id ${id}`);
    if (s.row.kind === "watch") throw new Refusal(`${id} is a watch event: watch events need no reply (msg close closes one)`);
    if (fromOther(s.row)) throw new Refusal(`${id} came from someone other than the owner and was stored by an earlier seori; it stays closed`);
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

// ---------- edit ----------
// Never touches the ledger: an edit answers no id.

function messengerRow(root: string, id: string): MessengerRow {
  const row = new Channel(root).inbound({ withOthers: true }).find((r) => r.id === id);
  if (!row) throw new Refusal(`unknown message id ${id}`);
  if (row.kind !== "messenger") throw new Refusal(`${id} is a watch event, not a messenger message`);
  return row;
}

/** `seori msg edit --to`: new text for a message seori sent (its id as `msg send` printed it). */
export async function msgEdit(to: NoticeTarget, message: string, text: string, d: MsgDeps): Promise<void> {
  if (!/^[\w.-]+$/.test(message) || /^\.+$/.test(message)) throw new Refusal(`--message must be a message id (letters, digits, dot, dash), got "${message}"`);
  if (!text.trim()) throw new Refusal("refusing to edit a message to empty text");
  await adapterFor(d, to.source).edit({ chat: to.chat, ...(to.thread !== undefined ? { thread: to.thread } : {}) }, message, text);
}

/**
 * `seori msg edit --reply-of <id>`: new text for seori's FIRST reply to that message (the acknowledgement that serves as
 * the job's status message), found in the ledger, so a reply can be edited without its message id.
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

/** Closes an id without replying (handled elsewhere, not worth an answer). */
export function msgClose(root: string, id: string, why: string, now: number): void {
  const channel = new Channel(root);
  const s = channel.states({ withOthers: true }).find((x) => x.row.id === id);
  if (!s) throw new Refusal(`unknown message id ${id}`);
  if (s.replied) throw new Refusal(`${id} is already replied`);
  if (s.closed) throw new Refusal(`${id} is already closed`);
  channel.appendLedger({ id, ev: "closed", at: now, why });
}

function stateOf(s: IdState): string {
  if (s.replied) return "replied";
  if (s.closed) return fromOther(s.row) ? "closed-other" : "closed";
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
  const shown = o.all ? channel.states({ withOthers: true }) : channel.open({ withOthers: true });
  return shown.map((s) => {
    const { row } = s;
    return `${row.id}  ${stateOf(s)}  ${age(now - row.at)}  ${row.kind}  ${row.kind === "watch" ? row.name : `${row.from}${row.notOwner ? " (not owner)" : ""}`}  ${JSON.stringify(row.text.slice(0, 60))}`;
  });
}
