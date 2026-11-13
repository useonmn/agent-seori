import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
  ACTION_MAX_RETRY_AFTER_MS, type ActionNotes, ADAPTER_OUTAGE_MS, EYES, type FetchedMessage, type InboundMessage, type MessengerAdapter, type MessengerConfig, type SendTarget, SendUncertain,
  type ThreadChange, threadName, type ThreadResult, type ThreadTarget,
} from "./adapter.ts";
import { attachmentLine, CursorFile, editId, HttpError, httpJson, messageId, replyTarget, retryAfterMs, secret, splitText } from "./common.ts";
import type { VoiceTranscriber } from "./voice.ts";

// Telegram Bot API over plain fetch: getUpdates long polling in, sendMessage out. The cursor is the next update offset,
// saved after each update was handled; Telegram confirms an update once getUpdates is called with a higher offset and
// keeps unconfirmed ones for 24 hours, so the saved offset is the whole at-least-once story.

const TEXT_LIMIT = 4096;
const TOPIC_NAME_LIMIT = 128;
const MAX_BACKOFF_MS = 30_000;
/** How long one voice message may take to download and transcribe before it is delivered without a transcript. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

type User = { id: number; is_bot?: boolean; username?: string };
type FileRef = { file_id: string; file_name?: string; mime_type?: string; file_size?: number; width?: number; height?: number; duration?: number; emoji?: string };
type Message = {
  message_id: number;
  from?: User;
  chat: { id: number; type: string };
  date: number;
  edit_date?: number;
  is_topic_message?: boolean;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  photo?: FileRef[];
  document?: FileRef;
  voice?: FileRef;
  audio?: FileRef;
  video?: FileRef;
  video_note?: FileRef;
  animation?: FileRef;
  sticker?: FileRef;
  reply_to_message?: Message;
  forum_topic_created?: unknown;
};
type Update = { update_id: number; message?: Message; edited_message?: Message };
type ApiBody = { ok?: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };
type Cursor = { offset: number };

export type TelegramDeps = {
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Owner pairing (src/pair.ts) only, never the daemon: accept a new direct message from any non-bot sender instead of
   * the configured owner, so `seori msg pair` can learn the owner's id. Edits and group messages are still skipped.
   */
  pairing?: boolean;
  /** Where the cursor lives instead of `root` (`seori msg pair` points it at a temp dir so the daemon's cursor is untouched). */
  cursorRoot?: string;
  /**
   * Voice and audio messages: when set, the owner's voice/audio file is downloaded to <root>/messenger/<source>/voice/
   * and its transcript is appended to the message text as a "[transcript: ...]" line. A failure (hook missing or
   * failing, download error) leaves the text as it was (the file is still referenced) and calls `warn` once.
   */
  transcribe?: VoiceTranscriber;
  /**
   * The signal that ends one transcription after `ms` (AbortSignal.timeout by default): a hook still running then is
   * killed and the message is delivered without a transcript, so a hung hook never stops the messages after it.
   */
  deadline?: (ms: number) => AbortSignal;
  warn?: (line: string) => void;
};

/** Thrown out of receive(): retrying cannot help, the owner has to change something. */
class FatalConfig extends Error {}

export class TelegramAdapter implements MessengerAdapter {
  readonly source: string;
  private readonly owner: string;
  private readonly apiBase: string;
  private readonly pollTimeoutSec: number;
  private readonly cursor: CursorFile<Cursor>;
  private readonly env: Record<string, string | undefined>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pairing: boolean;
  private readonly transcribe: VoiceTranscriber | undefined;
  private readonly deadline: (ms: number) => AbortSignal;
  private readonly warn: (line: string) => void;

