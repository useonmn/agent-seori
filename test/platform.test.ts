import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fsyncDir, jobFor, shPath, treeOf, type ProcInfo } from "../src/platform.ts";

describe("shPath", () => {
  const none = () => null;
  test("SEORI_SH wins, then sh on PATH", () => {
    expect(shPath({ SEORI_SH: "/opt/sh" }, "linux", () => "/bin/sh")).toBe("/opt/sh");
    expect(shPath({}, "darwin", (b) => (b === "sh" ? "/bin/sh" : null))).toBe("/bin/sh");
  });

  test("Windows with only Git's cmd folder on PATH finds Git for Windows' bin\\sh.exe", () => {
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    const sh = win32.join("C:\\Program Files\\Git", "bin", "sh.exe");
    expect(shPath({}, "win32", (b) => (b === "git" ? git : null), (p) => p === sh)).toBe(sh);
    expect(shPath({}, "win32", none, () => false)).toBe("sh");
    expect(shPath({}, "linux", none, () => true)).toBe("sh");
  });
});

describe("treeOf (Windows process trees)", () => {
  const p = (pid: number, ppid: number, startMs: number): ProcInfo => ({ pid, ppid, startMs });

  test("the root and its descendants started since the spawn; a root that already exited still leads to its children", () => {
    const procs = [p(10, 1, 100), p(11, 10, 110), p(12, 11, 120), p(20, 1, 50)];
    expect(treeOf(procs, 10, 100).sort()).toEqual([10, 11, 12]);
    expect(treeOf(procs.filter((x) => x.pid !== 10), 10, 100).sort()).toEqual([11, 12]);
  });

  test("processes older than the spawn are not ours (a reused pid), nor is anything below them", () => {
    const procs = [p(10, 1, 100), p(11, 10, 90), p(12, 11, 120)];
    expect(treeOf(procs, 10, 100)).toEqual([10]);
    expect(treeOf(procs, 10, 200)).toEqual([]);
  });
});

test("fsyncDir skips Windows, where a directory cannot be opened for fsync (EPERM)", () => {
  expect(() => fsyncDir(join(tmpdir(), "no-such-dir-seori"), "win32")).not.toThrow();
  if (process.platform !== "win32") expect(() => fsyncDir(tmpdir())).not.toThrow();
});

test.if(process.platform === "win32")("on Windows a Job Object ends sh's background job, whose parent pid leads nowhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seori-job-"));
  const pidFile = join(dir, "bg.pid").replaceAll("\\", "/");
  const sh = spawn(shPath(), ["-c", `sleep 30 & echo $( [ -r /proc/$!/winpid ] && cat /proc/$!/winpid || echo $! ) > '${pidFile}'; wait`], { stdio: "ignore", windowsHide: true });
  const job = jobFor(sh.pid!);
  expect(job).toBeDefined();
  const exited = new Promise((resolve) => sh.once("exit", resolve));
  const deadline = Date.now() + 10_000;
  while (!(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()) && Date.now() < deadline) await Bun.sleep(10);
  const bg = Number(readFileSync(pidFile, "utf8").trim());
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive(bg)).toBe(true);
  job!.kill();
  job!.close();
  await exited;
  expect(alive(bg)).toBe(false);
});
