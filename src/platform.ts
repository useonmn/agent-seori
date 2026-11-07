import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, statSync } from "node:fs";
import { win32 } from "node:path";

// What differs between macOS/Linux and Windows, in one place: which sh runs shell commands, process trees (Windows
// has no process groups), directory fsync and who may read a file.

export const IS_WINDOWS = process.platform === "win32";

/**
 * The sh that runs watch commands and the daemon loop's tests. SEORI_SH wins; then sh on PATH; on Windows then Git for
 * Windows' own sh (a default Git install puts only its `cmd` directory on PATH). Plain "sh" when none is found, so the
 * spawn error names it.
 */
export function shPath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  which: (bin: string) => string | null = (bin) => Bun.which(bin),
  exists: (path: string) => boolean = existsSync,
): string {
  if (env["SEORI_SH"]) return env["SEORI_SH"];
  const onPath = which("sh");
  if (onPath) return onPath;
  if (platform === "win32") {
    const git = which("git");
    if (git) {
      // ...\Git\cmd\git.exe or ...\Git\mingw64\bin\git.exe: bin\sh.exe sets up PATH for the coreutils it runs.
      // win32 path rules whatever the host, so the logic is the same when tested on macOS/Linux.
      const { dirname, join } = win32;
      for (const root of [dirname(dirname(git)), dirname(dirname(dirname(git)))]) {
        for (const sh of [join(root, "bin", "sh.exe"), join(root, "usr", "bin", "sh.exe")]) if (exists(sh)) return sh;
      }
    }
  }
  return "sh";
}

/**
 * fsyncs a directory so a new entry in it survives a crash. Windows cannot open a directory for fsync (EPERM); NTFS
 * journals the metadata itself, so there it is skipped.
 */
export function fsyncDir(path: string, platform: string = process.platform): void {
  if (platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export type ProcInfo = { readonly pid: number; readonly ppid: number; readonly startMs: number };

/** Windows PowerShell 5.1 started from pwsh 7 inherits pwsh's PSModulePath and then cannot load its own modules. */
const powershellEnv = (): Record<string, string | undefined> => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === "psmodulepath") delete env[k];
  return env;
};

const LIST_PROCESSES =
  "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { " +
  "'{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }";

async function processesByPowerShell(): Promise<ProcInfo[]> {
  const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", LIST_PROCESSES], { env: powershellEnv(), stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.split(/\r?\n/).flatMap((line) => {
    const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), startMs: Number(m[3]) }] : [];
  });
}

/** FILETIME (100 ns since 1601) to Unix ms. */
const FILETIME_UNIX_MS = 11_644_473_600_000;

/**
 * A Toolhelp snapshot of every process and its parent, through kernel32 (bun:ffi): milliseconds, where PowerShell's
 * CIM takes over a second. Start times (GetProcessTimes) are read only for `root` and its descendants when a root is
 * given; others report 0, which treeOf never counts as started after a spawn.
 */
async function processesByToolhelp(root?: number): Promise<ProcInfo[]> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const k32 = dlopen("kernel32.dll", {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
    Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  try {
    const k = k32.symbols;
    const TH32CS_SNAPPROCESS = 2;
    const snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (!snap) throw new Error("CreateToolhelp32Snapshot failed");
    // PROCESSENTRY32W on x64: dwSize at 0, th32ProcessID at 8, th32ParentProcessID at 32; 568 bytes in all.
    const entry = Buffer.alloc(568);
    entry.writeUInt32LE(entry.length, 0);
    const pairs: { pid: number; ppid: number }[] = [];
    try {
      for (let ok = k.Process32FirstW(snap, ptr(entry)); ok; ok = k.Process32NextW(snap, ptr(entry))) {
        pairs.push({ pid: entry.readUInt32LE(8), ppid: entry.readUInt32LE(32) });
      }
    } finally {
      k.CloseHandle(snap);
    }
    if (pairs.length === 0) throw new Error("Process32FirstW found no processes");
    let wanted: Set<number> | undefined;
    if (root !== undefined) {
      wanted = new Set([root]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of pairs) if (wanted.has(p.ppid) && !wanted.has(p.pid)) { wanted.add(p.pid); grew = true; }
      }
    }
    const times = Buffer.alloc(32);
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    return pairs.map(({ pid, ppid }) => {
      let startMs = 0;
      if (!wanted || wanted.has(pid)) {
        const h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (h) {
          if (k.GetProcessTimes(h, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) startMs = Number(times.readBigUInt64LE(0) / 10_000n) - FILETIME_UNIX_MS;
          k.CloseHandle(h);
        }
      }
      return { pid, ppid, startMs };
    });
  } finally {
    k32.close();
  }
}

/** Every process with its parent and start time (Windows): Toolhelp through bun:ffi, PowerShell CIM if that fails. */
export async function windowsProcesses(root?: number): Promise<ProcInfo[]> {
  try {
    return await processesByToolhelp(root);
  } catch {
    return processesByPowerShell();
  }
}

/**
 * `root` and every process below it that started at or after `since`. A process started earlier cannot be ours: its pid
 * (or its parent's) was reused. Children whose parent already exited still name it as their parent, so a tree whose
 * root died is found too, as long as the root's pid was not reused meanwhile.
 */
export function treeOf(procs: readonly ProcInfo[], root: number, since: number): number[] {
  const kids = new Map<number, ProcInfo[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const found: number[] = [];
  const seen = new Set<number>();
  const rootProc = procs.find((p) => p.pid === root);
  if (rootProc && rootProc.startMs >= since) found.push(root);
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const k of kids.get(pid) ?? []) {
      if (k.startMs < since || k.pid === pid) continue;
      found.push(k.pid);
      stack.push(k.pid);
    }
  }
  return found;
}

