import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Channel, type MessengerRow } from "./channel.ts";
import { configPath, DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { defaultDeps, type Deps } from "./harness.ts";
import { choiceFor, defaultRuntimes, spawnExec, statusOf } from "./runtime/index.ts";
import { type InboundMessage, loadMessengers, type MessengerAdapter, type MessengerConfig, type Sender } from "./messenger/adapter.ts";
import { adapterFor as defaultAdapterFor } from "./messenger/index.ts";
import { refFromText } from "./refs.ts";
import { lockFile, Store } from "./store.ts";
import { deliverWatchEvent } from "./watch/deliver.ts";
import { type EngineDeps, WatchEngine } from "./watch/engine.ts";

// `seori daemon`: receives every configured messenger and stores the messages meant for seori in the lead channel before
// the adapter acknowledges them upstream (the owner's; with config.json talkWithOthers also other people's and agents',
// with an agent-loop guard), and runs the watch engine (src/watch/engine.ts) that wakes agents when a watch fires. It
// never talks to omp; the lead extension delivers from the channel. One daemon per $SEORI_HOME (daemon.lock), and a
// heartbeat file so duty can tell a dead daemon from a quiet messenger. It reads messengers.json once and exits when the
// file (or config.json) changes, so `seori up`'s restart loop starts it again on the new config (watches resume from
// their files).

export const HEARTBEAT_MS = 5_000;
export const RESTART_DELAY_MS = 5_000;
/**
 * A receive run that lasts this long without throwing counts as healthy again. Longer than ADAPTER_OUTAGE_MS
 * (messenger/adapter.ts), so an adapter that gives up after an outage of that length extends the failure streak
 * instead of ending it.
 */
export const HEALTHY_AFTER_MS = 3 * 60_000;

export const daemonDir = (root: string): string => join(root, "messenger");
export const daemonLockPath = (root: string): string => join(daemonDir(root), "daemon.lock");
export const heartbeatPath = (root: string): string => join(daemonDir(root), "daemon.heartbeat");
/** `messenger/<source>/health.json`: present only while that messenger's receive keeps failing; duty alerts on it. */
export const healthPath = (root: string, source: string): string => join(daemonDir(root), source, "health.json");
/** `config` is the messengers.json stamp the failures happened under: a new config starts a fresh attempt. */
export type MessengerHealth = { readonly failingSince: number; readonly lastAt: number; readonly error: string; readonly failures: number; readonly config?: string };

/** One conversation for the agent-loop guard; JSON, so ids containing ":" never run two conversations together. */
const conversationKey = (chat: string, thread: string | undefined): string => JSON.stringify([chat, thread ?? null]);

/** How many conversations the agent-loop guard remembers per messenger; the least recently active is forgotten first. */
export const AGENT_RUNS_KEPT = 1_000;

/** The longest wait between restarts of a messenger that keeps failing. */
export const MAX_RESTART_DELAY_MS = 10 * 60_000;

/**
 * Wait before the next receive after `failures` failures in a row: doubles from the base up to MAX_RESTART_DELAY_MS, so
 * a setup error (a rejected token, a missing Discord intent) is retried a few times a hour instead of every 5 s, which
 * would burn Discord's 1000 identifies a day and get the token reset.
 */
export const restartDelay = (base: number, failures: number): number => Math.min(MAX_RESTART_DELAY_MS, base * 2 ** Math.max(0, Math.min(failures - 1, 20)));

export function readHealth(root: string, source: string): MessengerHealth | undefined {
  try {
    return JSON.parse(readFileSync(healthPath(root, source), "utf8")) as MessengerHealth;
  } catch {
    return undefined;
  }
}

function recordFailure(root: string, source: string, at: number, error: string, config: string): MessengerHealth {
  const prev = readHealth(root, source);
  const next: MessengerHealth = { failingSince: prev?.failingSince ?? at, lastAt: at, error, failures: (prev?.failures ?? 0) + 1, config };
  const path = healthPath(root, source);
  mkdirSync(join(daemonDir(root), source), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(next));
  renameSync(`${path}.tmp`, path);
  return next;
}

function clearHealth(root: string, source: string): void {
  rmSync(healthPath(root, source), { force: true });
}

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
  /** Runs the heartbeat every `ms` until the returned stop is called (a setInterval by default; tests beat by hand). */
  readonly every?: (tick: () => void, ms: number) => () => void;
  readonly restartDelayMs?: number;
  /** Replaces the default of printing daemonLine(e) to stdout. */
  readonly onEvent?: (e: DaemonEvent) => void;
  /** Replaces parts of the watch engine's deps (tests fake delivery, gh and pane state, or shorten the tick). */
  readonly watch?: Partial<EngineDeps>;
};

