// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { LedgerEvent } from "../src/channel.ts";
import { LEAD_EXTENSION } from "../src/cli.ts";
import { startAgent, type Deps } from "../src/harness.ts";
import { shq, spawnExec } from "../src/runtime/exec.ts";
import { envExec } from "../src/runtime/hc/exec.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { socketRootBase } from "./socket-budget.ts";

// The rig of the real-omp hc suites (e2e-hc-channel, e2e-hc-watch, e2e-hc-lanes): one isolated hc core per file and a
// REAL omp (model calls, costs money). Opt-in with SEORI_E2E_HC=1 and SEORI_E2E_OMP=1, hc and omp on PATH, Linux only
// (seori up takes the systemd --user path there); SEORI_E2E_MODEL picks the model, else omp's own default. Like
// e2e-hc-setup.ts: the core has its own HC_SESSION and XDG dirs under a short temp root, the caller's HC_* / SEORI_*
// (and omp's PI_*) vars are dropped, and `hc server stop` is the last hc call. Units go to a temp dir and systemctl is
// test/fixtures/fake-systemctl.ts, which runs them as plain processes, so the owner's user manager is never reached.
// The throwaway SEORI_HOME lives under the same root; stop() removes it all. omp itself keeps its own config and
// writes its session files where it always does (~/.omp/agent/sessions), which the scenarios read.
export const enabled =
  process.env["SEORI_E2E_HC"] === "1" &&
  process.env["SEORI_E2E_OMP"] === "1" &&
  Bun.which("hc") !== null &&
  Bun.which("omp") !== null &&
  process.platform === "linux";
export const model = process.env["SEORI_E2E_MODEL"] || undefined;
export const cli = resolve(import.meta.dir, "../src/cli.ts");
const fakeSystemctl = resolve(import.meta.dir, "fixtures/fake-systemctl.ts");

export type Terminal = {
  status?: { state?: string; app?: string } | null;
  turn?: number;
  foreground?: { name?: string; pid?: number; argv?: string[] };
  state?: string;
};
export type JsonlRow = Record<string, unknown>;

export async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 30_000, every = 500): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(every);
  }
  throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
}

