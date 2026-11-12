import { type ChildProcess, spawn } from "node:child_process";
import { shPath } from "../../src/platform.ts";

/** `sh -c command` in its own process group, as the watch engine starts a command. */
export const spawnGroup = (command: string): ChildProcess => spawn(shPath(), ["-c", command], { detached: true, stdio: "ignore" });

/** Whether the group still has a live process. */
export async function groupAlive(pgid: number): Promise<boolean> {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills a group spawnGroup started. */
export async function killGroupNow(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
}

/** Shell text for the pid of the last background job. */
export const BG_PID = "$!";
