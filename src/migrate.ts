// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// `seori migrate`: hands a lane, the lead or duty over to a session on another runtime (hc <-> herdr). The duty loop,
// hourly loop and daemon are not moved: seori does not record them as runtime sessions (on Linux they are systemd
// --user units, which no runtime owns; on macOS and herdr they are unrecorded terminals or panes holding no state).
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { agentSessionReported, paneEnv, promptsDir, Refusal, startAgent, type Deps } from "./harness.ts";
import { askCheckpoint, capture, handoffPath, type MigrateOpts, type Subject } from "./migrate-capture.ts";
import { createJournal, lockMigration, type MigrateJournal, readJournal, removeJournal, writeJournal } from "./migrate-journal.ts";
import { swapAgent } from "./migrate-swap.ts";
import { refText, sameSession } from "./refs.ts";
import { deliverOrThrow } from "./runtime/index.ts";
import { formatRef, type CreateSpec, type RuntimeKind, type SessionRef, type SessionRuntime } from "./runtime/types.ts";
import { KEY_RE, type Lane, type Role } from "./store.ts";

export type Target = { readonly lane?: string; readonly role?: Role; readonly all?: boolean };

export const MIGRATE_ROLES: readonly Role[] = ["lead", "duty"];
const isOpen = (l: Lane): boolean => l.status !== "done" && l.status !== "lost";

/**
 * Opens a session on `rt` and starts omp in it with `args`: on hc a terminal labelled with this home's group, on herdr
 * the root pane of a new workspace. `kickoff`, when given, is delivered once omp is up. Closes the session and throws
 * when omp does not start or does not take the kickoff.
 */
async function openOn(
  d: Deps, rt: SessionRuntime, spec: Omit<CreateSpec, "container" | "group">, label: string, args: readonly string[], kickoff?: string,
  model = d.model,
): Promise<SessionRef> {
  const ref = await rt.create(
    rt.kind === "hc"
      ? { ...spec, container: "tab", group: await rt.createGroup(loadConfig(d.store.root).name, spec.cwd) }
      : { ...spec, container: "workspace-root" },
  );
  try {
    await startAgent(d, label, ref, args, model);
    if (kickoff !== undefined) {
      await agentSessionReported(d, ref);
      if (!(await deliverOrThrow(rt, ref, kickoff))) throw new Error(`${d.agent.kind} was not in front of ${formatRef(ref)} to take the kickoff`);
    }
  } catch (e) {
    await rt.close(ref).catch(() => undefined);
    throw e;
  }
  return ref;
}

const resumeArgs = (resume: string | undefined): string[] => (resume === undefined ? [] : ["--resume", resume]);

function laneSubject(d: Deps, key: string): Subject {
  const lane = d.store.lane(key);
  if (!lane || !isOpen(lane)) throw new Refusal(`no open lane ${key}`);
  const save = (change: (l: Lane) => Lane): void => d.store.saveLane(change(d.store.lane(key) as Lane));
  return {
    name: key,
    kind: "lane",
    from: lane.sessionRef,
    brief: () => readFileSync(lane.brief, "utf8"),
    logTail: lane.log.slice(-20).map((e) => `- ${new Date(e.at).toISOString()} ${e.kind}: ${e.text}`),
    open: (rt, briefPath, resume) => {
      const env = { SEORI_LANE: key, ...paneEnv(d.store.root), ...d.agent.agentEnv(d.store.root) };
      const kickoff = resume === undefined ? d.agent.kickoff(briefPath, key) : undefined;
      return openOn(d, rt, { name: key, cwd: lane.cwd, env, role: "lane" }, key, resumeArgs(resume), kickoff, lane.model ?? d.model);
    },
    setHold: (on) => save(({ migration: _, ...l }) => (on ? { ...l, migration: true } : l)),
    // A run resumed after a crash between the switch and the journal write switches again: the record stays as it is.
    switchTo: (ref) =>
      save((l) => (sameSession(l.sessionRef, ref) ? l : { ...l, sessionRef: ref, migratedFrom: [...(l.migratedFrom ?? []), l.sessionRef] })),
    switchBack: (from, to) =>
      save(({ migratedFrom, ...l }) => {
        if (!sameSession(l.sessionRef, to)) return { ...l, ...(migratedFrom === undefined ? {} : { migratedFrom }) };
        const rest = (migratedFrom ?? []).slice(0, -1);
        return { ...l, sessionRef: from, ...(rest.length === 0 ? {} : { migratedFrom: rest }) };
      }),
  };
}