  constructor(config: MessengerConfig, private readonly root: string, deps: TelegramDeps = {}) {
    this.source = config.source;
    this.owner = config.owner;
    const opts = config.options ?? {};
    this.apiBase = typeof opts["apiBase"] === "string" ? opts["apiBase"].replace(/\/+$/, "") : "https://api.telegram.org";
    this.pollTimeoutSec = typeof opts["pollTimeoutSec"] === "number" ? opts["pollTimeoutSec"] : 25;
    this.cursor = CursorFile.for<Cursor>(deps.cursorRoot ?? root, config.source);
    this.env = deps.env ?? process.env;
    this.sleepFn = deps.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = deps.now ?? Date.now;
    this.pairing = deps.pairing === true;
    this.transcribe = deps.pairing === true ? undefined : deps.transcribe;
    this.deadline = deps.deadline ?? ((ms) => AbortSignal.timeout(ms));
    this.warn = deps.warn ?? ((line) => void process.stderr.write(`${line}\n`));
  }

  private token(): string {
    return secret(this.root, this.source, "token", "SEORI_TELEGRAM_TOKEN", this.env);
  }

  private url(token: string, method: string): string {
    return `${this.apiBase}/bot${token}/${method}`;
  }

  /** Waits `ms`, returning early (without throwing) when `signal` aborts. */
  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([this.sleepFn(ms), promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private fatal(status: number, body: unknown): FatalConfig | undefined {
    const description = (body as ApiBody | undefined)?.description ?? "";
    const where = `telegram (${this.source})`;
    if (status === 401 || status === 404)
      return new FatalConfig(`${where}: the bot token was rejected (${status} ${description || "Unauthorized"}); get the token from @BotFather and set SEORI_TELEGRAM_TOKEN or "${this.source}": { "token": "..." } in secrets.json`);
    if (status === 409)
      return new FatalConfig(`${where}: another program is reading this bot (409 ${description || "Conflict"}); stop it — only one program may poll a bot token`);
    if (status === 403) return new FatalConfig(`${where}: Telegram refused the bot (403 ${description || "Forbidden"})`);
    return undefined;
  }

  /**
   * One Bot API read for the receive loop: transient failures (network, timeout, 5xx, 429, odd 4xx) are retried with
   * capped backoff until `signal` aborts (then undefined); a token or consumer problem throws FatalConfig. When the
   * read has not succeeded for ADAPTER_OUTAGE_MS (counted from the call, which follows the last success or the start of
   * receive) it throws a plain Error instead, so the daemon records the outage and restarts receive.
   */
  private async poll(token: string, method: string, body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const since = this.now();
    for (let attempt = 0; !signal.aborted; attempt++) {
      let wait = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 10));
      try {
        const res = await httpJson(this.url(token, method), { body, signal }, { mutating: false, timeoutMs, retries: 0, sleep: (ms) => this.sleep(ms, signal) });
        const b = res.body as ApiBody | undefined;
        if (b?.ok !== true) throw new HttpError(`telegram ${method}: ${b?.description ?? "not ok"}`, b?.error_code ?? res.status, b);
        return b.result;
      } catch (e) {
        if (signal.aborted) return undefined;
        if (e instanceof HttpError) {
          const fatal = this.fatal(e.status, e.body);
          if (fatal) throw fatal;
          if (e.status === 429) wait = Math.min(MAX_BACKOFF_MS, retryAfterMs(new Headers(), e.body));
        }
        const failingMs = this.now() - since;
        if (failingMs > ADAPTER_OUTAGE_MS) {
          const last = String((e as Error)?.message ?? e).replaceAll(token, "<token>");
          throw new Error(`telegram (${this.source}): ${method} has kept failing for ${Math.round(failingMs / 1000)} s; last error: ${last}`);
        }
      }
      await this.sleep(wait, signal);
    }
    return undefined;
  }

  async receive(signal: AbortSignal, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    if (signal.aborted) return;
    const token = this.token();
    // getUpdates refuses to run while a webhook is set; dropping pending updates would lose messages, so keep them.
    await this.poll(token, "deleteWebhook", { drop_pending_updates: false }, signal, 30_000);
    let offset = this.cursor.load()?.offset;
    while (!signal.aborted) {
      const result = await this.poll(
        token,
        "getUpdates",
        { ...(offset !== undefined ? { offset } : {}), timeout: this.pollTimeoutSec, limit: 100, allowed_updates: ["message", "edited_message"] },
        signal,
        (this.pollTimeoutSec + 15) * 1000,
      );
      if (!Array.isArray(result)) continue;
      for (const update of result as Update[]) {
        if (signal.aborted) return;
        const m = await this.withTranscript(update, token, this.inbound(update), signal);
        // Stopped mid-transcription: neither deliver nor commit, so the next receive offers this update again.
        if (signal.aborted) return;
        // A rejection propagates before the save, so this update is fetched again on the next receive.
        if (m) await onMessage(m);
        offset = update.update_id + 1;
        this.cursor.save({ offset });
      }
    }
  }

