import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isOmpCommand } from "./agent/profile.ts";
import { ConfigError } from "./config.ts";

// The resident processes of an hc home (messenger daemon, duty loop, hourly loop) run as systemd --user units, so they
// come back after a WSL boot and are restarted when they crash. `seori up` writes, enables and starts them; `seori down`
// stops, disables and removes them. One set per home: units are named after the home's instance name and a hash of
// the home, so two homes that share an instance name never share units.

type Env = Readonly<Record<string, string | undefined>>;

/** The three resident processes, the unit name suffix of each and the seori command it runs. */
export const UNIT_KINDS = ["daemon", "duty", "hourly"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/**
 * The logon hook (`seori autostart install`): a oneshot that runs `seori up --wait-hc` once, so the lead and duty
 * panes come back after a reboot. It is a boot hook, not a runner: it is not in RUNNERS or liveRunners, so it never
 * counts as this home being up, and it has no Restart= (a boot hook that restarts itself is a loop waiting to happen).
 */
export const BOOT_KIND = "boot";
export type UnitSpecKind = UnitKind | typeof BOOT_KIND;

const COMMAND: Readonly<Record<UnitSpecKind, readonly string[]>> = {
  daemon: ["daemon-loop"],
  duty: ["duty", "--interval", "60"],
  hourly: ["loop"],
  boot: ["up", "--wait-hc"],
};

const DESCRIPTION: Readonly<Record<UnitSpecKind, string>> = {
  daemon: "messenger daemon",
  duty: "duty loop",
  hourly: "hourly loop",
  boot: "logon autostart (up --wait-hc)",
};

/** Variables a unit passes on from the `seori up` that wrote it, when set there (never the caller's HC_TERMINAL_*). */
const PASSED_ON = ["SEORI_MODEL", "SEORI_AGENT", "SEORI_AGENT_CMD", "SEORI_CMD", "HC_SESSION", "HC_SOCKET", "XDG_RUNTIME_DIR"] as const;

/** Where unit files go: SEORI_SYSTEMD_DIR, else ~/.config/systemd/user (XDG_CONFIG_HOME honoured). */
export function unitDir(env: Env = process.env): string {
  const override = env["SEORI_SYSTEMD_DIR"];
  if (override) return override;
  return join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "systemd", "user");
}

/**
 * A unit name part for an instance name: [A-Za-z0-9:_.-] is kept, every other byte becomes \xNN (systemd's escape),
 * so a name in any script still makes a valid unit name.
 */
export function unitInstance(name: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(name)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9:_.-]/.test(c) && byte < 0x80 ? c : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** 8 hex digits of sha256 of the resolved SEORI_HOME: tells apart the units of homes that share an instance name. */
export const homeTag = (home: string): string => createHash("sha256").update(resolve(home)).digest("hex").slice(0, 8);

/** seori-<instance>-<homeTag>-<kind>.service */
export const unitName = (instance: string, home: string, kind: UnitSpecKind): string =>
  `seori-${unitInstance(instance)}-${homeTag(home)}-${kind}.service`;

/** The name earlier versions gave a unit (no home hash); `seori down` removes such units when they belong to its home. */
export const legacyUnitName = (instance: string, kind: UnitKind): string => `seori-${unitInstance(instance)}-${kind}.service`;

/** A unit file or its value could not be written: the message is one line for the user. */
export class UnitError extends ConfigError {}

/**
 * PATH for a unit: the caller's PATH without entries that only make sense inside the caller's session (an agent's
 * per-session command wrappers under kill-guard/) or that point into a Windows drive mounted under /mnt (WSL).
 */
export function unitPath(path: string): string {
  return path
    .split(":")
    .filter((dir) => dir !== "" && !dir.includes("/kill-guard/") && !dir.startsWith("/mnt/"))
    .join(":");
}

/** One assignment in Environment=: double-quoted, with \, " and % escaped. systemd does not expand $ there. */
const envWord = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** One word of ExecStart=: as envWord, and $ escaped as $$ (systemd expands $VAR in ExecStart=). */
const execWord = (s: string): string => envWord(s).replace(/\$/g, "$$$$");

/** Refuses a value that would end its line in a unit file and start another directive. */
function oneLine(what: string, value: string): void {
  if (/[\n\r]/.test(value)) throw new UnitError(`seori: cannot write the systemd units: ${what} contains a line break (\\n or \\r)`);
}

