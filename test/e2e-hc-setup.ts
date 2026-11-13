// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { TEST_AGENT_CMD_SWITCH } from "../src/agent/profile.ts";
import { socketRootBase } from "./socket-budget.ts";

// One isolated hc core for the CLI e2e file, only with SEORI_E2E_HC=1: its own HC_SESSION and XDG dirs, so the host's
// own cores (the default core included) are never reached. `hc server stop` in stopCore is the last hc call. Linux
// only: the scenarios drive seori up's systemd --user path, which macOS does not take (it keeps hc terminals).
export const enabled = process.env["SEORI_E2E_HC"] === "1" && Bun.which("hc") !== null && process.platform === "linux";
export const session = `e2e-${process.pid}`;
// A Unix socket path is capped at ~107 bytes: the core's socket lands at <root>/r/herdr-core/<session>.sock, so the
// root stays short. os.tmpdir() is used only while every socket fits (the holder's is the longest); else /tmp.
const base = socketRootBase(tmpdir(), session);
const root = enabled ? mkdtempSync(join(base, "sehc-")) : "";
const [state, run, config] = [join(root, "s"), join(root, "r"), join(root, "c")];
const socket = join(run, "herdr-core", `${session}.sock`);
const cli = resolve(import.meta.dir, "../src/cli.ts");
export const fixture = resolve(import.meta.dir, "fixtures/fake-omp.ts");

// The caller's own runtime identity and seori settings are dropped: inside a terminal of another core, seori would reach
// that core instead, and an inherited SEORI_HOME / SEORI_LANE / SEORI_CMD would point at the caller's home.
const {
  HC_TERMINAL_ID: _id,
  HC_TERMINAL_SOCKET: _sock,
  HC_SCOPE: _scope,
  HC_SOCKET: _hcSock,
  HC_SESSION: _session,
  SEORI_HOME: _home,
  SEORI_CMD: _cmd,
  SEORI_LANE: _lane,
  SEORI_AGENT: _agent,
  SEORI_AGENT_CMD: _agentCmd,
  [TEST_AGENT_CMD_SWITCH]: _anyAgentCmd,
  SEORI_MODEL: _model,
  SEORI_SYSTEMD_DIR: _units,
  SEORI_SYSTEMCTL: _ctl,
  ...outer
} = process.env;
// bun's own dir first on PATH: the fixture's `#!/usr/bin/env bun` must find this bun inside the core's terminals.
const path = [dirname(process.execPath), outer["PATH"] ?? ""].join(delimiter);
const hcEnv = { ...outer, PATH: path, HC_SESSION: session, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: run, XDG_CONFIG_HOME: config };

/** The fake systemctl: logs its argv; enabling the daemon unit writes the heartbeat the real daemon would. */
export const systemctl = join(root, "bin", "systemctl");
export const systemctlLog = join(root, "systemctl.log");
export const unitDir = join(root, "units");

/**
 * The env of every `seori` (and of the core, so its terminals inherit it). The fixture stands in for omp, admitted by the
 * test-only switch (a SEORI_AGENT_CMD that is not omp is refused otherwise); units go to a temp dir and systemctl is the
 * fake, so no test reaches the real user manager.
 */
export const seoriEnv = (home: string) => ({
  ...hcEnv,
  SEORI_HOME: home,
  SEORI_RUNTIME: "hc",
  SEORI_AGENT_CMD: fixture,
  [TEST_AGENT_CMD_SWITCH]: "1",
  SEORI_SYSTEMD_DIR: unitDir,
  SEORI_SYSTEMCTL: systemctl,
});

export const newHome = (name: string): string => {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return home;
};

const spawn = async (argv: string[], env: Record<string, string | undefined>) => {
  const p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

export async function hc(...argv: string[]): Promise<Record<string, unknown>> {
  const r = await spawn(["hc", "--json", ...argv], hcEnv);
  if (r.code !== 0) throw new Error(`hc ${argv.join(" ")} -> ${r.code}: ${r.err || r.out}`);
  return JSON.parse(r.out || "{}");
}

export async function seori(home: string, ...argv: string[]): Promise<string> {
  const r = await spawn(["bun", cli, ...argv], seoriEnv(home));
  if (r.code !== 0) throw new Error(`seori ${argv.join(" ")} -> ${r.code}: ${r.err}${r.out}`);
  return r.out;
}

export async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
}

export const terminal = (address: string) => hc("get", address);
export const statusOf = (t: Record<string, unknown>): string | undefined =>
  (t["status"] as { state?: string } | null)?.state;
export const screen = async (address: string): Promise<string> =>
  String((await hc("read", address, "--lines", "50"))["text"] ?? "");
export const waitStatus = (address: string, word: string) =>
  until(`${address} ${word}`, async () => (statusOf(await terminal(address)) === word ? true : undefined));

let corePid: number | undefined;

export async function startCore(): Promise<void> {
  for (const dir of [state, run, join(config, "herdr-core"), join(root, "bin")]) mkdirSync(dir, { recursive: true });
  chmodSync(run, 0o700);
  writeFileSync(join(config, "herdr-core", "config.toml"), "notes = false\n");
  writeFileSync(systemctlLog, "");
  writeFileSync(
    systemctl,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${systemctlLog}'`,
      'case "$*" in',
      '  *"enable --now "*-daemon.service*)',
      '    mkdir -p "$SEORI_HOME/messenger"',
      `    printf '{"at":%s}\\n' "$(date +%s%3N)" > "$SEORI_HOME/messenger/daemon.heartbeat" ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(systemctl, 0o755);
  // Started with the seori env so terminals opened by `seori` inherit SEORI_RUNTIME, PATH and the isolation.
  const r = await spawn(["hc", "--json", "server", "start"], seoriEnv(newHome("core")));
  if (r.code !== 0) throw new Error(`hc server start -> ${r.code}: ${r.err}`);
  corePid = Number((await hc("server", "status"))["pid"]);
  if (!existsSync(socket)) throw new Error(`the isolated core's socket ${socket} is missing`);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Kills and removes what is left, stops the core and proves it is gone: its pid exited and its runtime dir is empty.
 * `hc server status` cannot prove that, since it starts a core when none answers.
 */
export async function stopCore(): Promise<{ pid: number | undefined; alive: boolean; sockets: string[] }> {
  try {
    for (const t of ((await hc("ls", "--all"))["terminals"] ?? []) as { address: string }[]) {
      await hc("kill", t.address).catch(() => undefined);
      await hc("rm", t.address).catch(() => undefined);
    }
  } finally {
    await spawn(["hc", "--json", "server", "stop"], hcEnv); // the last hc call
  }
  const pid = corePid;
  if (pid !== undefined) await until("the core to exit", async () => (alive(pid) ? undefined : true), 10_000);
  const dir = join(run, "herdr-core");
  const result = { pid, alive: pid !== undefined && alive(pid), sockets: existsSync(dir) ? readdirSync(dir) : [] };
  rmSync(root, { recursive: true, force: true });
  return result;
}
