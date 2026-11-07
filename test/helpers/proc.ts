import { type ChildProcess, spawn } from "node:child_process";
import { IS_WINDOWS, killTreeWindows, shPath, treeOf, windowsProcesses } from "../../src/platform.ts";

/** `sh -c command` in its own process group (Windows: its own process tree), as the watch engine starts a command. */
export const spawnGroup = (command: string): ChildProcess =>
  spawn(shPath(), ["-c", command], { detached: !IS_WINDOWS, windowsHide: true, stdio: "ignore" });

/** Whether the group (Windows: the tree of processes started since `since`) still has a live process. */
export async function groupAlive(pgid: number, since: number): Promise<boolean> {
  if (IS_WINDOWS) return treeOf(await windowsProcesses(pgid), pgid, since).length > 0;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills a group spawnGroup started: on Windows the whole tree, as killing sh alone leaves its children running. */
export async function killGroupNow(child: ChildProcess, since: number): Promise<void> {
  if (IS_WINDOWS) await killTreeWindows(child.pid!, since);
  else child.kill("SIGKILL");
}

/**
 * Shell text for the OS pid of the last background job. Git for Windows' sh reports its own pids in `$!`; the Windows
 * pid that process.kill knows is in /proc/<pid>/winpid there.
 */
export const BG_PID = "$( [ -r /proc/$!/winpid ] && cat /proc/$!/winpid || echo $! )";
