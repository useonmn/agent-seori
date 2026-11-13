import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActionNotes, type FetchedMessage, type InboundMessage, type MessengerAdapter, type SendTarget, SendUncertain, type ThreadChange, threadName, type ThreadResult, type ThreadTarget,
} from "./adapter.ts";

// A messenger made of files under $SEORI_HOME/messenger/fake/, so tests and humans can drive the whole channel without a
// platform account: append a row to in.jsonl to "send" a message to the lead; read out.jsonl to see what was sent back;
// write ok|timeout|error to send-mode to make sends succeed, end uncertain, or fail.

/** One line of in.jsonl. */
export type FakeInboundRow = { msgId: string; chat: string; thread?: string; from: string; text: string; at?: number; replyTo?: { id: string; text?: string } };
/** One line of out.jsonl. */
export type FakeOutboundRow = { messageId: string; chat: string; thread?: string; replyTo?: string; text: string; at: number };
export type FakeSendMode = "ok" | "timeout" | "error";
/** One line of actions.jsonl: a react, edit, typing or thread call, as it was asked. */
export type FakeActionRow = { action: "react" | "edit" | "typing" | "thread"; at: number } & Record<string, unknown>;

export const fakeDir = (root: string): string => join(root, "messenger", "fake");

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) return Promise.resolve();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done);
  return promise;
};

export class FakeAdapter implements MessengerAdapter {
  readonly source = "fake";
  readonly dir: string;
  private readonly offsetDir: string;
  private readonly pollMs: number;
  private readonly now: () => number;

