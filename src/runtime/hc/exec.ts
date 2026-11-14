// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// One `hc --json` call: the core is the one the env names (HC_SESSION, XDG_RUNTIME_DIR, HC_TERMINAL_SOCKET; hc has no
// --session flag), the result is hc's JSON.
import type { Exec, ExecResult } from "../exec.ts";
import { ToolError } from "../exec.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** Exit codes per error kind (hc's rpc table), read only when stderr carries no JSON. */
const KIND_BY_EXIT: Readonly<Record<number, string>> = {
  2: "usage",
  3: "not_found",
  4: "machine_unknown",
  5: "unavailable",
  6: "invalid_params",
  7: "needs_target",
  8: "config",
  9: "blocked",
  10: "status_mismatch",
  11: "finished",
};

/**
 * An `hc` call that exited non-zero. `kind` is hc's stable error kind (not_found, blocked, status_mismatch, live, ...),
 * `reason` its message. The message and `argv` never carry a redacted value (the delivered text).
 */
export class HcError extends ToolError {
  override readonly name = "HcError";

  constructor(
    argv: readonly string[],
    result: ExecResult,
    readonly kind: string | undefined,
    readonly hint: string | undefined,
    readonly reason: string,
  ) {
    super(argv, result, "hc");
    this.message = `hc ${argv.join(" ")} failed (${result.code})${kind === undefined ? "" : ` ${kind}`}: ${reason}`;
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** hc's error JSON from a failed call: `{error:{kind,message,hint}}` on stderr (or stdout), else whatever it printed. */
const errorJson = (result: ExecResult): Record<string, unknown> => {
  const raw = result.stderr.trim() || result.stdout.trim();
  try {
    return asRecord(asRecord(JSON.parse(raw))["error"]);
  } catch {
    // Not JSON: an old or broken hc, or the process died; fall back to the exit code.
    return {};
  }
};

/**
 * hc's own message from a failed call: its JSON `error.message`, else its raw output, else "no output". A caller that
 * reports a failure to a human wants this, not the JSON envelope around it.
 */
export function hcReason(result: ExecResult): string {
  const raw = result.stderr.trim() || result.stdout.trim();
  return str(errorJson(result)["message"]) ?? (raw || "no output");
}

function errorOf(argv: readonly string[], result: ExecResult): HcError {
  const error = errorJson(result);
  const kind = str(error["kind"]) ?? KIND_BY_EXIT[result.code];
  const hint = str(error["hint"]) ?? str(asRecord(error["data"])["hint"]);
  return new HcError(argv, result, kind, hint, hcReason(result));
}

/**
 * Runs `hc` with exactly `env` (the binary is looked up on env.PATH), so one process can address a core other than
 * the one it runs in: tests point it at an isolated core or a fake `hc` without touching process.env.
 */
export function envExec(env: Env): Exec {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return async (cmd, argv) => {
    const bin = Bun.which(cmd, { PATH: clean["PATH"] ?? "" }) ?? cmd;
    const proc = Bun.spawn([bin, ...argv], { env: clean, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };
}

export type HcCallOptions = { readonly redact?: string };

export async function hcCall(
  exec: Exec,
  argv: readonly string[],
  options: HcCallOptions = {},
): Promise<Record<string, unknown>> {
  const full = ["--json", ...argv];
  const result = await exec("hc", full);
  if (result.code !== 0) {
    const shown = options.redact === undefined ? full : full.map((a) => (a === options.redact ? "<text>" : a));
    throw errorOf(shown, result);
  }
  const text = result.stdout.trim();
  return text === "" ? {} : asRecord(JSON.parse(text));
}

export const isKind = (e: unknown, ...kinds: readonly string[]): e is HcError =>
  e instanceof HcError && e.kind !== undefined && kinds.includes(e.kind);
