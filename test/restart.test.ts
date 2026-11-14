import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up, waitForHc, waitForHcResult, hcUnavailableLine, HC_POLL_MS, restart, main, followRestartLog } from "../src/cli.ts";
import { detachArgv, lanesARestartEnds, lanesRefusal, noDetachRefusal, restartLogPath, restartScript } from "../src/restart.ts";
import { BOOT_KIND, bootUnitInstalled, installBootUnit, unitDir, unitFile, unitName } from "../src/systemd.ts";
import { recordPath } from "../src/down.ts";
import { World, paneRef } from "./fake.ts";

// `seori restart` and the logon hook, on a fake runtime and temporary homes: nothing here touches a real unit, a real
// hc core or the live $SEORI_HOME.

const LINE = (s: string): string => s.trim();

async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

/**
 * Waits for a line the detached worker logs (`RESTART_PID <pid>`) and returns the number. The worker is nobody's child
 * here, so the log is how the test finds it (`seori restart --follow` reads the same log).
 */
async function restartPid(log: string, deadlineMs = 20_000): Promise<number> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    const m = /^RESTART_PID (\d+)$/m.exec(text);
    if (m) return Number(m[1]);
    if (Date.now() >= until) throw new Error(`no RESTART_PID in ${log}:\n${text}`);
    await Bun.sleep(20);
  }
}

/**
 * Waits for the detached worker's last line (`RESTART_EXIT=<code>`) and returns the code. The worker is in its own
 * session, so its exit cannot be awaited here: the log is the contract (`seori restart --follow` reads the same line).
 */
async function restartExit(log: string, deadlineMs = 20_000): Promise<number> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    const m = /^RESTART_EXIT=(\d+)$/m.exec(text);
    if (m) return Number(m[1]);
    if (Date.now() >= until) throw new Error(`no RESTART_EXIT in ${log}:\n${text}`);
    await Bun.sleep(20);
  }
}

describe("lanes a restart would end", () => {
  test("only a working lane blocks: ready, paused, done and lost lanes have no agent still producing", () => {
    const lanes = [
      { key: "api", status: "working" },
      { key: "docs", status: "paused" },
      { key: "ui", status: "ready" },
      { key: "old", status: "done" },
      { key: "gone", status: "lost" },
      { key: "tests", status: "working" },
    ];
    expect(lanesARestartEnds(lanes)).toEqual([{ key: "api" }, { key: "tests" }]);
    expect(lanesARestartEnds([{ key: "docs", status: "paused" }])).toEqual([]);
  });

  test("the refusal names every key it would end and both ways on", () => {
    const text = lanesRefusal([{ key: "api" }, { key: "tests" }], "seori");
    expect(text).toContain("2 working lane(s): api, tests");
    expect(text).toContain("--force");
    expect(text).toContain("seori start <key>");
  });
});

