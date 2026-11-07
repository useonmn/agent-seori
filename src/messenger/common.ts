import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readableByOthers } from "../platform.ts";
import { SendUncertain } from "./adapter.ts";

// Shared by the Telegram, Slack and Discord adapters: secrets, durable cursors, text splitting, ids, and an HTTP call
// that tells a definite failure apart from one that may have reached the platform.

/** `$SEORI_HOME/secrets.json`, written by onboarding with mode 0600: `{ "telegram": { "token": "..." }, ... }`. */
export type Secrets = Readonly<Record<string, Readonly<Record<string, string>>>>;

export function secretsPath(root: string): string {
  return join(root, "secrets.json");
}

/**
 * One secret for one messenger: the environment variable wins (tests, one-off runs), then secrets.json. Missing is a
 * configuration error naming both places. A secrets.json readable by group or others is refused, so tokens never sit
 * world-readable without the owner noticing (on Windows, by its ACL: see readableByOthers).
 */
export function secret(
  root: string, source: string, key: string, envName: string, env: Record<string, string | undefined> = process.env,
  othersCanRead: (path: string) => string | undefined = readableByOthers,
): string {
  const fromEnv = env[envName];
  if (fromEnv) return fromEnv;
  const path = secretsPath(root);
  if (existsSync(path)) {
    const exposed = othersCanRead(path);
    if (exposed) throw new Error(exposed);
    const all = JSON.parse(readFileSync(path, "utf8")) as Secrets;
    const value = all[source]?.[key];
    if (value) return value;
  }
  throw new Error(`no ${source} ${key}: set ${envName} or "${source}": { "${key}": "..." } in ${path}`);
}

/** A small JSON file an adapter keeps its receive cursor in, under `$SEORI_HOME/messenger/<source>/`. */
export class CursorFile<T> {
  constructor(readonly path: string) {}

  static for<T>(root: string, source: string, name = "cursor.json"): CursorFile<T> {
    return new CursorFile<T>(join(root, "messenger", source, name));
  }

  load(): T | undefined {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  /** Atomic (tmp + rename), so a crash leaves the old cursor or the new one, never a torn file. */
  save(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, this.path);
  }
}

/**
 * Splits text into chunks of at most `limit` UTF-16 code units (how Telegram, Slack and Discord count), preferring a
 * paragraph break, then a line break, then a space, and cutting hard only inside a single overlong word. Surrogate
 * pairs are never split. Empty text yields no chunks.
 */
export function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut <= 0) cut = window.lastIndexOf("\n");
    if (cut <= 0) cut = window.lastIndexOf(" ");
    if (cut <= 0) {
      cut = limit;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // keep a surrogate pair together
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    // Drop only the separator cut on, so an indented line at the start of the next chunk keeps its indentation.
    rest = rest.slice(cut).replace(/^(\n\n|\n| )/, "");
  }
  if (rest.trim()) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

/**
 * Ids are `<source>:<chat>:<message id>`. An edit of a message is a new id `<source>:<chat>:<message id>:edit:<stamp>`
 * (the stamp is the platform's edit time), so the daemon's dedupe keeps it and the lead sees the correction; a reply to
 * either id threads under the original message.
 */
export const messageId = (source: string, chat: string, message: string): string => `${source}:${chat}:${message}`;
export const editId = (source: string, chat: string, message: string, stamp: string): string => `${source}:${chat}:${message}:edit:${stamp}`;

/** The upstream message id to reply to, from the part of an id after `<source>:<chat>:` (drops an `:edit:` suffix). */
export function replyTarget(rest: string): string {
  const i = rest.indexOf(":edit:");
  return i >= 0 ? rest.slice(0, i) : rest;
}

/** One line per attachment appended to the message text; files are referenced, never downloaded. */
export function attachmentLine(name: string, detail: string, ref: string): string {
  return `[attachment: ${name}${detail ? ` (${detail})` : ""} ${ref}]`;
}

export type HttpResult = { readonly status: number; readonly headers: Headers; readonly body: unknown };

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

/**
 * One HTTP request with a timeout. Retries a 429 (honouring Retry-After / retry_after, at most `retries` times) and a
 * failure to connect: both mean the request was not taken. Once the request may have reached the platform (a timeout,
 * a dropped connection, a 5xx after sending), a mutating call (`mutating: true`) throws SendUncertain and is never
 * retried; a read retries instead. A 4xx other than 429 is a definite HttpError.
 */
export async function httpJson(
  url: string,
  init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: unknown; readonly signal?: AbortSignal },
  opts: { readonly mutating: boolean; readonly timeoutMs?: number; readonly retries?: number; readonly sleep?: (ms: number) => Promise<void> },
): Promise<HttpResult> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { ...(init.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }), ...init.headers },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      });
    } catch (e) {
      if (init.signal?.aborted) throw e;
      const refused = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Unable to connect/i.test(String((e as Error).message ?? e));
      if (opts.mutating && !refused) throw new SendUncertain(`request may have reached ${new URL(url).host}: ${(e as Error).message ?? e}`);
      if (attempt >= retries) throw e;
      await sleep(Math.min(30_000, 500 * 2 ** attempt));
      continue;
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      // The platform answered, so the request was taken; only the answer was lost (a drop or timeout mid-body).
      if (init.signal?.aborted) throw e;
      if (opts.mutating) throw new SendUncertain(`${new URL(url).host} answered ${res.status} but the reply was cut off: ${(e as Error).message ?? e}`);
      if (attempt >= retries) throw e;
      await sleep(Math.min(30_000, 500 * 2 ** attempt));
      continue;
    }
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON: keep the text for the error message
    }
    if (res.status === 429 && attempt < retries) {
      await sleep(retryAfterMs(res.headers, body));
      continue;
    }
    if (res.status >= 500) {
      if (opts.mutating) throw new SendUncertain(`${new URL(url).host} answered ${res.status}; the request may have been taken`);
      if (attempt < retries) {
        await sleep(Math.min(30_000, 500 * 2 ** attempt));
        continue;
      }
    }
    if (res.status >= 400) throw new HttpError(`${new URL(url).host} answered ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`, res.status, body);
    return { status: res.status, headers: res.headers, body };
  }
}

/** Retry-After header (seconds), or a body `retry_after` (Discord: seconds, Telegram: parameters.retry_after). */
export function retryAfterMs(headers: Headers, body: unknown): number {
  const header = Number(headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const b = body as { retry_after?: unknown; parameters?: { retry_after?: unknown } } | undefined;
  const fromBody = Number(b?.retry_after ?? b?.parameters?.retry_after);
  return Number.isFinite(fromBody) && fromBody > 0 ? fromBody * 1000 : 1000;
}