/** The lead or duty: the replacement starts like `seori up` starts it, its handoff brief as the appended system prompt. */
function roleSubject(d: Deps, role: Role, from: SessionRef, leadExtension: string): Subject {
  const root = d.store.root;
  return {
    name: role,
    kind: "role",
    from,
    brief: () => readFileSync(join(promptsDir(), `${role}.md`), "utf8").replaceAll("{{seori}}", d.seoriCmd),
    logTail: [],
    open: (rt, briefPath, resume) => {
      const name = loadConfig(root).name;
      const cwd = process.cwd();
      const env = paneEnv(root);
      if (role === "lead") {
        const leadEnv = { SEORI_HOME: root, SEORI_CMD: d.seoriCmd, ...env, ...d.agent.leadEnv(root) };
        const args = ["-e", leadExtension, "--append-system-prompt", briefPath, ...resumeArgs(resume)];
        return openOn(d, rt, { name, cwd, env: leadEnv, role: "lead" }, "lead", args);
      }
      const dutyEnv = { ...env, ...d.agent.agentEnv(root) };
      return openOn(d, rt, { name: `${name}-duty`, cwd, env: dutyEnv, role: "duty" }, "duty", ["--append-system-prompt", briefPath, ...resumeArgs(resume)]);
    },
    // A role has no record to mark: the journal alone holds its inbox (see migrating()).
    setHold: () => {},
    switchTo: (ref) => d.store.setRole(role, ref),
    switchBack: (from, to) => {
      const now = d.store.roles()[role];
      if (now !== undefined && sameSession(now, to)) d.store.setRole(role, from);
    },
  };
}

/** --resume: only a live source that is idle or done, whose omp session file its runtime reports. */
async function resumePath(d: Deps, s: Subject): Promise<string> {
  const rt = d.runtimes.for(s.from);
  const path = await rt.agentSession(s.from).catch(() => undefined);
  if (!path) {
    throw new Refusal(
      `--resume refused for ${s.name}: no omp session path on record for ${refText(s.from)} (hc reports none); migrate without --resume`,
    );
  }
  const status = await rt.status(s.from);
  if (status !== "idle" && status !== "done") throw new Refusal(`--resume refused for ${s.name}: its session is ${status}, not idle or done`);
  return path;
}

/** Steps (1)-(3) for an agent session, then the swap. Resumes at the journal's phase. */
async function agentSession(d: Deps, s: Subject, j: MigrateJournal | undefined, opts: MigrateOpts): Promise<number> {
  if (j === undefined) {
    const resume = opts.resume ? await resumePath(d, s) : undefined;
    j = { name: s.name, kind: s.kind, phase: "hold", from: s.from, to: opts.to, at: d.now(), ...(resume === undefined ? {} : { resume }) };
    if (!createJournal(d.store.root, j)) throw new Refusal(`another seori migrate of ${s.name} is running`);
    s.setHold(true);
  } else {
    // A run cut short between the journal and the hold left no hold: set it again (a no-op when it is set).
    s.setHold(true);
  }
  if (j.phase === "hold" && j.briefPath === undefined) {
    // A checkpoint an earlier migration left is not this agent's current state: only one written after this ask counts.
    rmSync(handoffPath(d, s.name), { force: true });
    const asked = j.resume === undefined ? await askCheckpoint(d, s, opts) : "stopped";
    if (typeof asked === "object" || asked === "blocked" || asked === "working") {
      removeJournal(d.store.root, s.name);
      s.setHold(false);
      const why =
        typeof asked === "object" ? `not ready (${asked.notReady})` : asked === "blocked" ? "blocked" : `working past ${opts.waitMinutes} min`;
      opts.log(`DEFERRED ${s.name} ${why}`);
      return 0;
    }
    j = { ...j, briefPath: await capture(d, s, j, asked === "gone") };
    writeJournal(d.store.root, j);
  }
  return swapAgent(d, s, j, opts);
}

/** False (having logged SKIP) when `from` is already on the target and no run is in progress; refuses a run toward another runtime. */
function needed(name: string, from: SessionRef, j: MigrateJournal | undefined, opts: MigrateOpts): boolean {
  if (j !== undefined && j.to !== opts.to) throw new Refusal(`a migration of ${name} is in progress toward ${j.to}; finish it with --to ${j.to}`);
  if (j === undefined && from.runtime === opts.to) {
    opts.log(`SKIP ${name} already on ${opts.to}`);
    return false;
  }
  return true;
}

