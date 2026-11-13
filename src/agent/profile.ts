import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { ConfigError } from "../config.ts";

// The agent seori starts in every pane (lead, duty, lanes) and runs as the reviewer. seori runs omp only: SEORI_AGENT
// and `"agent"` in $SEORI_HOME/config.json may name it, and any other value is refused.

export type AgentKind = "omp";
export type AgentSource = "env" | "config" | "default";
export type AgentChoice = { readonly profile: AgentProfile; readonly source: AgentSource };

/** An agent setting that is present but unusable (a bad value, an unreadable config file). */
export class AgentConfigError extends ConfigError {}

type Env = Readonly<Record<string, string | undefined>>;

export type AgentProfile = {
  readonly kind: AgentKind;
  /** The launch command when SEORI_AGENT_CMD is unset. */
  readonly command: string;
  /** The prompt delivered into a new lane's agent that starts its goal; it names the lane key. */
  kickoff(briefPath: string, key: string): string;
  /** Environment for every agent pane of the home `root` (lead, duty, lanes), on top of paneEnv. */
  agentEnv(root: string): Record<string, string>;
  /** Environment for the lead's pane (replaces agentEnv there). */
  leadEnv(root: string): Record<string, string>;
  /** The reviewer's argv after the command: non-interactive, JSON events, nothing loaded from the cwd. */
  reviewArgs(text: string, model: string | undefined): string[];
};

// ---------- omp ----------

/**
 * omp settings for every agent seori starts in a pane (lead, duty, lanes): the setup wizard off. omp opens its onboarding
 * wizard whenever its stored setup version is older than the installed omp's, even with a provider logged in, and an
 * agent pane has nobody to click through it: the agent never starts and text seori delivers lands in the wizard.
 */
export const AGENT_OMP_CONFIG = "startup:\n  setupWizard: false\n";

/** The home seori uses when SEORI_HOME is unset: the first instance on a PC. */
export const DEFAULT_HOME = join(homedir(), ".seori");

const sameDir = (a: string, b: string): boolean => resolve(a) === resolve(b);

/** Where the agents of a home other than DEFAULT_HOME keep their omp memory (mnemopi's SQLite DB and its banks). */
export const ompMemoryDb = (root: string): string => join(root, "omp", "memories", "mnemopi.db");

/**
 * agent-omp.yml for a home. omp's mnemopi memory is one DB for every omp on the PC (its banks sit next to that DB), so
 * two seori instances would recall each other's memories. Every home but DEFAULT_HOME points `mnemopi.dbPath` into
 * itself; DEFAULT_HOME keeps omp's own DB, so the first instance keeps the memory it has. JSON quoting is valid YAML.
 */
export function agentOmpConfig(root: string, defaultHome: string = DEFAULT_HOME): string {
  if (sameDir(root, defaultHome)) return AGENT_OMP_CONFIG;
  return `${AGENT_OMP_CONFIG}mnemopi:\n  dbPath: ${JSON.stringify(ompMemoryDb(root))}\n`;
}

/**
 * Writes `$SEORI_HOME/prompts/agent-omp.yml` (agentOmpConfig) and returns the PI_CONFIG_FILES value that loads it after
 * the files already in `inherited`, then `extra` (the lead's own file). seori's own files in `inherited` are dropped: a
 * lane started from the lead's shell inherits the lead's value and must not load the lead's settings.
 */
export function agentOmpConfigFiles(root: string, extra: readonly string[] = [], inherited = process.env["PI_CONFIG_FILES"]): string {
  const dir = join(root, "prompts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent-omp.yml");
  writeFileSync(path, agentOmpConfig(root));
  const kept = (inherited ?? "").split(delimiter).filter((file) => file && dirname(file) !== dir);
  return [...kept, path, ...extra].join(delimiter);
}