  /**
   * `m` plus a transcript line when the update carries a voice/audio file and hooks.transcribe produces one within
   * TRANSCRIBE_TIMEOUT_MS. Past the deadline, or when `signal` aborts, the hook is killed and `m` is returned as it was.
   */
  private async withTranscript(update: Update, token: string, m: InboundMessage | undefined, signal: AbortSignal): Promise<InboundMessage | undefined> {
    const file = (update.edited_message ?? update.message)?.voice ?? (update.edited_message ?? update.message)?.audio;
    if (!m || !file || !this.transcribe) return m;
    const stop = AbortSignal.any([signal, this.deadline(TRANSCRIBE_TIMEOUT_MS)]);
    const { promise: stopped, reject } = Promise.withResolvers<never>();
    const onStop = () => reject(new Error(`no transcript after ${TRANSCRIBE_TIMEOUT_MS / 1000} s`));
    if (stop.aborted) onStop();
    else stop.addEventListener("abort", onStop, { once: true });
    try {
      const text = await Promise.race([this.transcribe(() => this.download(token, file), stop), stopped]);
      return { ...m, text: `${m.text}\n[transcript: ${text}]` };
    } catch (e) {
      if (signal.aborted) return m;
      const why = String((e as Error)?.message ?? e).replaceAll(token, "<token>").trim().split("\n")[0];
      this.warn(`seori: telegram (${this.source}): voice message not transcribed: ${why}`);
      return m;
    } finally {
      stop.removeEventListener("abort", onStop);
    }
  }

  /** Saves a Telegram file under <root>/messenger/<source>/voice/ and returns its path (the file is kept). */
  private async download(token: string, f: FileRef): Promise<string> {
    const res = await httpJson(this.url(token, "getFile"), { body: { file_id: f.file_id } }, { mutating: false, timeoutMs: 30_000, retries: 2, sleep: this.sleepFn });
    const filePath = ((res.body as ApiBody | undefined)?.result as { file_path?: string } | undefined)?.file_path;
    if (!filePath) throw new Error("telegram getFile answered without a file path");
    const got = await fetch(`${this.apiBase}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(120_000) });
    if (!got.ok) throw new Error(`telegram file download failed (${got.status})`);
    const dir = join(this.root, "messenger", this.source, "voice");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${f.file_id.replace(/[^\w-]/g, "_")}${extname(filePath) || ".ogg"}`);
    await Bun.write(path, got);
    return path;
  }

  /** The owner's message as an InboundMessage, or undefined for anything to skip (others, bots, channels, empty). */
  private inbound(update: Update): InboundMessage | undefined {
    const edited = update.edited_message !== undefined;
    const msg = update.edited_message ?? update.message;
    if (!msg?.from || msg.from.is_bot) return undefined;
    if (this.pairing) {
      // Pairing: a new direct message from anyone; the owner is whoever pair accepts.
      if (edited || msg.chat.type !== "private" || msg.chat.id !== msg.from.id) return undefined;
    } else {
      if (String(msg.from.id) !== this.owner) return undefined;
      if (msg.chat.type === "channel") return undefined;
      if (msg.chat.type === "private" && String(msg.chat.id) !== this.owner) return undefined;
    }
    const lines = attachments(msg);
    const body = msg.text ?? msg.caption ?? "";
    if (!body && lines.length === 0) return undefined;
    const text = [body, ...lines].filter((l) => l).join("\n");
    const chat = String(msg.chat.id);
    const id = String(msg.message_id);
    const stamp = msg.edit_date ?? msg.date;
    // In a forum topic every message points at the topic's first (service) message: that is the topic, not a reply.
    const parent = msg.reply_to_message;
    const isTopicRoot = parent !== undefined && (parent.forum_topic_created !== undefined || (msg.is_topic_message === true && parent.message_id === msg.message_thread_id));
    const parentText = parent && !isTopicRoot ? [parent.text ?? parent.caption ?? "", ...attachments(parent)].filter((l) => l).join("\n") : "";
    return {
      ...(parent && !isTopicRoot ? { replyTo: { id: messageId(this.source, chat, String(parent.message_id)), ...(parentText ? { text: parentText } : {}) } } : {}),
      id: edited ? editId(this.source, chat, id, String(stamp)) : messageId(this.source, chat, id),
      source: this.source,
      chat,
      // Outside a forum topic message_thread_id may be a reply root, not a topic (telegram-bot-api#447).
      ...(msg.is_topic_message && msg.message_thread_id !== undefined ? { thread: String(msg.message_thread_id) } : {}),
      from: String(msg.from.id),
      sender: { kind: "owner", id: String(msg.from.id) },
      at: (edited ? stamp : msg.date) * 1000,
      text: edited ? `(edited) ${text}` : text,
    };
  }

