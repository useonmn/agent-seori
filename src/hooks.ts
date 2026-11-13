import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.ts";
import type { Deps } from "./harness.ts";

// Ported from dori-superagent src/hooks.ts (a0372dd, MIT), adapted to seori's config.ts ConfigError and names.

/** An argv template: element 0 is the command; placeholders are substituted per element and never shell-expanded. */
export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly onReady?: ArgvTemplate;
  readonly onReport?: ArgvTemplate;
  readonly onLost?: ArgvTemplate;
  /** Runs once when a lane closes with a known reading: `{key}`, `{tokens}`, `{cost}`, `{closeKey}` (off unless set). */
  readonly recordCost?: ArgvTemplate;
  /** Speech to text: `{file}` is an audio file path; the command prints the transcript on stdout. */
  readonly transcribe?: ArgvTemplate;
};

export type HookName = keyof Hooks;
export type HookVars = Partial<Record<"key" | "text" | "evidence" | "file" | "tokens" | "cost" | "closeKey", string>>;

const NAMES: readonly HookName[] = ["onReady", "onReport", "onLost", "recordCost", "transcribe"];

function template(name: string, value: unknown): ArgvTemplate {
  if (!Array.isArray(value) || value.length === 0)
    throw new ConfigError(`config.json: hooks.${name} must be a non-empty array of strings (an argv template)`);
  const argv: string[] = [];
  for (const element of value) {
    if (typeof element !== "string")
      throw new ConfigError(`config.json: hooks.${name} must contain only strings, got ${JSON.stringify(element)}`);
    argv.push(element);
  }
  return argv;
}

/** Reads `hooks` from `<root>/config.json`. No file or no `hooks` key = no hooks; other keys are loadConfig's business. */
export function loadHooks(root: string): Hooks {
  const path = join(root, "config.json");
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`config.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ConfigError("config.json must be a JSON object");
  const raw: unknown = Reflect.get(parsed, "hooks");
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("config.json: hooks must be an object");
  // The reviewer is always omp (src/agent/profile.ts): seori never runs another agent, so no hook replaces it.
  if (Object.hasOwn(raw, "reviewCommand"))
    throw new ConfigError("config.json: hooks.reviewCommand is not supported: the reviewer is always omp");
  for (const k of Object.keys(raw))
    if (!(NAMES as readonly string[]).includes(k))
      throw new ConfigError(`config.json: hooks: unknown hook "${k}" (known: ${NAMES.join(", ")})`);
  const hooks: { -readonly [K in HookName]?: ArgvTemplate } = {};
  for (const name of NAMES) {
    const value: unknown = Reflect.get(raw, name);
    if (value !== undefined) hooks[name] = template(name, value);
  }
  return hooks;
}

/** Substitutes `{key}`, `{text}`, `{evidence}`, `{file}`, `{tokens}`, `{cost}`, `{closeKey}` inside each element. */
export function substitute(argv: ArgvTemplate, vars: HookVars): string[] {
  return argv.map((element) =>
    element.replace(/\{(key|text|evidence|file|tokens|cost|closeKey)\}/g, (whole, k: keyof HookVars) => vars[k] ?? whole),
  );
}

const pending = new Map<Promise<void>, HookName>();

/** How long the CLI waits for hooks still running at exit; a slower hook is reported as timed out and left behind. */
export const HOOK_SETTLE_MS = 2000;

/**
 * Resolves once every hook started so far has finished, or after `ms`: a hook that hangs never keeps a command from
 * exiting (one `timed out` line per hook still running). The CLI awaits it before exiting.
 */
export async function hooksSettled(ms: number = HOOK_SETTLE_MS): Promise<void> {
  if (pending.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const outcome = await Promise.race([Promise.all([...pending.keys()]).then(() => "done" as const), deadline]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    for (const name of pending.values()) process.stderr.write(`seori: hook ${name} failed (timed out after ${ms} ms)\n`);
  }
}

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

/**
 * Runs a lifecycle hook fire-and-forget: the caller never waits for it and it never throws. A bad config, a spawn
 * error or a non-zero exit writes one stderr line. The returned promise is only for callers that want to await it.
 */
export function runHook(d: Deps, name: Exclude<HookName, "transcribe">, vars: HookVars): Promise<void> {
  const fail = (why: string) => {
    process.stderr.write(`seori: hook ${name} failed (${why})\n`);
  };
  const run = async (): Promise<void> => {
    try {
      const argv = loadHooks(d.store.root)[name];
      if (!argv) return;
      const [cmd, ...rest] = substitute(argv, vars);
      if (cmd === undefined) return;
      const res = await d.exec(cmd, rest);
      if (res.code !== 0) fail(firstLine(res.stderr) || `exit ${res.code}`);
    } catch (e) {
      fail(firstLine(e instanceof Error ? e.message : String(e)));
    }
  };
  const p = run();
  pending.set(p, name);
  void p.finally(() => pending.delete(p));
  return p;
}
