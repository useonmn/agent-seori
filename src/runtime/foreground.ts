export const SHELLS: ReadonlySet<string> = new Set([
  "sh", "ash", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "busybox",
]);
const baseName = (value: unknown): string => String(value ?? "").replace(/^-/, "").split("/").pop()!.toLowerCase();
// A shell runs a command (not a prompt) only with an explicit command flag: -c, also inside combined short flags such
// as -lc. Any other operand (a script path, --rcfile FILE, -o OPT) stays held.
const runsCommand = (arg: string): boolean => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg);

/**
 * True when the process info (`{ foreground_processes: [{ name, argv }] }`, herdr's `pane process-info` shape) shows an
 * interactive shell in the session's foreground process group, or cannot be read. An agent suspended with Ctrl+Z is
 * still reported `idle` while its shell is in front (#66). A shell that runs a command flag (`sh -c ...`) is an agent's
 * child, not a prompt, and does not count; any other shell, a script runner such as `bash script.sh` included, is held.
 */
export function interactiveShellInFront(processInfo: unknown): boolean {
  const procs = (processInfo as { foreground_processes?: unknown } | undefined)?.foreground_processes;
  if (!Array.isArray(procs) || procs.length === 0) return true;
  for (const proc of procs as { name?: unknown; argv?: unknown }[]) {
    let name = baseName(proc?.name);
    let args = Array.isArray(proc?.argv) ? proc.argv.map(String).slice(1) : undefined;
    if (name === "busybox" && args && args.length > 0) [name, args] = [baseName(args[0]), args.slice(1)];
    if (!SHELLS.has(name)) continue;
    if (args === undefined) return true;
    if (!args.some(runsCommand)) return true;
  }
  return false;
}