export type UnitSpec = {
  /** The home's instance name (config.json `name`). */
  readonly instance: string;
  /** SEORI_HOME of the home. */
  readonly home: string;
  /** The working directory of every process. */
  readonly cwd: string;
  /** The bun binary and seori's cli.ts that ExecStart runs. */
  readonly bun: string;
  readonly cli: string;
  /** The environment of the `seori up` that writes the units: PATH and the PASSED_ON variables are taken from it. */
  readonly env: Env;
};

/**
 * The unit file text for one resident process, or for the logon hook. The boot hook is a oneshot with no Restart=: it
 * runs `seori up --wait-hc` once at logon and ends (exit 0 also when hc is not up yet, which it says on stdout).
 */
export function unitFile(spec: UnitSpec, kind: UnitSpecKind): string {
  const vars: [string, string][] = [["SEORI_HOME", spec.home]];
  const path = unitPath(spec.env["PATH"] ?? "");
  if (path) vars.push(["PATH", path]);
  for (const key of PASSED_ON) {
    const value = spec.env[key];
    // A SEORI_AGENT_CMD that is not omp only gets this far under the test-only switch (agentCommand), which no unit
    // carries: the units run omp.
    if (key === "SEORI_AGENT_CMD" && value && !isOmpCommand(value)) continue;
    if (value) vars.push([key, value]);
  }
  for (const [key, value] of vars) oneLine(key, value);
  oneLine("the working directory", spec.cwd);
  oneLine("the bun path", spec.bun);
  oneLine("the cli path", spec.cli);
  const boot = kind === BOOT_KIND;
  return [
    "[Unit]",
    `Description=seori ${spec.instance} ${DESCRIPTION[kind]} (SEORI_HOME=${spec.home.replace(/%/g, "%%")})`,
    // The hook waits for hc itself (up --wait-hc polls the core), so it needs no ordering against the graphical session.
    "",
    "[Service]",
    `Type=${boot ? "oneshot" : "simple"}`,
    ...vars.map(([k, v]) => `Environment=${envWord(`${k}=${v}`)}`),
    // WorkingDirectory= takes the rest of the line as the path: systemd rejects a quoted value as "not absolute".
    `WorkingDirectory=${spec.cwd.replace(/%/g, "%%")}`,
    `ExecStart=${[spec.bun, spec.cli, ...COMMAND[kind]].map(execWord).join(" ")}`,
    ...(boot
      ? [
          // A boot hook that restarts itself is a loop: it runs once per logon and ends. `up --wait-hc` already answers
          // exit 0 when hc never came up, so a failure here is a real one and is left to systemd to record.
          "Restart=no",
          "TimeoutStartSec=infinity",
        ]
      : [
          "Restart=on-failure",
          "RestartSec=2",
          // A deliberate stop (Ctrl-C 130, SIGTERM or `seori down` 143) is not a failure to restart from.
          "SuccessExitStatus=130 143",
        ]),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export type Systemctl = (args: readonly string[]) => Promise<void>;

/**
 * `systemctl --user <args>`; SEORI_SYSTEMCTL replaces the systemctl command (tests point it at a fake). A non-zero exit
 * throws with systemctl's output.
 */
export function systemctl(env: Env = process.env): Systemctl {
  return async (args) => {
    const cmd = env["SEORI_SYSTEMCTL"] || "systemctl";
    const argv = [cmd, "--user", ...args];
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${argv.join(" ")} failed (${code}): ${(stderr.trim() || stdout.trim() || "no output")}`);
  };
}

/**
 * The SEORI_HOME a unit file in `dir` runs with, or undefined when the file is missing or has none. Files written before
 * Environment= stopped escaping $ hold it as $$, so `legacy` undoes that too.
 */
export function unitHome(dir: string, name: string, legacy = false): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch {
    return undefined;
  }
  const m = /^Environment="SEORI_HOME=((?:[^"\\]|\\.)*)"$/m.exec(text);
  if (!m) return undefined;
  const value = m[1]!.replace(/\\(.)/g, "$1").replace(/%%/g, "%");
  return legacy ? value.replace(/\$\$/g, "$") : value;
}

const sameHome = (a: string | undefined, b: string): boolean => a !== undefined && resolve(a) === resolve(b);

/**
 * Writes the three unit files of an instance into `dir` and returns their names in UNIT_KINDS order. A unit file of
 * that name that runs another SEORI_HOME is refused, never overwritten.
 */
export function writeUnits(dir: string, spec: UnitSpec): string[] {
  return writeKinds(dir, spec, UNIT_KINDS);
}

/** Writes the unit files of `kinds` (writeUnits' rule for another home's file applies to each). */
function writeKinds(dir: string, spec: UnitSpec, kinds: readonly UnitSpecKind[]): string[] {
  const files = kinds.map((kind) => [unitName(spec.instance, spec.home, kind), unitFile(spec, kind)] as const);
  for (const [name] of files) {
    const other = unitHome(dir, name);
    if (other !== undefined && !sameHome(other, spec.home)) {
      throw new UnitError(`seori: the systemd unit ${name} in ${dir} runs SEORI_HOME=${other}, not ${spec.home}; run seori down there first`);
    }
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(dir, name), text);
  return files.map(([name]) => name);
}

/**
 * Writes the logon hook's unit and enables it, without starting it: it is a boot hook, so what it does at an install is
 * become part of the next logon, not open panes now (`seori up` does that). Returns its name; a unit of that name that
 * runs another home is refused by writeKinds.
 */
export async function installBootUnit(dir: string, spec: UnitSpec, ctl: Systemctl): Promise<string> {
  const [name] = writeKinds(dir, spec, [BOOT_KIND]);
  await ctl(["daemon-reload"]);
  await ctl(["enable", name!]);
  return name!;
}

/** Whether the home's logon hook is installed in `dir`. */
export function bootUnitInstalled(dir: string, instance: string, home: string): string | undefined {
  const name = unitName(instance, home, BOOT_KIND);
  return sameHome(unitHome(dir, name), home) ? name : undefined;
}

/**
 * The unit files of the home's instance that exist in `dir`, of the given kinds: the current names, and the names
 * earlier versions used (legacyUnitName) when that file runs this home.
 */
export function installedUnits(dir: string, instance: string, home: string, kinds: readonly UnitSpecKind[] = UNIT_KINDS): string[] {
  const current = kinds.map((kind) => unitName(instance, home, kind)).filter((name) => existsSync(join(dir, name)));
  // The names earlier versions used exist only for the three resident processes, never for the logon hook.
  const legacy = kinds
    .flatMap((kind) => (kind === BOOT_KIND ? [] : [legacyUnitName(instance, kind)]))
    .filter((name) => sameHome(unitHome(dir, name, true), home));
  return [...current, ...legacy];
}

/**
 * Stops and disables the units of `kinds` the home has installed (installedUnits), removes their files and reloads
 * systemd. Returns one STOPPED UNIT line per unit (none when no unit file is there: a home not started by `seori up` on hc).
 * With no reachable user manager nothing can run the units: stop, disable and reload are skipped, the files are still
 * removed (REMOVED UNIT lines), so `seori down` and `seori uninstall` always finish.
 */
export async function removeUnits(dir: string, instance: string, home: string, kinds: readonly UnitSpecKind[], ctl: Systemctl): Promise<string[]> {
  const names = installedUnits(dir, instance, home, kinds);
  if (names.length === 0) return [];
  // A unit that never loaded (a bad file, or one already stopped by hand) makes `stop` fail with "not loaded"; that
  // unit is already stopped, so only that failure is ignored. `disable` alone works for loaded and unloaded units.
  let noBus = false;
  await ctl(["stop", ...names]).catch((e: unknown) => {
    if (/Failed to connect to (user scope )?bus/.test(String(e))) noBus = true;
    else if (!/not loaded/.test(String(e))) throw e;
  });
  if (noBus) {
    for (const name of names) rmSync(join(dir, name), { force: true });
    return names.map((name) => `REMOVED UNIT ${name} (systemd --user not reachable: not stopped or disabled; removed from ${dir})`);
  }
  await ctl(["disable", ...names]);
  for (const name of names) rmSync(join(dir, name), { force: true });
  await ctl(["daemon-reload"]);
  return names.map((name) => `STOPPED UNIT ${name} (disabled, removed from ${dir})`);
}