/** The real engine deps: watches reach agents through the harness, PR checks through gh, pane state through the runtime. */
function engineDeps(root: string, now: () => number): EngineDeps {
  const store = new Store(root);
  const runtimes = defaultRuntimes(undefined, undefined, choiceFor(root));
  // Built on first delivery: defaultDeps() opens $SEORI_HOME's store, which only a firing watch needs.
  let deps: Deps | undefined;
  return {
    now,
    deliver: (w, text) => deliverWatchEvent((deps ??= { ...defaultDeps(), store, runtimes }), w, text),
    gh: (argv) => spawnExec("gh", argv),
    paneStatus: (pane) => statusOf(runtimes, refFromText(pane)),
    laneOpen: (key) => {
      const status = store.lane(key)?.status;
      return status !== undefined && status !== "done" && status !== "lost";
    },
  };
}

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

/** Identifies one version of a file (missing counts as a version), so an edit, creation or removal is seen. */
const fileStamp = (path: string): string => {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
};

const configStamp = (root: string): string => fileStamp(join(root, "messengers.json"));

/** Why runDaemon returned: its signal aborted, or messengers.json or config.json changed and it must be started again to load it. */
export type DaemonExit = "stopped" | "config-changed";

/**
 * Runs until `signal` aborts or messengers.json changes (checked with every heartbeat). Throws at once if another live
 * daemon holds the lock. Each messenger runs on its own restart loop, so one adapter crashing (or being unsupported)
 * never stops the others from storing messages.
 */