  /** `cursorRoot`: where the offset file lives instead of `root` (`seori msg pair` points it at a temp dir). */
  constructor(root: string, options: { pollMs?: number; now?: () => number; cursorRoot?: string } = {}) {
    this.dir = fakeDir(root);
    this.offsetDir = fakeDir(options.cursorRoot ?? root);
    this.pollMs = options.pollMs ?? 500;
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true });
    if (this.offsetDir !== this.dir) mkdirSync(this.offsetDir, { recursive: true });
  }

  get inPath(): string {
    return join(this.dir, "in.jsonl");
  }

  get offsetPath(): string {
    return join(this.offsetDir, "offset");
  }

  get outPath(): string {
    return join(this.dir, "out.jsonl");
  }

  get sendModePath(): string {
    return join(this.dir, "send-mode");
  }

  /** Complete lines of in.jsonl consumed so far; the stand-in for a platform's update offset. */
  offset(): number {
    if (!existsSync(this.offsetPath)) return 0;
    const n = Number(readFileSync(this.offsetPath, "utf8").trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  /** Renamed into place so a crash mid-write never leaves a torn offset that would replay or skip messages. */
  private commit(n: number): void {
    const tmp = `${this.offsetPath}.tmp`;
    writeFileSync(tmp, String(n));
    renameSync(tmp, this.offsetPath);
  }

  /** Only newline-terminated lines count: a row still being appended is picked up on a later poll, not half-read. */
  private lines(): string[] {
    if (!existsSync(this.inPath)) return [];
    const text = readFileSync(this.inPath, "utf8");
    const end = text.lastIndexOf("\n");
    return end < 0 ? [] : text.slice(0, end).split("\n");
  }

  async receive(signal: AbortSignal, onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    while (!signal.aborted) {
      const lines = this.lines();
      for (let i = this.offset(); i < lines.length && !signal.aborted; i++) {
        const m = this.parse(lines[i]!);
        // A rejection propagates before the commit, so the message is offered again when receive restarts.
        if (m) await onMessage(m);
        this.commit(i + 1);
      }
      await sleep(this.pollMs, signal);
    }
  }

  /** Blank or malformed lines are consumed without a message; they can never become valid, so waiting on them would stall the queue. */
  private parse(line: string): InboundMessage | undefined {
    if (!line.trim()) return undefined;
    let r: Partial<FakeInboundRow>;
    try {
      r = JSON.parse(line) as Partial<FakeInboundRow>;
    } catch {
      return undefined;
    }
    if (typeof r.msgId !== "string" || typeof r.chat !== "string" || typeof r.from !== "string" || typeof r.text !== "string") return undefined;
    return {
      id: `fake:${r.chat}:${r.msgId}`,
      source: this.source,
      chat: r.chat,
      ...(typeof r.thread === "string" ? { thread: r.thread } : {}),
      from: r.from,
      at: typeof r.at === "number" ? r.at : this.now(),
      text: r.text,
      ...(r.replyTo && typeof r.replyTo.id === "string" ? { replyTo: r.replyTo } : {}),
    };
  }

  sendMode(): FakeSendMode {
    const mode = existsSync(this.sendModePath) ? readFileSync(this.sendModePath, "utf8").trim() : "";
    return mode === "timeout" || mode === "error" ? mode : "ok";
  }

  sent(): FakeOutboundRow[] {
    if (!existsSync(this.outPath)) return [];
    return readFileSync(this.outPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as FakeOutboundRow);
  }

  async check(): Promise<string> {
    return `fake messenger (${this.dir})`;
  }

  get actionsPath(): string {
    return join(this.dir, "actions.jsonl");
  }

  actions(): FakeActionRow[] {
    if (!existsSync(this.actionsPath)) return [];
    return readFileSync(this.actionsPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as FakeActionRow);
  }

  /** send-mode error makes every action fail too; the others always succeed. */
  private act(action: FakeActionRow["action"], detail: Record<string, unknown>): void {
    if (this.sendMode() === "error") throw new Error(`fake messenger: ${action} failed (send-mode error)`);
    appendFileSync(this.actionsPath, `${JSON.stringify({ action, ...detail, at: this.now() })}\n`);
  }

  async react(chat: string, message: string, on: boolean): Promise<void> {
    this.act("react", { chat, message, on });
  }

  async edit(target: SendTarget, message: string, text: string): Promise<void> {
    this.act("edit", { ...target, message, text });
  }

  async typing(target: ThreadTarget): Promise<ActionNotes> {
    this.act("typing", { ...target });
    return [];
  }

  /** A message the owner sent (in.jsonl) or seori sent (out.jsonl, from "seori"). */
  async fetchMessage(chat: string, message: string): Promise<FetchedMessage> {
    for (const line of this.lines()) {
      let r: Partial<FakeInboundRow>;
      try {
        r = JSON.parse(line) as Partial<FakeInboundRow>;
      } catch {
        continue;
      }
      if (r.chat === chat && r.msgId === message && typeof r.text === "string") return { from: String(r.from), at: r.at ?? 0, text: r.text };
    }
    const sent = this.sent().find((r) => r.chat === chat && r.messageId === message);
    return sent ? { from: "seori", at: sent.at, text: sent.text } : { unavailable: "not found" };
  }

  async thread(target: ThreadTarget, change: ThreadChange): Promise<ThreadResult> {
    this.act("thread", { ...target, ...change });
    return {
      ...(change.name !== undefined ? { name: threadName(change.name, change.status) } : change.status !== undefined ? { status: change.status } : {}),
      ...(change.state !== undefined ? { state: change.state } : {}),
      notes: [],
    };
  }

  async send(target: SendTarget, text: string): Promise<{ messageId: string }> {
    const mode = this.sendMode();
    if (mode === "error") throw new Error("fake messenger: send failed (send-mode error)");
    const messageId = String(this.sent().length + 1);
    const row: FakeOutboundRow = {
      messageId,
      chat: target.chat,
      ...(target.thread !== undefined ? { thread: target.thread } : {}),
      ...(target.replyTo !== undefined ? { replyTo: target.replyTo } : {}),
      text,
      at: this.now(),
    };
    appendFileSync(this.outPath, `${JSON.stringify(row)}\n`);
    // Like a real timeout after the request left: the message did arrive, but the caller cannot know that.
    if (mode === "timeout") throw new SendUncertain("fake messenger: send timed out after sending (send-mode timeout)");
    return { messageId };
  }
}