  async send(target: SendTarget, text: string): Promise<{ messageId: string }> {
    const chunks = splitText(text, TEXT_LIMIT);
    if (chunks.length === 0) throw new Error(`telegram (${this.source}): refusing to send an empty message`);
    const token = this.token();
    let first: string | undefined;
    for (const [i, chunk] of chunks.entries()) {
      const body = {
        chat_id: target.chat,
        text: chunk,
        link_preview_options: { is_disabled: true },
        ...(target.thread !== undefined ? { message_thread_id: Number(target.thread) } : {}),
        ...(i === 0 && target.replyTo !== undefined ? { reply_parameters: { message_id: Number(replyTarget(target.replyTo)), allow_sending_without_reply: true } } : {}),
      };
      try {
        const res = await httpJson(this.url(token, "sendMessage"), { body }, { mutating: true, timeoutMs: 30_000, sleep: this.sleepFn });
        const b = res.body as ApiBody | undefined;
        const sent = (b?.result as { message_id?: number } | undefined)?.message_id;
        if (b?.ok !== true || sent === undefined) throw new SendUncertain(`telegram sendMessage answered without a message id: ${JSON.stringify(b)}`);
        first ??= String(sent);
      } catch (e) {
        if (i > 0) throw new SendUncertain(`telegram (${this.source}): part ${i + 1}/${chunks.length} failed after earlier parts were sent: ${(e as Error).message}`);
        if (e instanceof HttpError) throw new Error(`telegram (${this.source}): sendMessage failed: ${(e.body as ApiBody | undefined)?.description ?? e.message}`);
        throw e;
      }
    }
    return { messageId: first! };
  }

  /** One idempotent Bot API action; a refusal whose description matches `harmless` (nothing to change) counts as done. */
  private async act(method: string, body: Record<string, unknown>, harmless?: RegExp): Promise<void> {
    const token = this.token();
    try {
      const res = await httpJson(this.url(token, method), { body }, { mutating: false, timeoutMs: 30_000, retries: 2, sleep: this.sleepFn, maxRetryAfterMs: ACTION_MAX_RETRY_AFTER_MS });
      const b = res.body as ApiBody | undefined;
      if (b?.ok !== true) throw new Error(`telegram (${this.source}): ${method} failed: ${b?.description ?? "not ok"}`);
    } catch (e) {
      if (!(e instanceof HttpError)) throw new Error(String((e as Error)?.message ?? e).replaceAll(token, "<token>"));
      const description = e.status === 429 ? e.message : ((e.body as ApiBody | undefined)?.description ?? e.message);
      if (harmless?.test(description)) return;
      throw new Error(`telegram (${this.source}): ${method} failed: ${description}`);
    }
  }

  async react(chat: string, message: string, on: boolean): Promise<void> {
    await this.act("setMessageReaction", { chat_id: chat, message_id: Number(message), reaction: on ? [{ type: "emoji", emoji: EYES }] : [] });
  }