/**
 * Writes `$SEORI_HOME/prompts/lead-omp.yml` (omp settings for the lead only: advisor.syncBacklog strict, so the
 * advisor's agent-end review finishes before agent_end and reply drafts are released only after it, src/release.ts)
 * and returns the PI_CONFIG_FILES value that loads it after every agent's settings (agentOmpConfigFiles).
 */
export function leadOmpConfig(root: string): string {
  const dir = join(root, "prompts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "lead-omp.yml");
  writeFileSync(path, "advisor:\n  syncBacklog: strict\n");
  return agentOmpConfigFiles(root, [path]);
}

export const ompProfile: AgentProfile = {
  kind: "omp",
  command: "omp",
  kickoff: (briefPath, key) =>
    `/goal Read your brief at ${briefPath} and execute it. Your lane key is ${key}. ` +
    `The work is finished only when the brief's exit condition holds and you have sent seori ready.`,
  agentEnv: (root) => ({ PI_CONFIG_FILES: agentOmpConfigFiles(root) }),
  leadEnv: (root) => ({ PI_CONFIG_FILES: leadOmpConfig(root) }),
  reviewArgs: (text, model) => [
    "-p", "--no-session", "--mode", "json", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files",
    "--approval-mode", "yolo", ...(model ? ["--model", model] : []), text,
  ],
};

/** The one line seori prints when SEORI_AGENT or config.json names an agent other than omp. */
export const unsupportedAgent = (value: unknown): string =>
  `seori: agent ${JSON.stringify(typeof value === "string" ? value : String(JSON.stringify(value)))} is not supported; seori runs omp only`;

const isKind = (v: unknown): v is AgentKind => v === "omp";

function configAgent(configPath: string): AgentKind | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AgentConfigError(`cannot read ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new AgentConfigError(`${configPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AgentConfigError(`${configPath} must hold a JSON object`);
  const value = (parsed as Record<string, unknown>)["agent"];
  if (value === undefined) return undefined;
  if (!isKind(value)) throw new AgentConfigError(unsupportedAgent(value));
  return value;
}

/**
 * The test-only switch that lets SEORI_AGENT_CMD name a command other than omp (the fake-omp fixture of the hc e2e).
 * Only the process environment sets it: loadConfig never reads it and the systemd units never pass it on.
 */
export const TEST_AGENT_CMD_SWITCH = "SEORI_TEST_ANY_AGENT_CMD";

/** The one line seori prints when SEORI_AGENT_CMD names a command that is not omp. */
export const unsupportedAgentCmd = (cmd: string): string =>
  `seori: SEORI_AGENT_CMD ${JSON.stringify(cmd)} is not omp; seori runs omp only`;

/** Whether a SEORI_AGENT_CMD value is omp: its basename (a path to an omp binary or wrapper named omp) is `omp`. */
export const isOmpCommand = (cmd: string): boolean => basename(cmd) === "omp";

/**
 * The command seori runs for the agent: SEORI_AGENT_CMD when set, else the profile's. A SEORI_AGENT_CMD whose basename is
 * not `omp` is refused unless TEST_AGENT_CMD_SWITCH is "1" in the environment.
 */
export function agentCommand(profile: AgentProfile, env: Env = process.env): string {
  const cmd = env["SEORI_AGENT_CMD"];
  if (!cmd) return profile.command;
  if (!isOmpCommand(cmd) && env[TEST_AGENT_CMD_SWITCH] !== "1") throw new AgentConfigError(unsupportedAgentCmd(cmd));
  return cmd;
}

/** The agent profile of the home `root`, and why: SEORI_AGENT > config.json `agent` > omp. Only omp is accepted. */
export function selectAgent(root: string, env: Env = process.env): AgentChoice {
  const fromEnv = env["SEORI_AGENT"];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isKind(fromEnv)) throw new AgentConfigError(unsupportedAgent(fromEnv));
    return { profile: ompProfile, source: "env" };
  }
  if (configAgent(join(root, "config.json")) !== undefined) return { profile: ompProfile, source: "config" };
  return { profile: ompProfile, source: "default" };
}