async function migrateName(d: Deps, name: string, from: SessionRef, opts: MigrateOpts, sub: () => Subject): Promise<number> {
  const j = readJournal(d.store.root, name);
  if (!needed(name, from, j, opts)) return 0;
  if (opts.dryRun) {
    const what = j === undefined ? `inbox entries: ${d.store.queued(from).length}` : `resume at ${j.phase}`;
    opts.log(`PLAN ${name} ${refText(from)} -> ${opts.to} (${what})`);
    return 0;
  }
  const release = lockMigration(d.store.root, name, d.now());
  if (!release) throw new Refusal(`another seori migrate of ${name} is running`);
  try {
    // Another run may have finished or started between the reads above and the lock: decide again on what is there now.
    const locked = readJournal(d.store.root, name);
    const s = sub();
    if (!needed(name, s.from, locked, opts)) return 0;
    return await agentSession(d, s, locked, opts);
  } finally {
    release();
  }
}

/**
 * `seori migrate`: hands sessions over to `opts.to`. `--all` = every open lane, then lead and duty. Returns the exit
 * code: 3 when any session rolled back, else 0. The session the command runs in (`opts.self`) is refused, or skipped
 * under --all: closing the old session at the end would kill this run before it drains the inbox and drops the journal.
 */
export async function migrate(d: Deps, t: Target, opts: MigrateOpts, leadExtension = ""): Promise<number> {
  const lanes = t.all ? d.store.lanes().filter(isOpen).map((l) => l.key) : t.lane ? [t.lane] : [];
  const roles = t.all ? MIGRATE_ROLES : t.role ? [t.role] : [];
  if (lanes.length + roles.length === 0 && !t.all) throw new Refusal("give --lane K, --role lead|duty or --all");
  let code = 0;
  const isSelf = (name: string, ref: SessionRef): boolean => {
    // A resumed run: the record may already name the replacement, while the session closed at the end is the journal's.
    const from = readJournal(d.store.root, name)?.from;
    if (opts.self === undefined || !(sameSession(opts.self, ref) || (from !== undefined && sameSession(opts.self, from)))) return false;
    if (!t.all) throw new Refusal(`${name} is the session running this seori migrate; run it from another session`);
    opts.log(`SKIP ${name} is the session running seori migrate`);
    return true;
  };
  for (const key of lanes) {
    const lane = d.store.lane(key);
    if (!lane || !isOpen(lane)) throw new Refusal(`no open lane ${key}`);
    if (isSelf(key, lane.sessionRef)) continue;
    // The replacement starts on a kickoff, which would wake a lane only the owner may resume (seori pause).
    if (lane.status === "paused" && readJournal(d.store.root, key) === undefined) {
      if (!t.all) throw new Refusal(`lane ${key} is paused; resume it first (seori resume ${key})`);
      opts.log(`SKIP ${key} paused`);
      continue;
    }
    code = Math.max(code, await migrateName(d, key, lane.sessionRef, opts, () => laneSubject(d, key)));
  }
  for (const role of roles) {
    const ref = d.store.roles()[role];
    if (!ref) {
      if (t.all) continue;
      throw new Refusal(`no ${role} session registered`);
    }
    if (isSelf(role, ref)) continue;
    code = Math.max(code, await migrateName(d, role, ref, opts, () => roleSubject(d, role, d.store.roles()[role] ?? ref, leadExtension)));
  }
  return code;
}

const KINDS: readonly RuntimeKind[] = ["hc", "herdr"];

/** The command line: `flag(name)` is the last value of --name ("true" for a boolean flag), undefined when absent. */
export async function runMigrate(d: Deps, flag: (name: string) => string | undefined, leadExtension: string): Promise<number> {
  const to = (flag("to") ?? d.runtimes.choice().kind) as RuntimeKind;
  if (!KINDS.includes(to)) throw new Refusal("--to must be hc or herdr");
  const role = flag("role") as Role | undefined;
  if (role !== undefined && !MIGRATE_ROLES.includes(role)) {
    throw new Refusal(
      "--role must be lead or duty: the duty loop, hourly loop and daemon are not recorded as runtime sessions " +
        "(systemd --user units on Linux), so seori migrate does not move them",
    );
  }
  const wait = Number(flag("wait-minutes") ?? "10");
  if (!(Number.isFinite(wait) && wait >= 0)) throw new Refusal("--wait-minutes must be a number of minutes, 0 or more");
  const lane = flag("lane");
  if (lane === "") throw new Refusal("--lane needs a lane key");
  if (lane !== undefined && !KEY_RE.test(lane)) throw new Refusal(`--lane ${JSON.stringify(lane)} is not a lane key`);
  const self = d.runtimes.selfAny(process.env);
  return migrate(
    d,
    { ...(lane === undefined ? {} : { lane }), ...(role === undefined ? {} : { role }), all: flag("all") === "true" },
    {
      to,
      dryRun: flag("dry-run") === "true",
      waitMinutes: wait,
      resume: flag("resume") === "true",
      ...(self === undefined ? {} : { self }),
      log: console.log,
    },
    leadExtension,
  );
}
