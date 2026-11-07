import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Channel } from "./channel.ts";
import { type InboundMessage, loadMessengers, type MessengerAdapter, type MessengerConfig } from "./messenger/adapter.ts";
import { adapterFor as defaultAdapterFor } from "./messenger/index.ts";
import { lockFile } from "./store.ts";

// `seori daemon`: receives every configured messenger and stores owner messages in the lead channel before the adapter
// acknowledges them upstream. It never talks to omp; the lead extension delivers from the channel. One daemon per
// $SEORI_HOME (daemon.lock), and a heartbeat file so duty can tell a dead daemon from a quiet messenger.

export const HEARTBEAT_MS = 5_000;
export const RESTART_DELAY_MS = 5_000;

export const daemonDir = (root: string): string => join(root, "messenger");
export const daemonLockPath = (root: string): string => join(daemonDir(root), "daemon.lock");
export const heartbeatPath = (root: string): string => join(daemonDir(root), "daemon.heartbeat");

export type DaemonEvent =
  | { readonly ev: "stored"; readonly id: string }
  | { readonly ev: "duplicate"; readonly id: string }
  | { readonly ev: "dropped"; readonly id: string; readonly from: string }
  | { readonly ev: "error"; readonly source: string; readonly detail: string }
  | { readonly ev: "idle"; readonly detail: string };

export const daemonLine = (e: DaemonEvent): string => {
  switch (e.ev) {
    case "stored":
      return `DAEMON stored ${e.id}`;
    case "duplicate":
      return `DAEMON duplicate ${e.id}`;
    case "dropped":
      return `DAEMON dropped ${e.id} from ${e.from}`;
    case "error":
      return `DAEMON ${e.source} error: ${e.detail}`;
    case "idle":
      return `DAEMON ${e.detail}`;
  }
};

export type DaemonOptions = {
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly adapterFor?: (config: MessengerConfig, root: string) => MessengerAdapter;
  readonly heartbeatMs?: number;
  readonly restartDelayMs?: number;
  /** Replaces the default of printing daemonLine(e) to stdout. */
  readonly onEvent?: (e: DaemonEvent) => void;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done);
  return promise;
};

const holderPid = (path: string): string => {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? ` (pid ${pid})` : "";
  } catch {
    return "";
  }
};

/** Renamed into place so a reader never sees a torn heartbeat and mistakes a live daemon for a dead one. */
const writeHeartbeat = (root: string, at: number): void => {
  const path = heartbeatPath(root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at, pid: process.pid }));
  renameSync(tmp, path);
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Runs until `signal` aborts. Throws at once if another live daemon holds the lock. Each messenger runs on its own
 * restart loop, so one adapter crashing (or being unsupported) never stops the others from storing messages.
 */
export async function runDaemon(root: string, opts: DaemonOptions = {}): Promise<void> {
  const signal = opts.signal ?? new AbortController().signal;
  const now = opts.now ?? Date.now;
  const adapterFor = opts.adapterFor ?? defaultAdapterFor;
  const restartDelayMs = opts.restartDelayMs ?? RESTART_DELAY_MS;
  const emit = opts.onEvent ?? ((e: DaemonEvent) => console.log(daemonLine(e)));
  const messengers = loadMessengers(root);

  mkdirSync(daemonDir(root), { recursive: true });
  const lockPath = daemonLockPath(root);
  const release = lockFile(lockPath, now());
  if (!release) throw new Error(`another seori daemon is running for ${root}${holderPid(lockPath)}; stop it first`);

  const channel = new Channel(root);
  writeHeartbeat(root, now());
  const heartbeat = setInterval(() => {
    try {
      writeHeartbeat(root, now());
    } catch (e) {
      emit({ ev: "error", source: "heartbeat", detail: errorText(e) });
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);

  try {
    if (!messengers.length) emit({ ev: "idle", detail: `no messengers configured; add one to ${join(root, "messengers.json")} (heartbeat only)` });

    const runOne = async (config: MessengerConfig): Promise<void> => {
      // Synchronous on purpose: appendInbound fsyncs before returning, so when this resolves the adapter may commit.
      const onMessage = async (m: InboundMessage): Promise<void> => {
        if (m.from !== config.owner) return emit({ ev: "dropped", id: m.id, from: m.from });
        const stored = channel.appendInbound({
          id: m.id,
          kind: "messenger",
          source: m.source,
          chat: m.chat,
          ...(m.thread !== undefined ? { thread: m.thread } : {}),
          from: m.from,
          at: m.at,
          text: m.text,
        });
        emit({ ev: stored ? "stored" : "duplicate", id: m.id });
      };
      while (!signal.aborted) {
        try {
          await adapterFor(config, root).receive(signal, onMessage);
          if (signal.aborted) break;
          emit({ ev: "error", source: config.source, detail: `receive returned early; restarting in ${restartDelayMs} ms` });
        } catch (e) {
          if (signal.aborted) break;
          emit({ ev: "error", source: config.source, detail: `${errorText(e)}; restarting in ${restartDelayMs} ms` });
        }
        await sleep(restartDelayMs, signal);
      }
    };

    // Waits for the abort itself, not just the loops: with no messengers the daemon still keeps its heartbeat up.
    const aborted = Promise.withResolvers<void>();
    if (signal.aborted) aborted.resolve();
    else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await Promise.all([...messengers.map(runOne), aborted.promise]);
  } finally {
    clearInterval(heartbeat);
    release();
  }
}
