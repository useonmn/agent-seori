import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  up, upCheck, upLockPath, waitForHc, waitForHcResult, hcUnavailableLine, HC_POLL_MS, restart, main, followRestartLog, wakeNewLead,
  LEAD_START_LINE, LEAD_START_WAIT_MS,
} from "../src/cli.ts";
import {
  detachWays, lanesARestartEnds, lanesRefusal, noDetachRefusal, restartLogPath, restartPidPath, restartScript, runningRestart,
} from "../src/restart.ts";
import { MESSENGER_TOKEN_ENV } from "../src/runtime/hc/sessions.ts";
import { BOOT_KIND, bootUnitInstalled, installBootUnit, unitCwd, unitDir, unitFile, unitName, writeUnits } from "../src/systemd.ts";
import { liveRunners, recordPath } from "../src/down.ts";
import { DeliveryUncertain } from "../src/runtime/delivery.ts";
import { lockFile } from "../src/store.ts";
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

/** Waits (bounded) for `ok` to hold: for a detached worker, which no one here can await, its traces are the signal. */
async function waitUntil(what: string, ok: () => boolean, deadlineMs = 20_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!ok()) {
    if (Date.now() >= end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** Whether `pid` names a live process (signal 0 checks without sending anything). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
  let panes: Subprocess[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seori-restart-"));
    panes = [];
  });
  afterEach(() => {
    for (const p of panes) p.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for the caller's pane: a throwaway process of this test that the fake down kills, as a real down closes that terminal. */
  function openPane(): Subprocess {
    const p = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
    panes.push(p);
    return p;
  }

  /** Resolves with the signal that ended the pane process, awaiting its exit; the bound only turns a hang into a failure. */
  async function paneEnded(p: Subprocess, deadlineMs = 20_000): Promise<Subprocess["signalCode"]> {
    const late = Promise.withResolvers<never>();
    const timer = setTimeout(() => late.reject(new Error(`pane ${p.pid} still running after ${deadlineMs} ms`)), deadlineMs);
    try {
      await Promise.race([p.exited, late.promise]);
    } finally {
      clearTimeout(timer);
    }
    return p.signalCode;
  }

  /**
   * A fake seori that records each call, and whose `down` closes the caller's pane the way the real one does: it sends
   * `PANE_PID` a SIGTERM. With `gate`, the down then waits (bounded) for that file to exist, so the test decides what
   * happens while the worker is still mid-down.
   */
  function fakeSeori(fail?: "down" | "up", gate?: string): string {
    const path = join(dir, "seori");
    writeFileSync(path, [
      "#!/bin/sh",
      `echo "CALLED $*" >> '${join(dir, "calls.log")}'`,
      `if [ "$1" = down ]; then`,
      `  echo "CLOSED the caller pane"; if [ -n "$PANE_PID" ]; then kill -TERM "$PANE_PID"; fi`,
      ...(gate === undefined
        ? []
        : [
            `  n=0`,
            `  while [ ! -e '${gate}' ]; do`,
            `    n=$((n+1)); if [ "$n" -gt 400 ]; then echo "GATE never opened"; exit 1; fi; sleep 0.05`,
            `  done`,
          ]),
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

  /** The first way this host detaches (setsid on Linux, nohup on macOS), as `seori restart` would take it. */
  function firstWay(script: string, env: Record<string, string> = {}): readonly string[] {
    const PATH = env["PATH"] ?? process.env["PATH"] ?? "";
    const way = detachWays(script, (bin) => Bun.which(bin, { PATH }) !== null, "seori-restart-test", env)[0];
    if (way === undefined) throw new Error("no detach available in this test host");
    return way.argv;
  }

  /**
   * The script, run detached exactly as `seori restart` runs it, plus the worker's exit code from its log. A detached
   * worker is nobody's child here, so its outcome is read where `--follow` reads it. The detach is whatever this host
   * offers (setsid on Linux, nohup on macOS): both must survive the pane that asked.
   */
  async function runDetached(seori: string, env: Record<string, string>): Promise<number> {
    const log = join(dir, "restart.log");
    const script = restartScript({ home: dir, cwd: dir, seoriCmd: seori, log });
    const p = Bun.spawn([...firstWay(script, env)], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
    await p.exited;
    return restartExit(log);
  }

  test("the worker survives a SIGHUP mid-down, closes the pane, still runs the up, then reports its exit and ends", async () => {
    const gate = join(dir, "gate");
    const seori = fakeSeori(undefined, gate);
    const pane = openPane();
    const log = join(dir, "restart.log");
    const env = { PATH: `${fakeHc(0)}:${process.env["PATH"]}`, SEORI_HOME: dir, PANE_PID: String(pane.pid) };
    const starter = Bun.spawn([...firstWay(restartScript({ home: dir, cwd: dir, seoriCmd: seori, log }), env)], {
      env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"],
    });
    await starter.exited;
    const worker = await restartPid(log);
    expect(worker).toBeGreaterThan(0);
    // The down has started (and is held at the gate): the hang-up a closing terminal sends lands mid-down.
    await waitUntil("the down to start", () => existsSync(join(dir, "calls.log")));
    process.kill(worker, "SIGHUP");
    writeFileSync(gate, "");
    expect(await restartExit(log)).toBe(0);
    // The down closed the pane that asked, as the real one does.
    expect(await paneEnded(pane)).toBe("SIGTERM");
    const calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
    // The restart's down keeps the logon hook: a restart is not an uninstall.
    expect(calls).toEqual(["CALLED down all --keep-autostart", "CALLED up --cwd " + dir]);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("RESTART_BEGIN");
    expect(text).toContain("UP lead=hc:t9 duty=hc:t10");
    expect(LINE(text.split("\n").find((l) => l.startsWith("RESTART_DONE"))!)).toBe("RESTART_DONE");
    // The exit code was its last word: the worker ends after it, and its pid file went with it.
    await waitUntil(`worker ${worker} to end`, () => !alive(worker));
    expect(existsSync(restartPidPath(dir))).toBe(false);
  });

  test("a down that does not finish leaves the up out, and says so", async () => {
    const seori = fakeSeori("down");
    const pane = openPane();
    const code = await runDetached(seori, { PATH: `${fakeHc(0)}:${process.env["PATH"]}`, PANE_PID: String(pane.pid), SEORI_HOME: dir });
    expect(code).not.toBe(0);
    expect(await paneEnded(pane)).toBe("SIGTERM");
    expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toEqual(["CALLED down all --keep-autostart"]);
    expect(readFileSync(join(dir, "restart.log"), "utf8")).toContain("RESTART_FAILED seori down did not finish; nothing opened");
  });

  test("a second worker while one is running stops nothing and says so; the first's pid file stays", async () => {
    const seori = fakeSeori();
    // The first worker, as far as the second can tell: a live pid in the home's restart pid file.
    const first = openPane();
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(restartPidPath(dir), `${first.pid}\n`);
    const code = await runDetached(seori, { PATH: `${fakeHc(0)}:${process.env["PATH"]}`, SEORI_HOME: dir });
    expect(code).toBe(1);
    expect(existsSync(join(dir, "calls.log"))).toBe(false);
    expect(readFileSync(join(dir, "restart.log"), "utf8")).toContain(
      `RESTART_FAILED another restart of this home is running (pid ${first.pid}); nothing stopped, nothing opened`,
    );
    expect(readFileSync(restartPidPath(dir), "utf8").trim()).toBe(String(first.pid));
  });

  test("a pid file left by a worker that died is taken over", async () => {
    const seori = fakeSeori();
    const gone = Bun.spawn(["true"], { stdio: ["ignore", "ignore", "ignore"] });
    await gone.exited;
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(restartPidPath(dir), `${gone.pid}\n`);
    expect(await runDetached(seori, { PATH: `${fakeHc(0)}:${process.env["PATH"]}`, SEORI_HOME: dir })).toBe(0);
    expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toEqual(["CALLED down all --keep-autostart", `CALLED up --cwd ${dir}`]);
  });

  test("no hc core means nothing is stopped and nothing opened", async () => {
    const seori = fakeSeori();
    const pane = openPane();
    const code = await runDetached(seori, { PATH: `${fakeHc(5)}:${process.env["PATH"]}`, PANE_PID: String(pane.pid), SEORI_HOME: dir });
    expect(code).not.toBe(0);
    expect(existsSync(join(dir, "calls.log"))).toBe(false);
    // No seori ran, so nothing could have closed the pane.
    expect(alive(pane.pid)).toBe(true);
    expect(readFileSync(join(dir, "restart.log"), "utf8")).toContain("RESTART_FAILED hc (herdr-core) does not answer");
  });

  test("an up that fails ends the script non-zero with the reason", async () => {
    const seori = fakeSeori("up");
    const pane = openPane();
    const code = await runDetached(seori, { PATH: `${fakeHc(0)}:${process.env["PATH"]}`, PANE_PID: String(pane.pid), SEORI_HOME: dir });
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
    const env = { PATH: `${fakeHc(0)}:${process.env["PATH"]}`, SEORI_HOME: dir };
    const p = Bun.spawn([...firstWay(script, env)], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
    await p.exited;
    expect(await restartExit(join(dir, "restart.log"))).toBe(0);
    // The path reached seori as one literal argument, and both markers are missing.
    expect(readFileSync(join(dir, "calls.log"), "utf8")).toContain(`CALLED up --cwd ${evil}`);
    for (const marker of pwned) expect(existsSync(marker)).toBe(false);
  });
});

describe("how a restart detaches", () => {
  test("setsid first, then systemd-run, then portable nohup, and a refusal when none is there", () => {
    const all = detachWays("x", () => true, "u", { PATH: "/p/bin:/usr/bin", SEORI_HOME: "/h", HC_SOCKET: "/s", HOME: "/home/x", OTHER: "y" });
    expect(all.map((w) => w.via)).toEqual(["setsid", "systemd-run", "nohup"]);
    expect(all[0]!.argv).toEqual(["setsid", "--fork", "/bin/sh", "-c", "x"]);
    // A transient unit runs with the user manager's environment: PATH (hc, bun) and seori's and hc's variables go along.
    expect(all[1]!.argv).toEqual([
      "systemd-run", "--user", "--collect", "--quiet", "--unit=u",
      "--setenv=PATH=/p/bin:/usr/bin", "--setenv=SEORI_HOME=/h", "--setenv=HC_SOCKET=/s", "/bin/sh", "-c", "x",
    ]);
    // macOS has neither: nohup still detaches from the pane's SIGHUP, which is the whole point.
    expect(all[2]!.argv).toEqual(["/bin/sh", "-c", "nohup /bin/sh -c 'x' >/dev/null 2>&1 &"]);
    expect(detachWays("x", (b) => b === "nohup", "u", {}).map((w) => w.via)).toEqual(["nohup"]);
    expect(detachWays("x", () => false, "u", {})).toEqual([]);
    expect(noDetachRefusal()).toContain("setsid, systemd-run or nohup");
  });

  test("systemd-run never carries a messenger token, and its command keeps every $ literal", () => {
    const env: Record<string, string> = { PATH: "/usr/bin", SEORI_HOME: "/h" };
    for (const k of MESSENGER_TOKEN_ENV) env[k] = `secret-${k}`;
    const script = `echo "RESTART_PID $$"; x=\${HOME}; echo $x`;
    const way = detachWays(script, (b) => b === "systemd-run", "u", env)[0]!;
    expect(way.via).toBe("systemd-run");
    const argv = way.argv.join("\n");
    for (const k of MESSENGER_TOKEN_ENV) expect(argv).not.toContain(k);
    expect(argv).not.toContain("secret-");
    expect(way.argv).toContain("--setenv=SEORI_HOME=/h");
    // The manager expands $VAR and ${VAR} and turns $$ into $ in a transient unit's command: every $ is doubled, so what
    // the shell finally runs is the script as written.
    const command = way.argv.at(-1)!;
    expect(command).toBe(`echo "RESTART_PID $$$$"; x=$\${HOME}; echo $$x`);
    expect(command.split("$$").join("$")).toBe(script);
    // The other ways run the script as it is.
    expect(detachWays(script, (b) => b === "setsid", "u", env)[0]!.argv.at(-1)).toBe(script);
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
    // The hook carries its cwd to `up`: WorkingDirectory= alone would leave the agents in $SEORI_HOME.
    expect(text).toContain('ExecStart="/b/bun" "/s/cli.ts" "up" "--wait-hc" "--cwd" "/h/.seori"\n');
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

  test("the units' cwd is read back for a restart, never from another home's file under the name", () => {
    const home = join(dir, "home");
    const work = join(dir, "it's 100% work");
    expect(unitCwd(dir, "seori-two", home)).toBeUndefined();
    writeUnits(dir, { ...spec(home, dir), cwd: work });
    expect(unitCwd(dir, "seori-two", home)).toBe(work);
    expect(unitCwd(dir, "seori-two", join(dir, "other"))).toBeUndefined();
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

  test("two ups at once open one set: the second finds the first's lock, says UP BUSY and opens nothing", async () => {
    const w = new World();
    const d = { ...w.deps(), platform: "darwin" as const };
    w.heartbeat(d.store.root, 0);
    const lines: string[] = [];
    const out = (l: string): void => void lines.push(l);
    await Promise.all([up(d, undefined, {}, out), up(d, undefined, {}, out)]);
    expect(lines.filter((l) => l.startsWith("UP lead="))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("UP BUSY "))).toEqual([
      `UP BUSY name=seori home=${d.store.root}: another seori up of this home is opening it (${upLockPath(d.store.root)}); nothing opened`,
    ]);
    const leads = [...w.panes.values()].filter((p) => p.labels["seori.role"] === "lead");
    expect(leads).toHaveLength(1);
    // The lock went with the up that held it: the next up finds the home and opens nothing.
    expect(existsSync(upLockPath(d.store.root))).toBe(false);
    const again: string[] = [];
    await up(d, undefined, {}, (l) => void again.push(l));
    expect(again[0]).toStartWith("ALREADY UP");
  });

  test("an up whose lock another live process holds exits cleanly through main, opening nothing", async () => {
    const w = new World();
    const d = { ...w.deps(), platform: "darwin" as const };
    mkdirSync(join(d.store.root, "run"));
    // This test process is alive, so its lock is not stale: exactly what a running hook's lock looks like.
    const release = lockFile(upLockPath(d.store.root), d.now())!;
    try {
      let code: number | undefined;
      const line = await captureLog(async () => { code = await main(["up"], d); });
      expect(code).toBe(0);
      expect(line).toStartWith("UP BUSY name=seori ");
      expect(w.panes.size).toBe(0);
    } finally {
      release();
    }
  });

  test("a run record from before this boot is not a live runner, whatever its pid", async () => {
    const w = new World();
    const d = w.deps();
    mkdirSync(join(d.store.root, "run"));
    const path = recordPath(d.store.root, "daemon-loop");
    // A live pid (this process), as a reused pid would be after a reboot on macOS.
    writeFileSync(path, JSON.stringify({ pid: process.pid }));
    expect(liveRunners(d.store.root)).toEqual(["daemon-loop"]);
    const longAgo = new Date(Date.now() - 10 * 365 * 24 * 3_600_000);
    utimesSync(path, longAgo, longAgo);
    expect(liveRunners(d.store.root)).toEqual([]);
    expect((await upCheck(d, "seori")).kind).toBe("fresh");
  });
});

describe("the start-up line a new lead gets", () => {
  test("a delivery that typed nothing is tried again, and false comes back after the last try", async () => {
    const w = new World();
    const rt = w.runtime();
    let tries = 0;
    rt.deliver = async () => (tries++, { kind: "not-ready", status: "working" });
    const d = { ...w.deps(), runtime: rt };
    const t0 = d.now();
    expect(await wakeNewLead(d, paneRef("t1"), 3)).toBe(false);
    expect(tries).toBe(3);
    // Between tries the fake clock moved, never the real one.
    expect(d.now() - t0).toBe(2 * LEAD_START_WAIT_MS);
  });

  test("an uncertain delivery is never retried: the line may already be in the pane", async () => {
    const w = new World();
    const rt = w.runtime();
    const sent: string[] = [];
    rt.deliver = async (_ref, text) => (sent.push(text), { kind: "ambiguous", detail: "hc send did not complete", failure: new Error("timeout") });
    const d = { ...w.deps(), runtime: rt };
    await expect(wakeNewLead(d, paneRef("t1"), 3)).rejects.toThrow(DeliveryUncertain);
    expect(sent).toEqual([LEAD_START_LINE]);
  });

  test("an up whose lead never took the line says so on stderr and still opens the home", async () => {
    const w = new World();
    const rt = w.runtime();
    const real = rt.deliver.bind(rt);
    // The lead's start-up line is refused; everything else is delivered as the fake world does.
    rt.deliver = async (ref, text, opts) => (text === LEAD_START_LINE ? { kind: "not-ready", status: "working" } : real(ref, text, opts));
    const d = { ...w.deps(), runtime: rt, platform: "darwin" as const };
    // A heartbeat dated past the two refused tries' waits, so the daemon counts as started without a real-time wait.
    w.heartbeat(d.store.root, -(3 * LEAD_START_WAIT_MS));
    const errors: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    let line = "";
    try {
      line = await captureLog(() => up(d, undefined));
    } finally {
      console.error = error;
    }
    expect(line).toStartWith("UP lead=");
    expect(errors.filter((e) => e.includes("did not take its start-up line (its agent was not ready for it)"))).toHaveLength(1);
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
    expect(started[0]!.argv.join(" ")).toContain("down all --keep-autostart");
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

  test("a restart while another of this home is running is refused before anything starts", async () => {
    const { d, started } = home();
    const spawn = async (argv: readonly string[], cwd: string) => (started.push({ argv, cwd }), 0);
    mkdirSync(join(d.store.root, "run"), { recursive: true });
    // This test process is alive: what a worker's pid file looks like while it runs.
    writeFileSync(restartPidPath(d.store.root), `${process.pid}\n`);
    expect(runningRestart(d.store.root)).toBe(process.pid);
    await expect(restart(d, undefined, false, () => {}, { spawn, has: () => true })).rejects.toThrow(
      `a restart of this home is already running (pid ${process.pid}); its steps are in ${join(d.store.root, "restart.log")}`,
    );
    expect(started).toEqual([]);
    // A pid that ended, or a file from before this boot, is no running restart.
    expect(runningRestart(d.store.root, () => false)).toBeUndefined();
    const longAgo = new Date(Date.now() - 10 * 365 * 24 * 3_600_000);
    utimesSync(restartPidPath(d.store.root), longAgo, longAgo);
    expect(runningRestart(d.store.root)).toBeUndefined();
    expect(await restart(d, undefined, false, () => {}, { spawn, has: (b) => b === "setsid" })).toBe(0);
    expect(started).toHaveLength(1);
  });

  test("a way that fails to start falls through to the next, and only when every way fails is it a failure", async () => {
    const { d } = home();
    const tried: string[] = [];
    // A setsid without --fork (busybox) exits non-zero having started nothing; systemd-run then starts the worker.
    const spawn = async (argv: readonly string[]) => (tried.push(argv[0]!), argv[0] === "setsid" ? 1 : 0);
    const lines: string[] = [];
    expect(await restart(d, undefined, false, (l) => void lines.push(l), { spawn, has: () => true })).toBe(0);
    expect(tried).toEqual(["setsid", "systemd-run"]);
    expect(lines.at(-1)).toContain("RESTARTING detached");
  });

  test("a worker that could not be started by any way says so instead of claiming a restart", async () => {
    const { d } = home();
    const lines: string[] = [];
    const code = await restart(d, undefined, false, (l) => void lines.push(l), { spawn: async () => 3, has: () => true });
    expect(code).toBe(1);
    expect(lines).toEqual([
      `RESTART_FAILED could not detach the relaunch (setsid exit 3, systemd-run exit 3, nohup exit 3); nothing was stopped. ` +
        `See ${join(d.store.root, "restart.log")}`,
    ]);
  });

  test("without --cwd the agents come back where the home's units run, not in $SEORI_HOME", async () => {
    const { d: base, started } = home();
    const d = { ...base, platform: "linux" as const };
    const saved = process.env["SEORI_SYSTEMD_DIR"];
    process.env["SEORI_SYSTEMD_DIR"] = mkdtempSync(join(tmpdir(), "seori-restart-units-"));
    try {
      const work = mkdtempSync(join(tmpdir(), "seori-restart-work-"));
      const spawn = async (argv: readonly string[], cwd: string) => (started.push({ argv, cwd }), 0);
      // No units: $SEORI_HOME, as a bare `seori up` would.
      await restart(d, undefined, false, () => {}, { spawn, has: (b) => b === "setsid" });
      expect(started.at(-1)!.argv.at(-1)).toContain(`up --cwd '${d.store.root}'`);
      writeUnits(unitDir(), { instance: "seori", home: d.store.root, cwd: work, bun: "/b/bun", cli: "/s/cli.ts", env: {} });
      await restart(d, undefined, false, () => {}, { spawn, has: (b) => b === "setsid" });
      expect(started.at(-1)!.argv.at(-1)).toContain(`up --cwd '${work}'`);
      // --cwd still wins.
      await restart(d, "/elsewhere", false, () => {}, { spawn, has: (b) => b === "setsid" });
      expect(started.at(-1)!.argv.at(-1)).toContain(`up --cwd '/elsewhere'`);
    } finally {
      if (saved === undefined) delete process.env["SEORI_SYSTEMD_DIR"];
      else process.env["SEORI_SYSTEMD_DIR"] = saved;
    }
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
    // The worker is a real process, so --follow polls the log on the real clock: d.sleep and d.now are one clock, and a
    // fake sleep with a real deadline would spin. The bound is the test timeout.
    const d = { ...w.deps(), seoriCmd: join(dir, "seori"), sleep: (ms: number) => Bun.sleep(ms), now: () => Date.now() };
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
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["CALLED down all --keep-autostart", `CALLED up --cwd ${d.store.root}`]);
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