export async function runDaemon(root: string, opts: DaemonOptions = {}): Promise<DaemonExit> {
  const now = opts.now ?? Date.now;
  const adapterFor = opts.adapterFor ?? defaultAdapterFor;
  const restartDelayMs = opts.restartDelayMs ?? RESTART_DELAY_MS;
  const emit = opts.onEvent ?? ((e: DaemonEvent) => console.log(daemonLine(e)));
  // Stamped before the read: an edit landing between the two is still seen as a change.
  const stamp = configStamp(root);
  const settingsStamp = fileStamp(configPath(root));
  // A broken file must not stop the watches too: run without messengers until the file changes (the stamp check below
  // then restarts the daemon on the fixed file). duty tells the lead the file cannot be read.
  let messengers: MessengerConfig[] = [];
  let configError: string | undefined;
  try {
    messengers = loadMessengers(root);
  } catch (e) {
    configError = errorText(e);
  }
  // A config.json that does not load keeps upstream's owner-only rule until it is fixed (the change restarts the daemon).
  let talk = { withOthers: DEFAULT_CONFIG.talkWithOthers, agentTurnLimit: DEFAULT_CONFIG.agentTurnLimit, trusted: DEFAULT_CONFIG.trusted };
  let settingsError: string | undefined;
  try {
    const config = loadConfig(root);
    talk = { withOthers: config.talkWithOthers, agentTurnLimit: config.agentTurnLimit, trusted: config.trusted };
  } catch (e) {
    settingsError = errorText(e);
    talk = { ...talk, withOthers: false };
  }

  mkdirSync(daemonDir(root), { recursive: true });
  const lockPath = daemonLockPath(root);
  const release = lockFile(lockPath, now());
  if (!release) throw new Error(`another seori daemon is running for ${root}${holderPid(lockPath)}; stop it first`);

  // The caller's signal, or a config change: either stops every messenger loop and the wait below.
  const stop = new AbortController();
  const signal = stop.signal;
  const onAbort = () => stop.abort();
  if (opts.signal?.aborted) stop.abort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  let exit: DaemonExit = "stopped";

  const channel = new Channel(root);
  writeHeartbeat(root, now());
  const every = opts.every ?? ((tick: () => void, ms: number) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  });
  const stopHeartbeat = every(() => {
    try {
      writeHeartbeat(root, now());
    } catch (e) {
      emit({ ev: "error", source: "heartbeat", detail: errorText(e) });
    }
    const changed = configStamp(root) !== stamp ? join(root, "messengers.json") : fileStamp(configPath(root)) !== settingsStamp ? configPath(root) : undefined;
    if (!signal.aborted && changed !== undefined) {
      emit({ ev: "idle", detail: `${changed} changed; exiting so it is started again with the new config` });
      exit = "config-changed";
      stop.abort();
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);

  let engine: WatchEngine | undefined;
  try {
    // Started only once the lock is held: one daemon, so one engine, runs a $SEORI_HOME's watches.
    engine = new WatchEngine(root, { ...engineDeps(root, now), ...opts.watch });
    engine.start();
    if (settingsError !== undefined) {
      emit({ ev: "error", source: "config.json", detail: `${settingsError}; only the owner's messages are received until the file changes` });
    }
    if (configError !== undefined) {
      emit({ ev: "error", source: "messengers.json", detail: `${configError}; running without messengers (heartbeat and watches only) until the file changes` });
    } else if (!messengers.length) {
      emit({ ev: "idle", detail: `no messengers configured; add one to ${join(root, "messengers.json")} (heartbeat and watches only)` });
    }

    const runOne = async (config: MessengerConfig): Promise<void> => {
      // Agent messages stored in a row per conversation (chat and thread) since the last human one, rebuilt from the
      // lead channel at start so a restart (every config.json change is one) does not let a stopped loop run on. A
      // replayed message (duplicate) neither counts nor resets. Only the most recent AGENT_RUNS_KEPT conversations are
      // remembered.
      const agentRun = new Map<string, number>();
      const remember = (conversation: string, run: number): void => {
        agentRun.delete(conversation); // re-inserted last: the map keeps the most recently active conversations
        agentRun.set(conversation, run);
        if (agentRun.size > AGENT_RUNS_KEPT) agentRun.delete(agentRun.keys().next().value!);
      };
      for (const r of channel.inbound()) {
        if (r.kind !== "messenger" || r.source !== config.source) continue;
        const conversation = conversationKey(r.chat, r.thread);
        if (r.agent === true || r.sender?.kind === "agent") remember(conversation, r.loopStopped !== undefined ? r.loopStopped + 1 : (agentRun.get(conversation) ?? 0) + 1);
        else agentRun.delete(conversation);
      }
      // Synchronous on purpose: appendInbound fsyncs before returning, so when this resolves the adapter may commit.
      const onMessage = async (m: InboundMessage): Promise<void> => {
        // The owner is the configured id and never a bot, whatever the adapter guessed.
        const owner = m.from === config.owner && m.sender.kind !== "agent";
        if (!owner && !talk.withOthers) return emit({ ev: "dropped", id: m.id, from: m.from });
        // Trusted: a non-owner the owner listed for this messenger; the list's name, when it gives one, labels them.
        const trust = owner ? undefined : talk.trusted.find((t) => t.source === config.source && t.id === m.from);
        const sender: Sender = owner
          ? { ...m.sender, kind: "owner" }
          : trust
            ? { kind: "trusted", id: m.from, ...(trust.name !== undefined ? { name: trust.name } : m.sender.name !== undefined ? { name: m.sender.name } : {}) }
            : m.sender.kind === "owner" || m.sender.kind === "trusted"
              ? { ...m.sender, kind: "person" }
              : m.sender;
        // A trusted bot is still a bot: its messages count toward the agent-loop guard.
        const agent = m.sender.kind === "agent";
        const conversation = conversationKey(m.chat, m.thread);
        let loopStopped: number | undefined;
        const run = (agentRun.get(conversation) ?? 0) + 1;
        if (agent && run > talk.agentTurnLimit + 1) return emit({ ev: "dropped", id: m.id, from: m.from });
        if (agent && run > talk.agentTurnLimit) loopStopped = talk.agentTurnLimit;
        const row: MessengerRow = {
          id: m.id,
          kind: "messenger",
          source: m.source,
          chat: m.chat,
          ...(m.thread !== undefined ? { thread: m.thread } : {}),
          from: m.from,
          sender,
          at: m.at,
          text: loopStopped === undefined
            ? m.text
            : `agent loop stopped: ${loopStopped} agent messages in a row here with no human message between; this one and further agent messages in this conversation are not delivered until a person writes`,
          ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}),
          ...(agent ? { agent: true as const } : {}),
          ...(loopStopped !== undefined ? { loopStopped } : {}),
        };
        const stored = channel.appendInbound(row);
        // A human message resets the count only when it is new: a replayed one must not restart a stopped loop.
        if (stored && !agent) agentRun.delete(conversation);
        if (stored && agent) remember(conversation, run);
        emit({ ev: stored ? "stored" : "duplicate", id: m.id });
        // A message got through, so receive works: end any failure streak at once.
        if (failing) {
          failing = false;
          clearHealth(root, config.source);
        }
      };
      // Failures recorded under another messengers.json are not this config's: start a fresh attempt.
      const before = readHealth(root, config.source);
      if (before && before.config !== stamp) clearHealth(root, config.source);
      let failing = before?.config === stamp;
      while (!signal.aborted) {
        // A run that stays up HEALTHY_AFTER_MS ends a failure streak; a crash before that extends it.
        const healthy = setTimeout(() => {
          failing = false;
          clearHealth(root, config.source);
        }, HEALTHY_AFTER_MS);
        let delay = restartDelayMs;
        try {
          await adapterFor(config, root).receive(signal, onMessage);
          if (signal.aborted) break;
          emit({ ev: "error", source: config.source, detail: `receive returned early; restarting in ${delay} ms` });
        } catch (e) {
          if (signal.aborted) break;
          const health = recordFailure(root, config.source, now(), errorText(e), stamp);
          failing = true;
          delay = restartDelay(restartDelayMs, health.failures);
          emit({ ev: "error", source: config.source, detail: `${errorText(e)}; restarting in ${delay} ms` });
        } finally {
          clearTimeout(healthy);
        }
        await sleep(delay, signal);
      }
    };

    // Waits for the abort itself, not just the loops: with no messengers the daemon still keeps its heartbeat up.
    const aborted = Promise.withResolvers<void>();
    if (signal.aborted) aborted.resolve();
    else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await Promise.all([...messengers.map(runOne), aborted.promise]);
  } finally {
    stopHeartbeat();
    opts.signal?.removeEventListener("abort", onAbort);
    // Stopped before the lock is released, so a restarted daemon never runs a watch's command alongside this one's.
    await engine?.stop();
    release();
  }
  return exit;
}
