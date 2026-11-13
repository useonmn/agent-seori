#!/usr/bin/env bun
// A stand-in for `systemctl --user` in the real-omp hc e2e suites (test/e2e-hc-omp.ts): no test may touch the owner's
// user manager, yet the lead channel needs the daemon, duty loop and hourly loop that `seori up` runs as units.
// `enable --now U...` starts each unit's ExecStart= the way systemd would (Environment=, WorkingDirectory=, a session
// and process group of its own, a minimal base env) and records its main pid; `stop U...` sends SIGTERM to that main
// pid only and SIGKILLs its process group after 30 s (TimeoutStopSec). There is no Restart=: the daemon unit's own
// `seori daemon-loop` is what restarts the daemon. Every call is logged. E2E_SYSTEMCTL_STATE is the state dir.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const state = process.env["E2E_SYSTEMCTL_STATE"];
const units = process.env["SEORI_SYSTEMD_DIR"];
if (!state || !units) {
  process.stderr.write("fake systemctl: E2E_SYSTEMCTL_STATE and SEORI_SYSTEMD_DIR must be set\n");
  process.exit(1);
}
mkdirSync(state, { recursive: true });
appendFileSync(join(state, "systemctl.log"), `${args.join(" ")}\n`);

/** systemd's quoting as src/systemd.ts writes it: "..." with \\ and \" escaped, %% for %, and $$ for $ in ExecStart=. */
const unquote = (word: string, exec: boolean): string => {
  const inner = word.slice(1, -1).replace(/\\(.)/g, "$1").replace(/%%/g, "%");
  return exec ? inner.replace(/\$\$/g, "$") : inner;
};
const words = (line: string): string[] => line.match(/"(?:[^"\\]|\\.)*"/g) ?? [];

function startUnit(unit: string): void {
  const text = readFileSync(join(units!, unit), "utf8");
  const env: Record<string, string> = {};
  // What a user manager gives every unit, before Environment=.
  for (const k of ["HOME", "USER", "LOGNAME", "LANG"]) if (process.env[k]) env[k] = process.env[k]!;
  let cwd = "/";
  let argv: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("Environment=")) {
      const kv = unquote(words(line)[0] ?? '""', false);
      const eq = kv.indexOf("=");
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (line.startsWith("WorkingDirectory=")) cwd = line.slice("WorkingDirectory=".length).replace(/%%/g, "%");
    else if (line.startsWith("ExecStart=")) argv = words(line).map((w) => unquote(w, true));
  }
  if (argv.length === 0) throw new Error(`fake systemctl: no ExecStart= in ${unit}`);
  const out = openSync(join(state!, `${unit}.log`), "a");
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", out, out] });
  if (child.pid === undefined) throw new Error(`fake systemctl: ${unit} did not start`);
  writeFileSync(join(state!, `${unit}.pid`), String(child.pid));
  child.unref();
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stopUnit(unit: string): Promise<void> {
  const file = join(state!, `${unit}.pid`);
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8"));
  if (!alive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(100);
  if (alive(pid)) process.kill(-pid, "SIGKILL");
}

const [, verb, ...rest] = args; // args[0] is --user
if (verb === "enable" && rest[0] === "--now") for (const u of rest.slice(1)) startUnit(u);
else if (verb === "stop") for (const u of rest) await stopUnit(u);
// show-environment, daemon-reload and disable succeed and do nothing.
