import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up, waitForHc, hcAnswers, HC_POLL_MS, restart } from "../src/cli.ts";
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
  test("polls the core until it answers, then opens the home", async () => {
    const w = new World();
    // The core comes up on the third ask, as it would while a reboot finishes.
    let asked = 0;
    const exec = async (cmd: string, argv: readonly string[]) => {
      if (cmd === "hc" && argv.join(" ") === "--json server status") return { code: ++asked < 3 ? 5 : 0, stdout: "", stderr: "" };
      return w.exec(cmd, argv);
    };
    const d = { ...w.deps(), platform: "darwin" as const, exec };
    // Fresh for the whole wait: the poll advances the world clock before the up reads the heartbeat.
    w.heartbeat(d.store.root, -(HC_POLL_MS + 60_000));
    expect(await hcAnswers(d)).toBe(false); // ask 1
    const line = await captureLog(() => up(d, undefined, { waitHc: true }));
    expect(asked).toBe(3); // that failed ask, then the wait's two
    expect(line).toStartWith("UP lead=hc:t");
    // No fixed sleep: the one wait is exactly the poll interval.
    expect(w.clock).toBe(1_000_000 + HC_POLL_MS);
  });

  test("says so and opens nothing when hc never comes up, ending 0 for the logon hook", async () => {
    const w = new World();
    const d = { ...w.deps(), platform: "darwin" as const, exec: async () => ({ code: 5, stdout: "", stderr: "" }) };
    const line = await captureLog(() => up(d, undefined, { waitHc: true, waitMs: 5_000 }));
    expect(line).toBe("HC UNAVAILABLE: hc did not answer within 5 s; nothing opened");
    expect(w.panes.size).toBe(0);
    expect(await waitForHc(d, 0)).toBe(false);
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
