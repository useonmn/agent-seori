import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatPath } from "./daemon.ts";
import { Refusal } from "./harness.ts";
import type { InboundMessage, MessengerAdapter, MessengerConfig } from "./messenger/adapter.ts";
import { DiscordAdapter } from "./messenger/discord.ts";
import { FakeAdapter } from "./messenger/fake.ts";
import { SlackAdapter } from "./messenger/slack.ts";
import { TelegramAdapter } from "./messenger/telegram.ts";

// `seori msg pair <source>`: owner pairing during setup. The owner sends the bot a direct message; seori runs the
// messenger's own receive in pairing mode (any non-bot sender's new direct message passes, see the adapters' `pairing`
// option), prints one CANDIDATE line per sender, and with --write records that sender as the source's `owner` in
// messengers.json. Pairing mode is a constructor option only this module passes: messengers.json cannot ask for it, so
// the daemon never accepts strangers. The adapter keeps its cursor in a throwaway directory seeded from the daemon's
// cursor, so pairing never moves the position the daemon resumes from (skipped messages still reach the lead later).

/** Messengers pairing can run for (the `source` names the platform, as in messengers.json). */
export const PAIR_SOURCES: readonly string[] = ["telegram", "slack", "discord", "fake"];

export const DEFAULT_PAIR_MINUTES = 10;

/**
 * Messages sent this long before pairing started still count (the owner may write before running the command); older
 * ones are ignored, so a stranger's stale direct message still queued at the platform never becomes the owner.
 */
export const PAIR_LOOKBACK_MS = 2 * 60_000;

/**
 * A daemon heartbeat younger than this means the daemon is running. The daemon writes one every 5 s (daemon.ts
 * HEARTBEAT_MS); this is shorter than duty's outage threshold so a just-stopped daemon does not block pairing for long.
 */
export const PAIR_HEARTBEAT_FRESH_MS = 30_000;

export type PairOptions = {
  /** How long to wait for a message; default DEFAULT_PAIR_MINUTES. */
  readonly minutes?: number;
  /** Record the first candidate as the source's owner in messengers.json. */
  readonly write?: boolean;
  /** Keep listening for the whole window and report every sender, not just the first. */
  readonly all?: boolean;
  /**
   * Telegram only: pair even though messengers.json already names an owner. Telegram confirms updates server-side once
   * a later offset is polled, so the owner's messages queued while the daemon was stopped are dropped by pairing.
   */
  readonly force?: boolean;
};

/** One sender seen during pairing: `id` is what messengers.json's `owner` takes. */
export type PairCandidate = { readonly source: string; readonly id: string; readonly chat: string; readonly text: string; readonly at: number };

export type PairDeps = {
  readonly now: () => number;
  /**
   * Builds the adapter in pairing mode with its cursor under `cursorRoot` (a temp dir, never the daemon's); default
   * pairingAdapter. Tests swap in fakes.
   */
  readonly adapterFor?: (config: MessengerConfig, root: string, cursorRoot: string) => MessengerAdapter;
  /** Called once per new candidate as it arrives, so the CLI can print it at once (an --all run lasts minutes). */
  readonly onCandidate?: (c: PairCandidate) => void;
  /** Aborting ends the wait early (Ctrl-C); candidates seen so far are returned. */
  readonly signal?: AbortSignal;
};

/** The messenger's adapter with pairing mode on and its cursor under `cursorRoot`; never used by the daemon. */
export function pairingAdapter(config: MessengerConfig, root: string, cursorRoot: string): MessengerAdapter {
  switch (config.source) {
    case "telegram":
      return new TelegramAdapter(config, root, { pairing: true, cursorRoot });
    case "slack":
      return new SlackAdapter(config, root, { pairing: true, cursorRoot });
    case "discord":
      return new DiscordAdapter(config, root, { pairing: true, cursorRoot });
    case "fake": {
      // Files only, no bots and no direct-message notion: every row is a sender.
      const pollMs = config.options?.["pollMs"];
      return new FakeAdapter(root, { cursorRoot, ...(typeof pollMs === "number" ? { pollMs } : {}) });
    }
    default:
      throw new Refusal(`messenger ${config.source} is not supported; pairing works for ${PAIR_SOURCES.join(", ")}`);
  }
}