  async edit(target: SendTarget, message: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error(`telegram (${this.source}): refusing to edit a message to empty text`);
    if (text.length > TEXT_LIMIT) throw new Error(`telegram (${this.source}): an edited message holds at most ${TEXT_LIMIT} characters, got ${text.length}`);
    const body = { chat_id: target.chat, message_id: Number(message), text, link_preview_options: { is_disabled: true } };
    await this.act("editMessageText", body, /message is not modified/);
  }

  async typing(target: ThreadTarget): Promise<ActionNotes> {
    await this.act("sendChatAction", { chat_id: target.chat, action: "typing", ...(target.thread !== undefined ? { message_thread_id: Number(target.thread) } : {}) });
    return [];
  }

  /** Topics: renamed in forum supergroups and private chats with topics; closed and reopened only in forum supergroups. */
  async thread(target: ThreadTarget, change: ThreadChange): Promise<ThreadResult> {
    if (target.thread === undefined) return { notes: ["telegram: the message is not in a topic, so there is no topic to rename or close; the status message carries the status"] };
    const topic = { chat_id: target.chat, message_thread_id: Number(target.thread) };
    const notes: string[] = [];
    let named: string | undefined;
    let state: ThreadChange["state"];
    if (change.name !== undefined) {
      const name = threadName(change.name, change.status);
      if (name.length > TOPIC_NAME_LIMIT) throw new Error(`telegram (${this.source}): a topic name holds at most ${TOPIC_NAME_LIMIT} characters, got ${name.length}`);
      await this.act("editForumTopic", { ...topic, name }, /TOPIC_NOT_MODIFIED/);
      named = name;
    } else if (change.status !== undefined) {
      notes.push(`telegram: a topic's name cannot be read back; pass --name with --status`);
    }
    if (change.state !== undefined) {
      // Private chat ids are the user's id (positive); groups and supergroups are negative.
      if (target.chat.startsWith("-")) {
        await this.act(change.state === "close" ? "closeForumTopic" : "reopenForumTopic", topic, /TOPIC_NOT_MODIFIED/);
        state = change.state;
      } else {
        notes.push("telegram: a topic in a private chat cannot be closed or reopened; the ✅ at the start of its name marks it done");
      }
    }
    return { ...(named !== undefined ? { name: named } : {}), ...(state !== undefined ? { state } : {}), notes };
  }

  async fetchMessage(_chat: string, _message: string): Promise<FetchedMessage> {
    return { unavailable: "Telegram bots cannot read a message by id; a reply carries the text it replies to, shown in the lead channel line" };
  }

  async check(): Promise<string> {
    const token = this.token();
    try {
      const res = await httpJson(this.url(token, "getMe"), {}, { mutating: false, timeoutMs: 15_000, retries: 2, sleep: this.sleepFn });
      const me = (res.body as ApiBody).result as User;
      return `@${me.username} (id ${me.id})`;
    } catch (e) {
      if (e instanceof HttpError) throw this.fatal(e.status, e.body) ?? e;
      throw e;
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const KINDS = ["document", "voice", "audio", "video", "video_note", "animation", "sticker"] as const;

/** One attachmentLine per file; a photo is offered in several sizes and only the largest (last) is referenced. */
function attachments(msg: Message): string[] {
  const files: [string, FileRef][] = [];
  const photo = msg.photo?.at(-1);
  if (photo) files.push(["photo", photo]);
  for (const kind of KINDS) {
    const f = msg[kind];
    // An animation also carries a document copy of the same file; list it once.
    if (f && !(kind === "document" && msg.animation)) files.push([kind, f]);
  }
  return files.map(([kind, f]) => {
    const detail = [
      f.file_name ? kind : "",
      f.mime_type ?? "",
      f.width && f.height && (kind === "photo" || kind === "video") ? `${f.width}x${f.height}` : "",
      f.duration ? `${f.duration}s` : "",
      f.emoji ?? "",
      f.file_size !== undefined ? formatSize(f.file_size) : "",
    ].filter((p) => p);
    return attachmentLine(f.file_name ?? kind, detail.join(", "), `telegram-file:${f.file_id}`);
  });
}
