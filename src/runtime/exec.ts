// One injectable process runner shared by every runtime adapter, so tests replace the runtime binary with a recorder
// and end-to-end tests point it at an isolated session.

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
/**
 * `onSpawn` gets the running process, so a caller that gives up on it can kill it. `env` is added to seori's own
 * environment for that process. `detached` runs it in a session of its own: it has no terminal to prompt on (ssh
 * asking for a passphrase or a host key fails at once), and kill() ends its whole process group, children included.
 */
export type ExecOptions = {
  readonly onSpawn?: (proc: { kill(): void }) => void;
  readonly env?: Readonly<Record<string, string>>;
  readonly detached?: boolean;
};
export type Exec = (cmd: string, argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

export const spawnExec: Exec = async (cmd, argv, options) => {
  const proc = Bun.spawn([cmd, ...argv], {
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
    ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
    ...(options?.detached ? { detached: true } : {}),
  });
  options?.onSpawn?.(options.detached
    ? {
      kill: () => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      },
    }
    : proc);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/**
 * A runtime CLI call that exited non-zero; the message carries the tool, its argv and the tool's own reason. Callers
 * that report a failure use `result` (the tool's own output), never the message: argv may carry a delivered text.
 */
export class ToolError extends Error {
  constructor(readonly argv: readonly string[], readonly result: ExecResult, tool: string) {
    super(`${tool} ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

/** POSIX single-quote shell quoting. */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