/**
 * A temp dir holding a copy of the daemon's cursor for `source` (when there is one: `offset` for fake, `cursor.json`
 * otherwise), so the pairing adapter starts where the daemon would and its saves land in the copy.
 */
function throwawayCursorRoot(root: string, source: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "seori-pair-cursor-"));
  const name = source === "fake" ? "offset" : "cursor.json";
  const real = join(root, "messenger", source, name);
  if (existsSync(real)) {
    mkdirSync(join(tmp, "messenger", source), { recursive: true });
    copyFileSync(real, join(tmp, "messenger", source, name));
  }
  return tmp;
}

/** `CANDIDATE <source> id=<sender id> chat=<chat> text="<first 40 characters>"`, one line whatever the text holds. */
export function candidateLine(c: PairCandidate): string {
  return `CANDIDATE ${c.source} id=${c.id} chat=${c.chat} text=${JSON.stringify(Array.from(c.text).slice(0, 40).join(""))}`;
}

/** What `seori msg pair --write` prints after recording the owner. */
export function pairedLine(root: string, source: string, owner: string): string {
  return `PAIRED ${source} owner=${owner} in ${messengersPath(root)}; a running seori daemon restarts on the change`;
}

const messengersPath = (root: string): string => join(root, "messengers.json");

type MessengersFile = { messengers: Record<string, unknown>[]; [key: string]: unknown };

/** messengers.json as written (unknown fields kept), or an empty one when missing. A damaged file is an Error. */
function readMessengersFile(root: string): MessengersFile {
  const path = messengersPath(root);
  if (!existsSync(path)) return { messengers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: not valid JSON (${(e as Error).message}); fix or remove it, then pair again`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path}: must be a JSON object`);
  const file = parsed as Record<string, unknown>;
  if (file["messengers"] === undefined) return { ...file, messengers: [] };
  if (!Array.isArray(file["messengers"]) || file["messengers"].some((m) => typeof m !== "object" || m === null || Array.isArray(m)))
    throw new Error(`${path}: "messengers" must be an array of objects`);
  return file as MessengersFile;
}

/** The one entry for `source`; two entries are ambiguous and refused. */
function entryFor(root: string, file: MessengersFile, source: string): Record<string, unknown> | undefined {
  const entries = file.messengers.filter((m) => m["source"] === source);
  if (entries.length > 1) throw new Refusal(`${messengersPath(root)} has ${entries.length} "${source}" entries; keep one, then pair again`);
  return entries[0];
}

/**
 * Sets `owner` of the `source` entry in messengers.json (adding the entry when missing, creating the file when there is
 * none), keeping every other entry, field and option. Renamed into place, so the daemon never reads a torn file; its
 * stamp check then restarts it on the new config.
 */