describe("the detached restart script", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seori-restart-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A fake seori that records each call, and whose `down all` closes the caller's pane the way the real one does: it
   * sends `PANE_PID` a SIGTERM (a real `down` closes that terminal). `downMs` keeps it busy that long, so a hang-up
   * sent meanwhile lands while the worker is still mid-down.
   */
  function fakeSeori(fail?: "down" | "up", downMs = 0): string {
    const path = join(dir, "seori");
    writeFileSync(path, [
      "#!/bin/sh",
      `echo "CALLED $*" >> '${join(dir, "calls.log")}'`,
      `if [ "$1" = down ]; then`,
      `  echo "CLOSED the caller pane"; if [ -n "$PANE_PID" ]; then kill -TERM "$PANE_PID" 2>/dev/null; fi`,
      ...(downMs > 0 ? [`  sleep ${downMs / 1000}`] : []),
      ...(fail === "down" ? ["  exit 1"] : ["  exit 0"]),
      `fi`,
      `if [ "$1" = up ]; then`,
      `  echo "UP lead=hc:t9 duty=hc:t10 units=a,b,c home=$SEORI_HOME name=seori"`,
      ...(fail === "up" ? ["  exit 1"] : ["  exit 0"]),
      `fi`,
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    return path;
  }

  /** A fake `hc` whose `server status` answers 0 (a live core) or 5 (none). */
  function fakeHc(code: number): string {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const path = join(bin, "hc");
    writeFileSync(path, `#!/bin/sh\nexit ${code}\n`);
    chmodSync(path, 0o755);
    return bin;
  }

  /**
   * The script, run detached exactly as `seori restart` runs it, plus the worker's exit code from its log. A detached
   * worker is nobody's child here, so its outcome is read where `--follow` reads it. The detach is whatever this host
   * offers (setsid on Linux, nohup on macOS): both must survive the pane that asked.
   */
  async function runDetached(seori: string, env: Record<string, string>): Promise<number> {
    const log = join(dir, "restart.log");
    const script = restartScript({ home: dir, cwd: dir, seoriCmd: seori, log });
    const detach = detachArgv(script, (bin) => Bun.which(bin, { PATH: `${env["PATH"] ?? ""}` }) !== null, "seori-restart-test");
    if (detach === undefined) throw new Error("no detach available in this test host");
    const p = Bun.spawn([...detach.argv], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
    await p.exited;
    return restartExit(log);
  }

  test("the worker survives a SIGHUP mid-down and still runs the up, then reports its exit", async () => {
    // A closing terminal hangs up on what it started; that arrives while the worker is still mid-`down`, because the
    // fake seori's down takes a moment. The hang-up goes to the worker itself (its pid is in the log), which is the
    // signal that would otherwise end it, so this holds whatever detach this host offers.
    const seori = fakeSeori(undefined, 600);
    const log = join(dir, "restart.log");
    const detach = detachArgv(restartScript({ home: dir, cwd: dir, seoriCmd: seori, log }), (b) => Bun.which(b) !== null, "seori-restart-test");
    expect(detach).toBeDefined();
    const pane = Bun.spawn([...detach!.argv], { env: { ...process.env, PATH: `${fakeHc(0)}:${process.env["PATH"]}`, SEORI_HOME: dir }, stdio: ["ignore", "ignore", "ignore"] });
    await pane.exited;
    const worker = await restartPid(log);
    expect(worker).toBeGreaterThan(0);
    // A closing terminal hangs up on what it started.
    process.kill(worker, "SIGHUP");
    expect(await restartExit(log)).toBe(0);
    const calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
    expect(calls).toEqual(["CALLED down all", "CALLED up --cwd " + dir]);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("RESTART_BEGIN");
    expect(text).toContain("UP lead=hc:t9 duty=hc:t10");
    expect(LINE(text.split("\n").find((l) => l.startsWith("RESTART_DONE"))!)).toBe("RESTART_DONE");
    // The worker is done and gone: the exit code was its last word.
    const gone = Bun.spawn(["/bin/kill", "-0", String(worker)], { stdio: ["ignore", "ignore", "ignore"] });
    expect(await gone.exited).not.toBe(0);
  });

  test("a down that does not finish leaves the up out, and says so", async () => {
    const seori = fakeSeori("down");
    const code = await runDetached(seori, { PATH: `${fakeHc(0)}:${process.env["PATH"]}`, PANE_PID: "1", SEORI_HOME: dir });
    expect(code).not.toBe(0);
    expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toEqual(["CALLED down all"]);
    expect(readFileSync(join(dir, "restart.log"), "utf8")).toContain("RESTART_FAILED seori down did not finish; nothing opened");
  });

  test("no hc core means nothing is stopped and nothing opened", async () => {
    const seori = fakeSeori();
    const code = await runDetached(seori, { PATH: `${fakeHc(5)}:${process.env["PATH"]}`, PANE_PID: "1", SEORI_HOME: dir });
    expect(code).not.toBe(0);
    expect(existsSync(join(dir, "calls.log"))).toBe(false);
    expect(readFileSync(join(dir, "restart.log"), "utf8")).toContain("RESTART_FAILED hc (herdr-core) does not answer");
  });

  test("an up that fails ends the script non-zero with the reason", async () => {
    const seori = fakeSeori("up");
    const code = await runDetached(seori, { PATH: `${fakeHc(0)}:${process.env["PATH"]}`, PANE_PID: "1", SEORI_HOME: dir });
    expect(code).not.toBe(0);
    expect(readFileSync(join(dir, "restart.log"), "utf8")).toContain("RESTART_FAILED seori up failed");
  });

  test("a home or cwd with shell syntax in it is printed and passed as a path, never expanded or run", async () => {
    // A directory name may legally contain $, backticks and quotes; if any of these were expanded, the echo would run
    // them (the log is built by a shell). The marker files prove nothing ran.
    const pwned = [join(dir, "pwned-tick"), join(dir, "pwned-subst")];
    const evil = join(dir, "it's a $HOME `touch ${pwned[0]}`/$(touch ${pwned[1]})");
    mkdirSync(evil, { recursive: true });
    const seori = fakeSeori();
    const script = restartScript({ home: evil, cwd: evil, seoriCmd: seori, log: join(dir, "restart.log") });
    const detach = detachArgv(script, (b) => Bun.which(b) !== null, "seori-restart-test");
    const p = Bun.spawn([...detach!.argv], { env: { ...process.env, PATH: `${fakeHc(0)}:${process.env["PATH"]}`, SEORI_HOME: dir }, stdio: ["ignore", "ignore", "ignore"] });
    await p.exited;
    expect(await restartExit(join(dir, "restart.log"))).toBe(0);
    // The path reached seori as one literal argument, and both markers are missing.
    expect(readFileSync(join(dir, "calls.log"), "utf8")).toContain(`CALLED up --cwd ${evil}`);
    for (const marker of pwned) expect(existsSync(marker)).toBe(false);
  });
});

describe("how a restart detaches", () => {
  test("setsid first, then systemd-run, then portable nohup, and a refusal when none is there", () => {
    expect(detachArgv("x", (b) => b === "setsid", "u")).toEqual({ argv: ["setsid", "--fork", "/bin/sh", "-c", "x"], background: false });
    expect(detachArgv("x", (b) => b === "systemd-run", "u")).toEqual({
      argv: ["systemd-run", "--user", "--collect", "--quiet", "--unit=u", "/bin/sh", "-c", "x"], background: false,
    });
    // macOS has neither: nohup still detaches from the pane's SIGHUP, which is the whole point.
    const nohup = detachArgv("x", (b) => b === "nohup", "u");
    expect(nohup?.background).toBe(true);
    expect(nohup?.argv).toEqual(["/bin/sh", "-c", "nohup /bin/sh -c 'x' >/dev/null 2>&1 &"]);
    expect(detachArgv("x", () => false, "u")).toBeUndefined();
    expect(noDetachRefusal()).toContain("setsid, systemd-run or nohup");
  });

  test("the log is inside the home, so the new refs can be read after the pane closed", () => {
    expect(restartLogPath("/h/.seori")).toBe("/h/.seori/restart.log");
  });
});

describe("seori up --wait-hc", () => {
  /** hc's real error envelope for a status that could not bring a core up (observed on hc 0.1.20). */
  const HC_STATUS_FAIL = JSON.stringify({
    error: { hint: "check the core log in the state directory", kind: "unavailable", message: "cannot start core: Permission denied (os error 13)" },
  });

  /**
   * A fake hc: `status` answers from `codes` (the last one repeats) with hc's error envelope, `start` answers
   * `startCode` with `startWhy`. Records each call.
   */
  function fakeHcWorld(codes: readonly number[], startCode = 0, startWhy = "no core to start") {
    const w = new World();
    const calls: string[] = [];
    let i = 0;
    let starts = 0;
    const exec = async (cmd: string, argv: readonly string[]) => {
      const line = `${cmd} ${argv.join(" ")}`;
      if (cmd === "hc" && argv.join(" ") === "--json server status") {
        calls.push(line);
        const code = codes[Math.min(i++, codes.length - 1)]!;
        return { code, stdout: "", stderr: code === 0 ? "" : HC_STATUS_FAIL };
      }
      if (cmd === "hc" && argv.join(" ") === "--json server start") {
        calls.push(line);
        starts++;
        return startCode === 0 ? { code: 0, stdout: "{}", stderr: "" } : { code: startCode, stdout: "", stderr: startWhy };
      }
      return w.exec(cmd, argv);
    };
    const d = { ...w.deps(), platform: "darwin" as const, exec };
    return { w, d, calls, starts: () => starts, statuses: () => calls.filter((c) => c.endsWith("status")).length };
  }

  test("a core that answers at once is never started", async () => {
    const { w, d, starts, statuses } = fakeHcWorld([0]);
    w.heartbeat(d.store.root, -(HC_POLL_MS + 60_000));
    const line = await captureLog(() => up(d, undefined, { waitHc: true }));
    expect(line).toStartWith("UP lead=hc:t");
    expect(starts()).toBe(0);
    expect(statuses()).toBe(1);
  });

  test("no core at first: `hc server start` runs once, then the answer is picked up and the home opens", async () => {
    const { w, d, starts, statuses } = fakeHcWorld([5, 5, 0]);
    w.heartbeat(d.store.root, -(HC_POLL_MS + 60_000));
    const line = await captureLog(() => up(d, undefined, { waitHc: true }));
    expect(line).toStartWith("UP lead=hc:t");
    expect(starts()).toBe(1);
    expect(statuses()).toBe(3);
  });

  test("a start that fails is not fatal: it polls on, and a core that comes up later still opens the home", async () => {
    const { w, d, starts } = fakeHcWorld([5, 5, 0], 7);
    w.heartbeat(d.store.root, -(HC_POLL_MS + 60_000));
    const line = await captureLog(() => up(d, undefined, { waitHc: true }));
    expect(line).toStartWith("UP lead=hc:t");
    expect(starts()).toBe(1);
  });

  test("start is called exactly once over many failed polls", async () => {
    const { d, starts, statuses } = fakeHcWorld([5]);
    expect(await waitForHc(d, 10 * HC_POLL_MS)).toBe(false);
    expect(starts()).toBe(1);
    expect(statuses()).toBeGreaterThan(5);
  });

  test("a core that never answers names both attempts, opens nothing, and ends the hook cleanly", async () => {
    const { w, d, starts } = fakeHcWorld([5], 9);
    const line = await captureLog(() => up(d, undefined, { waitHc: true, waitMs: 30_000 }));
    expect(starts()).toBe(1);
    expect(line).toStartWith("HC UNAVAILABLE: waited 30 s for the hc core to answer");
    // hc's own sentence, not its JSON envelope: the journal line is for a human.
    expect(line).toContain("`hc server status` exited 5 (cannot start core: Permission denied (os error 13))");
    expect(line).toContain("`hc server start` failed: no core to start");
    expect(line).not.toContain('{"error"');
    expect(line).toContain("still no answer; nothing opened");
    expect(line).toContain("The daemon and loops are unaffected.");
    expect(w.panes.size).toBe(0);
  });

  test("a status that fails with no output reports its code alone, never a reason hc did not give", async () => {
    const w = new World();
    const d = { ...w.deps(), platform: "darwin" as const, exec: async () => ({ code: 5, stdout: "", stderr: "" }) };
    const r = await waitForHcResult(d, 1_000);
    expect(r.statusCode).toBe(5);
    expect(r.statusWhy).toBeUndefined();
    expect(hcUnavailableLine(r)).toContain("`hc server status` exited 5");
    // The line this replaced claimed "(no core)" for every non-zero status, including a core that exists but cannot start.
    expect(hcUnavailableLine(r)).not.toContain("no core)");
  });

  test("a successful start that still never answers says so, rather than blaming the start", async () => {
    const { d } = fakeHcWorld([5], 0);
    const r = await waitForHcResult(d, 5_000);
    expect(r.up).toBe(false);
    expect(r.start).toEqual({ tried: true, ok: true });
    const line = hcUnavailableLine(r);
    expect(line).toContain("`hc server start` succeeded");
    expect(line).toContain("Permission denied");
  });

  test("the logon hook exits 0 with no core, so systemd does not mark the oneshot failed and retry it", async () => {
    const { w, d } = fakeHcWorld([5], 0);
    let code: number | undefined;
    const line = await captureLog(async () => { code = await main(["up", "--wait-hc", "--wait-ms", "2000"], d); });
    expect(code).toBe(0);
    expect(line).toStartWith("HC UNAVAILABLE: waited 2 s");
    expect(w.panes.size).toBe(0);
  });

  test("a wait that ends before its first start says so, instead of claiming a start was not needed", async () => {
    const { d } = fakeHcWorld([5], 0);
    // A zero wait ends before the loop ever attempts a start.
    expect((await waitForHcResult(d, 0)).start).toEqual({ tried: false });
    const line = hcUnavailableLine({ up: false, start: { tried: false }, statusCode: 5, waitedMs: 0 });
    expect(line).toContain("`hc server start` was not attempted (the wait ended first)");
    expect(line).not.toContain("not needed");
  });

  test("the last status code is carried, so the message is specific", async () => {
    const { d } = fakeHcWorld([5], 0);
    const r = await waitForHcResult(d, 1_000);
    expect(r.statusCode).toBe(5);
    expect(r.start.tried).toBe(true);
  });
});

describe("the logon hook unit", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seori-autostart-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const spec = (home: string, d: string) => ({ instance: "seori-two", home, cwd: home, bun: "/b/bun", cli: "/s/cli.ts", env: { PATH: "/usr/bin:/bin" } });

  test("is a oneshot running up --wait-hc, with no Restart= and no success codes to hide a failure", () => {
    const text = unitFile(spec("/h/.seori", dir), BOOT_KIND);
    expect(text).toContain("Type=oneshot\n");
    expect(text).toContain('ExecStart="/b/bun" "/s/cli.ts" "up" "--wait-hc"');
    expect(text).toContain("Restart=no\n");
    expect(text).not.toContain("Restart=on-failure");
    expect(text).not.toContain("SuccessExitStatus");
    expect(text).toContain("WantedBy=default.target");
    // The resident processes keep their restart loop; the hook is the only oneshot.
    expect(unitFile(spec("/h/.seori", dir), "daemon")).toContain("Type=simple\n");
    expect(unitFile(spec("/h/.seori", dir), "daemon")).toContain("Restart=on-failure");
  });

  test("install writes and enables it without starting it, and status finds it", async () => {
    const calls: string[] = [];
    const ctl = async (args: readonly string[]) => void calls.push(args.join(" "));
    const home = join(dir, "home");
    const name = await installBootUnit(dir, spec(home, dir), ctl);
    expect(name).toBe(unitName("seori-two", home, BOOT_KIND));
    expect(readdirSync(dir)).toEqual([name]);
    // enable only: a boot hook does nothing at install time.
    expect(calls).toEqual(["daemon-reload", `enable ${name}`]);
    expect(bootUnitInstalled(dir, "seori-two", home)).toBe(name);
    expect(bootUnitInstalled(dir, "seori-two", join(dir, "other"))).toBeUndefined();
  });

  test("the hook is separate from unitDir(): it is not one of the three kinds and not a live runner", () => {
    // unitDir() is the real user-manager directory; these helpers only compute names, so this checks the naming rule.
    expect(unitName("seori", "/h/.seori", BOOT_KIND)).toMatch(/^seori-seori-[0-9a-f]{8}-boot\.service$/);
    expect(unitDir({ SEORI_SYSTEMD_DIR: "/tmp/x" })).toBe("/tmp/x");
  });
});

describe("up with a resident home", () => {
  test("a pane-only up never writes a unit or calls systemctl", async () => {
    const w = new World();
    const d = w.deps();
    mkdirSync(join(d.store.root, "run"));
    writeFileSync(recordPath(d.store.root, "daemon-loop"), JSON.stringify({ pid: process.pid }));
    d.store.setRole("lead", paneRef("t1"));
    const before = w.calls.length;
    const line = await captureLog(() => up(d, undefined));
    expect(line).toStartWith("REOPENED lead,duty");
    // No hc `run` for a unit, and no systemctl at all: the units that are running were left alone.
    const systemctlCalls = w.calls.slice(before).filter((c) => c.cmd !== "hc" && c.cmd !== "omp");
    expect(systemctlCalls).toEqual([]);
  });
});

describe("seori restart as a command", () => {
  /** A home with `lanes` saved as lanes in `status`, and a spawn that records what it was asked to start. */
  function home(statuses: Record<string, string> = {}) {
    const w = new World();
    const d = w.deps();
    for (const [key, status] of Object.entries(statuses)) {
      d.store.saveLane({
        key, sessionRef: paneRef("t1"), paneId: "t1", tabId: "", brief: "/b.md", cwd: "/w",
        status: status as never, createdAt: 1, lastActivityAt: 1, nudges: 0, log: [],
      });
    }
    const started: { argv: readonly string[]; cwd: string }[] = [];
    return { w, d, started };
  }

  test("refuses while a lane is working, naming the keys, and starts nothing", async () => {
    const { d, started } = home({ api: "working", docs: "paused" });
    const spawn = async (argv: readonly string[], cwd: string) => (started.push({ argv, cwd }), 0);
    await expect(restart(d, undefined, false, () => {}, { spawn })).rejects.toThrow(/would end 1 working lane\(s\): api/);
    expect(started).toEqual([]);
  });

  test("--force starts the detached worker and names every lane it ended", async () => {
    const { d, started } = home({ api: "working", tests: "working", docs: "paused" });
    const spawn = async (argv: readonly string[], cwd: string) => (started.push({ argv, cwd }), 0);
    const lines: string[] = [];
    const code = await restart(d, undefined, true, (l) => void lines.push(l), { spawn, has: (b) => b === "setsid" });
    expect(code).toBe(0);
    // One detached worker, in this home, running the script: nothing of the old home is touched by this process.
    expect(started).toHaveLength(1);
    expect(started[0]!.cwd).toBe(d.store.root);
    expect(started[0]!.argv.slice(0, 2)).toEqual(["setsid", "--fork"]);
    expect(started[0]!.argv.join(" ")).toContain("down all");
    expect(lines.filter((l) => l.startsWith("ENDED ")).map((l) => l.split(" ")[1])).toEqual(["api", "tests"]);
    expect(lines.at(-1)).toContain("RESTARTING detached");
    expect(lines.at(-1)).toContain(join(d.store.root, "restart.log"));
  });

  test("a host that cannot detach refuses before anything is stopped", async () => {
    const { d, started } = home();
    const spawn = async (argv: readonly string[], cwd: string) => (started.push({ argv, cwd }), 0);
    await expect(restart(d, undefined, false, () => {}, { spawn, has: () => false })).rejects.toThrow(/setsid, systemd-run or nohup/);
    expect(started).toEqual([]);
  });

  test("a worker that could not be started says so instead of claiming a restart", async () => {
    const { d } = home();
    const lines: string[] = [];
    const code = await restart(d, undefined, false, (l) => void lines.push(l), { spawn: async () => 3, has: () => true });
    expect(code).toBe(1);
    expect(lines).toEqual([`RESTART_FAILED could not detach the relaunch (exit 3); nothing was stopped. See ${join(d.store.root, "restart.log")}`]);
  });
});

describe("the commands as the CLI dispatches them", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seori-cli-restart-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A home whose `seori` command is a stub on PATH, so the worker the CLI detaches really runs one. */
  function stubCommand(): { env: Record<string, string>; calls: string } {
    const calls = join(dir, "calls.log");
    const stub = join(dir, "seori");
    writeFileSync(stub, [
      "#!/bin/sh",
      `echo "CALLED $*" >> '${calls}'`,
      `if [ "$1" = down ]; then exit 0; fi`,
      `if [ "$1" = up ]; then echo "UP lead=hc:t7 duty=hc:t8 units=a,b,c home=$SEORI_HOME name=seori"; exit 0; fi`,
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(stub, 0o755);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "hc"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "hc"), 0o755);
    return { env: { PATH: `${bin}:${process.env["PATH"]}` }, calls };
  }

  test("`seori restart --follow` starts the worker, then prints its log through to the exit line", async () => {
    const w = new World();
    const d = { ...w.deps(), seoriCmd: join(dir, "seori") };
    const { env, calls } = stubCommand();
    const before = Object.fromEntries(["PATH", "SEORI_HOME"].map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    process.env["SEORI_HOME"] = d.store.root;
    const lines: string[] = [];
    let code: number | undefined;
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      code = await main(["restart", "--follow"], d);
    } finally {
      console.log = log;
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    // --follow exits 0 only when the worker logged RESTART_EXIT=0, so the whole chain really ran.
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("RESTARTING detached");
    expect(text).toContain("UP lead=hc:t7 duty=hc:t8");
    expect(text).toContain("RESTART_EXIT=0");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["CALLED down all", `CALLED up --cwd ${d.store.root}`]);
  }, 30_000);

  test("`seori up --wait-ms` refuses a value that is not a number, before any pane opens", async () => {
    const w = new World();
    const d = w.deps();
    await expect(main(["up", "--wait-ms", "soon"], d)).rejects.toThrow(/--wait-ms takes a nonnegative number/);
    expect(w.panes.size).toBe(0);
  });

  test("`seori autostart status` says how to install the hook when there is none", async () => {
    const w = new World();
    const d = { ...w.deps(), platform: "linux" as const };
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ name: "seori-two" }));
    const saved = process.env["SEORI_SYSTEMD_DIR"];
    process.env["SEORI_SYSTEMD_DIR"] = join(dir, "units");
    let out = "";
    const log = console.log;
    console.log = (...a: unknown[]) => void (out = a.join(" "));
    try {
      expect(await main(["autostart", "status"], d)).toBe(0);
    } finally {
      console.log = log;
      if (saved === undefined) delete process.env["SEORI_SYSTEMD_DIR"];
      else process.env["SEORI_SYSTEMD_DIR"] = saved;
    }
    expect(out).toContain("AUTOSTART not installed");
    expect(out).toContain("autostart install");
  });

  test("`seori autostart` refuses a subcommand it does not have", async () => {
    const w = new World();
    const d = { ...w.deps(), platform: "linux" as const };
    await expect(main(["autostart", "uninstall"], d)).rejects.toThrow(/unknown autostart command uninstall \(install, status\)/);
  });
});

