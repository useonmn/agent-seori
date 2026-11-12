import { closeSync, fsyncSync, openSync, statSync } from "node:fs";

// What is POSIX-specific (Linux and macOS), in one place: which sh runs shell commands, directory fsync and who may read a file.

/**
 * The sh that runs watch commands and the daemon loop's tests. SEORI_SH wins; then sh on PATH. Plain "sh" when none is
 * found, so the spawn error names it.
 */
export function shPath(
  env: Record<string, string | undefined> = process.env,
  which: (bin: string) => string | null = (bin) => Bun.which(bin),
): string {
  if (env["SEORI_SH"]) return env["SEORI_SH"];
  return which("sh") ?? "sh";
}

/** fsyncs a directory so a new entry in it survives a crash. */
export function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Why a secrets file is readable by more than its owner (any group or other mode bit), or undefined when it is not. */
export function readableByOthers(path: string): string | undefined {
  return (statSync(path).mode & 0o077) !== 0 ? `${path} must not be readable by others (chmod 600 ${path})` : undefined;
}