/** Whether `root`'s tree (see treeOf) has a live process (Windows). */
export async function treeAliveWindows(root: number, since: number): Promise<boolean> {
  return treeOf(await windowsProcesses(root), root, since).length > 0;
}

/** A Windows Job Object holding a command and everything it starts. */
export type ProcessJob = { readonly kill: () => void; readonly close: () => void };

let jobApi: ReturnType<typeof loadJobApi> | undefined;
function loadJobApi() {
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const k32 = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  return { k: k32.symbols, ptr };
}

/**
 * Puts process `pid` into a new Job Object (Windows). Every process it starts afterwards joins the job, so `kill`
 * ends the whole command even where parent pids do not lead to it: Git for Windows' sh forks through stub processes
 * that exit, leaving a background job's parent pid pointing nowhere. The job is created with KILL_ON_JOB_CLOSE, so when
 * the daemon holding it dies (even killed from outside), Windows ends the command too and no orphan is left. Undefined
 * when the job cannot be made; the caller falls back to killing the process tree.
 */
export function jobFor(pid: number): ProcessJob | undefined {
  try {
    jobApi ??= loadJobApi();
    const { k, ptr } = jobApi;
    const job = k.CreateJobObjectW(null, null);
    if (!job) return undefined;
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes on x64): BasicLimitInformation.LimitFlags is the u32 at offset 16.
    const info = Buffer.alloc(144);
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
    const JobObjectExtendedLimitInformation = 9;
    const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0100 | 0x0001;
    const proc = k.OpenProcess(PROCESS_SET_QUOTA_AND_TERMINATE, 0, pid);
    const ok = proc !== null && k.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(info), info.length) !== 0 && k.AssignProcessToJobObject(job, proc) !== 0;
    if (proc) k.CloseHandle(proc);
    if (!ok) {
      k.CloseHandle(job);
      return undefined;
    }
    let open = true;
    return {
      kill: () => { if (open) k.TerminateJobObject(job, 1); },
      close: () => { if (open) { open = false; k.CloseHandle(job); } },
    };
  } catch {
    return undefined;
  }
}

/** Windows: force-kills `root`'s tree (see treeOf) with taskkill; returns how many processes were in it. */
export async function killTreeWindows(root: number, since: number): Promise<number> {
  const pids = treeOf(await windowsProcesses(root), root, since);
  if (pids.length === 0) return 0;
  const p = Bun.spawn(["taskkill", "/F", ...pids.flatMap((pid) => ["/PID", String(pid)])], { stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
  await p.exited;
  return pids.length;
}

/** Well-known SIDs that mean "not just this user": Everyone, Users, Authenticated Users, Anonymous, Guests. */
const BROAD_SIDS = new Set(["S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-5-7", "S-1-5-32-546"]);

const READ_ACL =
  "param($p) (Get-Acl -LiteralPath $p).Access | ForEach-Object { " +
  "try { $sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$_.IdentityReference }; " +
  "'{0} {1}' -f $sid, $_.AccessControlType }";

/** The file's ACL entries as `<SID> <Allow|Deny>` lines (Windows, through PowerShell). */
export const readAclWindows = (path: string): string =>
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `& { ${READ_ACL} } '${path.replaceAll("'", "''")}'`], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: powershellEnv() });

/**
 * Why a secrets file is readable by more than its owner, or undefined when it is not. POSIX: any group or other mode
 * bit. Windows reports every file as mode 666, so its ACL is read instead: an Allow entry for a broad group is refused,
 * and so is an ACL that cannot be read.
 */
export function readableByOthers(
  path: string,
  platform: string = process.platform,
  readAcl: (path: string) => string = readAclWindows,
): string | undefined {
  if (platform !== "win32") {
    return (statSync(path).mode & 0o077) !== 0 ? `${path} must not be readable by others (chmod 600 ${path})` : undefined;
  }
  const fix = `icacls "${path}" /inheritance:r /grant:r "%USERNAME%:F"`;
  let acl: string;
  try {
    acl = readAcl(path);
  } catch (e) {
    return `cannot read the ACL of ${path} (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); restrict it with: ${fix}`;
  }
  const entries = acl.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter(([sid, type]) => sid?.startsWith("S-") && (type === "Allow" || type === "Deny"));
  // Every file has at least one entry: none read back means the ACL was not read (PowerShell printed an error instead).
  if (entries.length === 0) return `cannot read the ACL of ${path} (no entries read back); restrict it with: ${fix}`;
  const broad = entries.filter(([sid, type]) => BROAD_SIDS.has(sid!) && type === "Allow");
  return broad.length > 0 ? `${path} must not be readable by others (${broad.map(([sid]) => sid).join(", ")} may read it); restrict it with: ${fix}` : undefined;
}