describe("seori restart --follow reading the log", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seori-follow-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A clock and sleep the test drives, so no case waits on real time. */
  function clock() {
    let now = 0;
    const sleeps: number[] = [];
    return {
      now: () => now,
      sleeps,
      sleep: async (ms: number) => void (sleeps.push(ms), (now += ms)),
    };
  }

  test("a line split across two reads is printed once, and its exit code is still found", async () => {
    const log = join(dir, "restart.log");
    const c = clock();
    // Each read appends more of the file, exactly as a writer would: the exit line arrives in two halves.
    const steps = ["RESTART_PID 42\nRESTART_BE", "GIN home=/h\nRESTART_EX", "IT=0\n"];
    let i = 0;
    const sleep = async (ms: number) => {
      await c.sleep(ms);
      i++;
      if (i < steps.length) await Bun.write(log, steps.slice(0, i + 1).join(""));
    };
    await Bun.write(log, steps[0]!);
    i = 0;
    const lines: string[] = [];
    expect(await followRestartLog(log, 0, (l) => void lines.push(l), sleep, 60_000, c.now)).toBe(true);
    // No line was printed twice or cut in half: "RESTART_BEGIN home=/h" appears whole and once.
    expect(lines.filter((l) => l === "RESTART_BEGIN home=/h")).toHaveLength(1);
    expect(lines.some((l) => l.includes("RESTART_BE") && !l.includes("RESTART_BEGIN"))).toBe(false);
    expect(lines.every((l) => steps.join("").includes(l))).toBe(true);
  });

  test("a verdict with no trailing newline is still read at the deadline", async () => {
    const log = join(dir, "restart.log");
    await Bun.write(log, "RESTART_BEGIN home=/h\nRESTART_EXIT=0");
    const c = clock();
    const lines: string[] = [];
    expect(await followRestartLog(log, 0, (l) => void lines.push(l), c.sleep, 1_000, c.now)).toBe(true);
    // Bounded: the driven clock advances by the poll interval, so the wait ends instead of spinning on the real time.
    expect(c.sleeps.length).toBeLessThanOrEqual(3);
  });

  test("a worker that never reports ends in RESTART_UNFINISHED, not a fake success", async () => {
    const log = join(dir, "restart.log");
    await Bun.write(log, "RESTART_BEGIN home=/h\n");
    const c = clock();
    const lines: string[] = [];
    expect(await followRestartLog(log, 0, (l) => void lines.push(l), c.sleep, 2_000, c.now)).toBe(false);
    expect(lines.at(-1)).toContain("RESTART_UNFINISHED");
  });

  test("lines before `from` are not printed again", async () => {
    const log = join(dir, "restart.log");
    const earlier = "RESTART_BEGIN home=/h\n";
    await Bun.write(log, `${earlier}RESTART_DONE\nRESTART_EXIT=0\n`);
    const lines: string[] = [];
    const c = clock();
    expect(await followRestartLog(log, earlier.length, (l) => void lines.push(l), c.sleep, 1_000, c.now)).toBe(true);
    expect(lines).toEqual(["RESTART_DONE", "RESTART_EXIT=0"]);
  });
});