export const jsonl = <T>(path: string): T[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T) : [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const spawn = async (argv: string[], env: Record<string, string | undefined>, cwd?: string) => {
  const p = Bun.spawn(argv, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

/** One isolated core, one throwaway SEORI_HOME and the fake units of one test file. Construct only when enabled. */
export class OmpRig {
  readonly session: string;
  readonly root: string;
  readonly home: string;
  /** The env of the core (so of every terminal it opens) and of every `seori` this file runs. */
  readonly env: Record<string, string | undefined>;
  /** How an agent in a terminal of this core calls this seori. */
  readonly seoriCmd: string;
  private readonly hcEnv: Record<string, string | undefined>;
  private readonly unitState: string;
  /** The root with symlinks resolved: what omp records as an agent's cwd. */
  private readonly realRoot: string;
  private corePid: number | undefined;
  lead = "";
  duty = "";

  constructor(readonly tag: string) {
    this.session = `e2e-${tag}-${process.pid}`;
    this.root = mkdtempSync(join(socketRootBase(tmpdir(), this.session), "sehc-"));
    // realpath: omp records the resolved cwd in its session paths.
    this.realRoot = realpathSync(this.root);
    this.home = join(this.realRoot, "h");
    mkdirSync(this.home, { recursive: true });
    this.unitState = join(this.root, "ctl");
    const outer = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HC_|SEORI_|PI_|OMPCODE$|HERDR_)/.test(k)));
    // bun's own dir first on PATH: units and terminals run this bun.
    const path = [dirname(process.execPath), outer["PATH"] ?? ""].join(delimiter);
    this.hcEnv = {
      ...outer,
      PATH: path,
      HC_SESSION: this.session,
      XDG_STATE_HOME: join(this.root, "s"),
      XDG_RUNTIME_DIR: join(this.root, "r"),
      XDG_CONFIG_HOME: join(this.root, "c"),
    };
    this.env = {
      ...this.hcEnv,
      SEORI_HOME: this.home,
      SEORI_SYSTEMD_DIR: join(this.root, "units"),
      SEORI_SYSTEMCTL: fakeSystemctl,
      E2E_SYSTEMCTL_STATE: this.unitState,
      ...(model ? { SEORI_MODEL: model } : {}),
    };
    this.seoriCmd = `SEORI_HOME=${shq(this.home)} bun ${shq(cli)}`;
  }

  log(line: string): void {
    console.log(`[e2e-hc-${this.tag} ${new Date().toISOString().slice(11, 19)}] ${line}`);
  }

  async hc(...argv: string[]): Promise<Record<string, unknown>> {
    const r = await spawn(["hc", "--json", ...argv], this.hcEnv);
    if (r.code !== 0) throw new Error(`hc ${argv.join(" ")} -> ${r.code}: ${r.err || r.out}`);
    return JSON.parse(r.out || "{}");
  }

  seoriRaw(argv: string[], extra: Record<string, string> = {}): Promise<{ out: string; err: string; code: number }> {
    return spawn(["bun", cli, ...argv], { ...this.env, ...extra }, this.home);
  }

  async seori(argv: string[], extra: Record<string, string> = {}): Promise<string> {
    const r = await this.seoriRaw(argv, extra);
    if (r.code !== 0) throw new Error(`seori ${argv.join(" ")} -> ${r.code}: ${r.err}${r.out}`);
    return r.out;
  }

  async startCore(): Promise<void> {
    for (const dir of ["s", "r", "c/herdr-core", "units"]) mkdirSync(join(this.root, dir), { recursive: true });
    chmodSync(join(this.root, "r"), 0o700);
    // notes = false: hc types nothing into the agents on its own.
    writeFileSync(join(this.root, "c", "herdr-core", "config.toml"), "notes = false\n");
    const r = await spawn(["hc", "--json", "server", "start"], this.env);
    if (r.code !== 0) throw new Error(`hc server start -> ${r.code}: ${r.err}`);
    this.corePid = Number((await this.hc("server", "status"))["pid"]);
    if (!existsSync(join(this.root, "r", "herdr-core", `${this.session}.sock`))) throw new Error("the isolated core's socket is missing");
  }

  /** `seori up --cwd $SEORI_HOME`: lead and duty in terminals, the three units started by the fake systemctl. */
  async up(): Promise<string> {
    const out = await this.seori(["up", "--cwd", this.home]);
    const m = /^UP lead=hc:(\S+) duty=hc:(\S+) units=(\S+) /m.exec(out);
    if (!m) throw new Error(`unexpected seori up output: ${out}`);
    [this.lead, this.duty] = [m[1]!, m[2]!];
    for (const unit of m[3]!.split(",")) {
      const pid = this.unitPid(unit);
      if (pid === undefined || !alive(pid)) throw new Error(`unit ${unit} is not running`);
    }
    return out.trim();
  }

  unitPid(unit: string): number | undefined {
    const file = join(this.unitState, `${unit}.pid`);
    return existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined;
  }

  /** What the fake systemctl was asked, one line per call. */
  systemctlCalls(): string[] {
    const file = join(this.unitState, "systemctl.log");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  }

  // --- terminals ---
  terminal = async (address: string): Promise<Terminal> => (await this.hc("get", address)) as Terminal;
  status = async (address: string): Promise<string | undefined> => (await this.terminal(address)).status?.state ?? undefined;
  /** Waiting at its prompt: omp reports `idle` before its first turn and `done` once a turn has finished. */
  async settled(address: string): Promise<boolean> {
    const st = await this.status(address);
    return st === "idle" || st === "done";
  }
  /** Settled for two polls in a row: a turn that ends and immediately continues (a followUp) does not count. */
  async waitIdle(address: string, ms = 180_000, what = `${address} idle`): Promise<void> {
    let streak = 0;
    await until(what, async () => ((streak = (await this.settled(address)) ? streak + 1 : 0) >= 2 ? true : undefined), ms, 1500);
  }
  /**
   * The lead settled with nothing queued for it (a lane's or the loop's report would start its next turn). A held
   * entry waits for an ack, not for the lead, so it does not count. A timeout names the lead's state and its inbox.
   */
  async waitLeadIdle(ms = 180_000): Promise<void> {
    const inbox = () => this.seori(["inbox", "list", "lead"]);
    try {
      await until("nothing queued for the lead", async () => (/^\d+ queued /m.test(await inbox()) ? undefined : true), ms, 1000);
      await this.waitIdle(this.lead, ms, "the lead idle");
    } catch (e) {
      const screen = String((await this.hc("read", this.lead, "--lines", "30").catch(() => ({}) as Record<string, unknown>))["text"] ?? "").split("\n").filter((l) => l.trim()).slice(-12).join(" / ");
      const why = `lead ${await this.status(this.lead).catch(() => "?")}; inbox: ${(await inbox().catch(() => "?")).trim().replaceAll("\n", " | ")}; lead screen: ${screen}`;
      throw new Error(`${e instanceof Error ? e.message : e}; ${why}`);
    }
  }
  waitWorking = (address: string, ms = 30_000) =>
    until(`${address} working`, async () => ((await this.status(address)) === "working" ? true : undefined), ms, 300);
  /** hc send: pastes the text and presses Enter, whatever the agent is doing. */
  prompt = (address: string, text: string) => this.hc("send", address, "--", text);
  esc = (address: string) => this.hc("keys", address, "esc");
  /** The pid of omp when it leads the terminal's foreground. */
  async ompPid(address: string): Promise<number | undefined> {
    const fg = (await this.terminal(address)).foreground;
    return fg?.name === "omp" ? fg.pid : undefined;
  }

  /** One variable of the environment omp runs with in that terminal (the settings files `seori up` gave it, say). */
  async ompEnv(address: string, key: string): Promise<string | undefined> {
    const pid = await this.ompPid(address);
    if (pid === undefined) throw new Error(`no omp in ${address}`);
    const entry = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((e) => e.startsWith(`${key}=`));
    return entry?.slice(key.length + 1);
  }

  /**
   * Stops the lead's omp with SIGTERM and starts it again the way `seori up` does (startAgent in the same terminal,
   * whose shell carries the lead's env, with the extension and the rendered lead prompt). `exports` are exported in that
   * shell first; they stay for every later start in this terminal.
   */
  async restartLead(exports: Record<string, string> = {}): Promise<void> {
    const pid = await this.ompPid(this.lead);
    if (pid === undefined) throw new Error("no omp in the lead terminal");
    process.kill(pid, "SIGTERM");
    // hc clears the reported status when omp exits: the shell is in front again.
    await until("the lead's omp gone", async () => {
      const t = await this.terminal(this.lead);
      return t.foreground?.name !== "omp" && !t.status ? true : undefined;
    }, 30_000, 300);
    if (Object.keys(exports).length) {
      const marker = join(this.root, `exported-${Date.now()}`);
      await this.prompt(this.lead, `export ${Object.entries(exports).map(([k, v]) => `${k}=${shq(v)}`).join(" ")} && touch ${shq(marker)}`);
      await until("the exports in the lead terminal's shell", () => (existsSync(marker) ? true : undefined), 15_000, 200);
    }
    const runtime = new HcRuntime(envExec(this.hcEnv), { env: this.hcEnv });
    const d = { runtime, model } as unknown as Deps;
    await startAgent(d, { runtime: "hc", id: this.lead }, ["-e", LEAD_EXTENSION, "--append-system-prompt", join(this.home, "prompts", "lead.md")]);
  }

  // --- omp's session files ---
  private static readonly SESSIONS = join(homedir(), ".omp", "agent", "sessions");
  /**
   * The directories where omp keeps the session files of agents started under this root. omp names one after the cwd
   * with `/` as `-`, and shortens a cwd under its temp dir; the root's unique name and what follows it stay.
   */
  private sessionDirs(): string[] {
    const mark = `-${basename(this.root)}-`;
    return existsSync(OmpRig.SESSIONS) ? readdirSync(OmpRig.SESSIONS).filter((n) => n.includes(mark)).map((n) => join(OmpRig.SESSIONS, n)) : [];
  }
  /** Where omp keeps the session files of agents started in `cwd` (a dir under this root), once it has made it. */
  sessionsDir(cwd: string): string | undefined {
    const tail = `-${cwd.slice(this.realRoot.length + 1).replaceAll("/", "-")}`;
    return this.sessionDirs().find((d) => d.endsWith(`-${basename(this.root)}${tail}`));
  }
  /** The session file of an omp session id (the `session` of a ledger event). */
  sessionFile(id: string): string | undefined {
    for (const dir of this.sessionDirs()) {
      const f = readdirSync(dir).find((n) => n.endsWith(`_${id}.jsonl`));
      if (f !== undefined) return join(dir, f);
    }
    return undefined;
  }

  // --- the lead channel and the daemon ---
  ledger = (): LedgerEvent[] => jsonl<LedgerEvent>(join(this.home, "lead", "ledger.jsonl"));
  inbound = <T = { id: string }>(): T[] => jsonl<T>(join(this.home, "lead", "inbound.jsonl"));
  beat = (): { at: number; pid: number } => JSON.parse(readFileSync(join(this.home, "messenger", "daemon.heartbeat"), "utf8"));
  /** The running `seori daemon` (the child of the daemon unit's `seori daemon-loop`), from its heartbeat. */
  async daemonPid(): Promise<number | undefined> {
    const pid = this.beat().pid;
    const cmdline = existsSync(`/proc/${pid}/cmdline`) ? readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) : [];
    return cmdline.at(-2) === cli && cmdline.at(-1) === "daemon" ? pid : undefined;
  }
  pids = async (pattern: string): Promise<string[]> => (await spawnExec("pgrep", ["-f", pattern])).stdout.split("\n").filter(Boolean);

  /**
   * Stops what is left: the units' process groups, every terminal, then the core (the last hc call), and any process
   * still running from under the root (a watch command, a lane's child); then removes the root. Returns what proves the
   * core is gone: its pid exited and its runtime dir is empty.
   */
  async stop(): Promise<{ pid: number | undefined; alive: boolean; sockets: string[]; leftovers: string[] }> {
    try {
      try {
        if (existsSync(this.unitState)) {
          for (const f of readdirSync(this.unitState).filter((n) => n.endsWith(".pid"))) {
            const pid = Number(readFileSync(join(this.unitState, f), "utf8"));
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }
        if (this.corePid !== undefined) {
          for (const t of ((await this.hc("ls", "--all"))["terminals"] ?? []) as { address: string }[]) {
            await this.hc("kill", t.address).catch(() => undefined);
            await this.hc("rm", t.address).catch(() => undefined);
          }
        }
      } finally {
        if (this.corePid !== undefined) await spawn(["hc", "--json", "server", "stop"], this.hcEnv); // the last hc call
      }
      const pid = this.corePid;
      if (pid !== undefined) await until("the core to exit", () => (alive(pid) ? undefined : true), 10_000, 200);
      await until("no process from under the test root", async () => {
        const left = await this.pids(this.root);
        if (left.length === 0) return true;
        for (const p of left) {
          try {
            process.kill(Number(p), "SIGKILL");
          } catch {
            // gone meanwhile
          }
        }
        return undefined;
      }, 15_000, 300).catch(() => undefined);
      const leftovers = await this.pids(this.root);
      const dir = join(this.root, "r", "herdr-core");
      return { pid, alive: pid !== undefined && alive(pid), sockets: existsSync(dir) ? readdirSync(dir) : [], leftovers };
    } finally {
      // Even when something above failed. The session files omp wrote for this root's agents are this run's too.
      for (const d of this.sessionDirs()) rmSync(d, { recursive: true, force: true });
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
