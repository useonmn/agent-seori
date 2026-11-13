import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RuntimeKind } from "./types.ts";

// Which runtime new sessions open on. Not wired into the harness yet: seori opens every session on herdr until the hc
// adapter lands (src/runtime/index.ts).

export type RuntimeSource = "env" | "config" | "detect:HC_TERMINAL_ID" | "detect:HERDR_PANE_ID" | "detect:path";
export type RuntimeChoice = { readonly kind: RuntimeKind; readonly source: RuntimeSource };

/** No runtime could be chosen; the message is the one-line fix. */
export class RuntimeChoiceError extends Error {}
/** A runtime setting that is present but unusable (bad value, unreadable config file). */
export class RuntimeConfigError extends Error {}

const KINDS: readonly RuntimeKind[] = ["herdr", "hc"];
const isKind = (value: unknown): value is RuntimeKind => KINDS.some((k) => k === value);

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const nonEmpty = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value);

function configRuntime(configPath: string): RuntimeKind | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return undefined;
    throw new RuntimeConfigError(`cannot read ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new RuntimeConfigError(`${configPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RuntimeConfigError(`${configPath} must hold a JSON object`);
  if (!("runtime" in parsed)) return undefined;
  const value: unknown = parsed.runtime;
  if (!isKind(value)) throw new RuntimeConfigError(`${configPath}: "runtime" must be "herdr" or "hc", got ${JSON.stringify(value)}`);
  return value;
}

function onPath(pathVar: string | undefined, exists: (path: string) => boolean): RuntimeKind[] {
  const dirs = (pathVar ?? "").split(delimiter).filter((dir) => dir !== "");
  return KINDS.filter((kind) => dirs.some((dir) => exists(join(dir, kind))));
}

/**
 * Which runtime new sessions open on, and why. Precedence: `SEORI_RUNTIME` > the config file's `runtime` key >
 * `HC_TERMINAL_ID` (inside an hc terminal) > `HERDR_PANE_ID` (inside a herdr pane) > the one runtime binary on PATH.
 * Both binaries or neither, with nothing else set, is refused: guessing would open sessions where nobody looks.
 */
export function readRuntimeChoice(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configPath: string;
  readonly exists?: (path: string) => boolean;
}): RuntimeChoice {
  const { env, configPath } = options;
  const fromEnv = nonEmpty(env["SEORI_RUNTIME"]);
  if (fromEnv !== undefined) {
    if (!isKind(fromEnv)) throw new RuntimeConfigError(`SEORI_RUNTIME must be "herdr" or "hc", got ${JSON.stringify(fromEnv)}`);
    return { kind: fromEnv, source: "env" };
  }
  const fromConfig = configRuntime(configPath);
  if (fromConfig !== undefined) return { kind: fromConfig, source: "config" };
  if (nonEmpty(env["HC_TERMINAL_ID"]) !== undefined) return { kind: "hc", source: "detect:HC_TERMINAL_ID" };
  if (nonEmpty(env["HERDR_PANE_ID"]) !== undefined) return { kind: "herdr", source: "detect:HERDR_PANE_ID" };
  const found = onPath(env["PATH"], options.exists ?? isExecutableFile);
  const [only] = found;
  if (found.length === 1 && only !== undefined) return { kind: only, source: "detect:path" };
  const why = found.length === 0 ? "neither herdr nor hc is on PATH" : "both herdr and hc are on PATH";
  throw new RuntimeChoiceError(`${why}: set "runtime": "herdr" or "hc" in ${configPath}, or SEORI_RUNTIME`);
}