export function writeOwner(root: string, source: string, owner: string): void {
  const file = readMessengersFile(root);
  const entry = entryFor(root, file, source);
  const messengers = entry ? file.messengers.map((m) => (m === entry ? { ...m, owner } : m)) : [...file.messengers, { source, owner }];
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = messengersPath(root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...file, messengers }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Age of the daemon heartbeat in ms, or undefined when there is none. */
function heartbeatAge(root: string, now: number): number | undefined {
  try {
    const beat = JSON.parse(readFileSync(heartbeatPath(root), "utf8")) as { at?: unknown };
    return typeof beat.at === "number" ? now - beat.at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Waits up to `opts.minutes` for direct messages to the `source` bot and returns one candidate per non-bot sender, in
 * arrival order: just the first unless `opts.all`. With `opts.write` the first candidate becomes the source's owner in
 * messengers.json (writeOwner). Refuses an unsupported source, a bad window, `write` with `all` (which sender would be
 * written is unclear), and a source already in messengers.json while the daemon runs: the daemon reads that bot too,
 * and two readers fight (Telegram answers the second getUpdates with 409). A Telegram entry that already names an owner
 * is refused unless `opts.force`: Telegram confirms updates server-side, so pairing would drop that owner's queued
 * messages. No message within the window is a Refusal.
 * Messages older than PAIR_LOOKBACK_MS before the start and edits are ignored. A failing receive (bad token, 409)
 * rejects with the adapter's error.
 */
export async function pairOwner(root: string, source: string, opts: PairOptions, deps: PairDeps): Promise<PairCandidate[]> {
  if (!PAIR_SOURCES.includes(source)) throw new Refusal(`messenger ${source} is not supported; pairing works for ${PAIR_SOURCES.join(", ")}`);
  const minutes = opts.minutes ?? DEFAULT_PAIR_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Refusal(`--minutes must be a positive number, got ${minutes}`);
  if (opts.write && opts.all) throw new Refusal("--write records the first sender; run without --all to write, or with --all to only list senders");

  const start = deps.now();
  const entry = entryFor(root, readMessengersFile(root), source);
  const age = heartbeatAge(root, start);
  if (entry && age !== undefined && age <= PAIR_HEARTBEAT_FRESH_MS)
    throw new Refusal(
      `${messengersPath(root)} already has "${source}" and the seori daemon is running (heartbeat ${Math.max(0, Math.round(age / 1000))} s ago), so it reads this bot too and two readers conflict (Telegram answers 409). Pair before adding the "${source}" entry, or stop the daemon and pair again`,
    );
  const owner = entry?.["owner"];
  if (source === "telegram" && typeof owner === "string" && owner !== "" && !opts.force)
    throw new Refusal(
      `${messengersPath(root)} already has "telegram" with owner ${owner}. Telegram confirms updates once pairing reads past them, so messages queued for the daemon (sent while it was stopped) would be dropped. Let the daemon deliver them first, or pass --force to pair anyway`,
    );

  const options = entry?.["options"];
  const config: MessengerConfig = {
    source,
    owner: "",
    ...(typeof options === "object" && options !== null && !Array.isArray(options) ? { options: options as Record<string, unknown> } : {}),
  };
  const cursorRoot = throwawayCursorRoot(root, source);
  let adapter: MessengerAdapter;
  try {
    adapter = (deps.adapterFor ?? pairingAdapter)(config, root, cursorRoot);
  } catch (e) {
    rmSync(cursorRoot, { recursive: true, force: true });
    throw e;
  }

  const candidates: PairCandidate[] = [];
  const stop = new AbortController();
  const onOuterAbort = () => stop.abort();
  if (deps.signal?.aborted) stop.abort();
  else deps.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => stop.abort(), minutes * 60_000);
  const onMessage = async (m: InboundMessage): Promise<void> => {
    if (stop.signal.aborted || m.id.includes(":edit:") || m.at < start - PAIR_LOOKBACK_MS) return;
    if (!m.from || candidates.some((c) => c.id === m.from)) return;
    const c: PairCandidate = { source, id: m.from, chat: m.chat, text: m.text, at: m.at };
    candidates.push(c);
    deps.onCandidate?.(c);
    if (!opts.all) stop.abort();
  };
  try {
    await adapter.receive(stop.signal, onMessage);
    if (!stop.signal.aborted) throw new Error(`${source}: receive stopped before pairing finished; run seori msg pair again`);
  } catch (e) {
    // An error raised while shutting down after the abort is not a pairing failure.
    if (!stop.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onOuterAbort);
    rmSync(cursorRoot, { recursive: true, force: true });
  }

  if (candidates.length === 0) {
    if (deps.signal?.aborted) return candidates;
    throw new Refusal(`no direct message reached the ${source} bot in ${minutes} min; send the bot a direct message from the owner's account while seori msg pair runs`);
  }
  if (opts.write) writeOwner(root, source, candidates[0]!.id);
  return candidates;
}
