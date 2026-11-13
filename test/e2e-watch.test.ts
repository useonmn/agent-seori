import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LedgerEvent, WatchRow } from "../src/channel.ts";
import { LEAD_EXTENSION } from "../src/cli.ts";
import { startAgent, type Deps } from "../src/harness.ts";
import { shq, spawnExec } from "../src/runtime/exec.ts";
import { Herdr, HerdrError } from "../src/runtime/herdr/client.ts";
import { defaultRuntimes } from "../src/runtime/index.ts";
import type { Lane } from "../src/store.ts";
import { MAX_RESTARTS, WAKE_BUDGET, type Watch, WatchStore } from "../src/watch/store.ts";
import { herdrRef } from "./fake.ts";

// Watches end to end: real herdr in an isolated named session, `seori up` (a REAL omp lead with the lead-channel
// extension, duty, loops and the daemon that runs the watch engine), and `seori watch ...` run from this test the way
// an agent runs it. Opt-in with SEORI_E2E_OMP=1 (model calls, costs money); SEORI_E2E_ONLY=1,4,8 runs only those.
// Each scenario arms its own watches and checks only their events, so a subset still works. Every lead event must end
// up as one `watch:` row in lead/inbound.jsonl, delivered once into the lead's omp session and closed there as seen.
// Real waits throughout: the engine's own intervals (1 s ticks, 5/15/45 s crash backoff, 5 s pane polls) are under test.
const herdrBin = Bun.which("herdr");
const enabled = !!herdrBin && process.env["SEORI_E2E_OMP"] === "1";
const only = process.env["SEORI_E2E_ONLY"]?.split(",").map((s) => s.trim()).filter(Boolean);
const scenario = (n: string) => enabled && (!only || only.includes(n));
const session = `seori-e2e-w-${process.pid}`;
// realpath: macOS hands out /var/... for /private/var/...; omp records the resolved cwd in its session paths.
// Only when enabled: a skipped run (plain `bun test`) must not leave an empty temp dir behind.
const home = enabled ? realpathSync(mkdtempSync(join(tmpdir(), "seori-e2e-w-"))) : "";
const cli = resolve(import.meta.dir, "../src/cli.ts");
const model = process.env["SEORI_E2E_MODEL"] ?? "anthropic/claude-haiku-5-5";
// Run from inside herdr or omp, the caller's pane, socket, omp session and seori command would leak into the herdr
// server (and so into every pane and omp it starts) and into seori itself.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HERDR_|PI_|OMPCODE$|SEORI_)/.test(k)));
const env = { ...inherited, SEORI_HOME: home, SEORI_HERDR_SESSION: session, SEORI_MODEL: model };
// What a lane's omp runs: its pane does not inherit this process's env, and SEORI_LANE comes from the pane.
const seoriCmd = `SEORI_HOME=${shq(home)} SEORI_HERDR_SESSION=${session} bun ${shq(cli)}`;
const work = join(home, "work");
const herdrApi = new Herdr(spawnExec, session);
let server: Bun.Subprocess | undefined;
let panes: Record<string, string> = {};

const herdr = async (...argv: string[]) => {
  const r = await spawnExec("herdr", ["--session", session, ...argv]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout || "{}").result;
};
const seoriRaw = async (argv: string[]) => {
  const p = Bun.spawn(["bun", cli, ...argv], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};
const seori = async (argv: string[]) => {
  const r = await seoriRaw(argv);
  if (r.code !== 0) throw new Error(`seori ${argv.join(" ")} -> ${r.code}: ${r.err}`);
  return r.out;
};
const until = async <T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 30_000, every = 500): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await Promise.resolve().then(probe).catch(() => undefined);
    if (v !== undefined) return v;
    await Bun.sleep(every);
  }
  throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
};
const t0s = new Map<string, number>();
const log = (line: string) => console.log(`[e2e-watch ${new Date().toISOString().slice(11, 19)}] ${line}`);
const since = (label: string) => `${((Date.now() - (t0s.get(label) ?? Date.now())) / 1000).toFixed(1)} s`;

// --- watches and the lead channel files ---
const jsonl = <T>(path: string): T[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T) : [];
const ledger = () => jsonl<LedgerEvent>(join(home, "lead", "ledger.jsonl"));
const watchRows = (watchId: string) => jsonl<{ kind: string }>(join(home, "lead", "inbound.jsonl")).filter((r): r is WatchRow => r.kind === "watch" && (r as WatchRow).watchId === watchId);
const watchFile = (id: string) => JSON.parse(readFileSync(join(home, "watches", `${id}.json`), "utf8")) as Watch;
const allWatches = () => new WatchStore(home).list();
const watchEvents = (id: string) => jsonl<{ ev: string; at: number; text?: string; reason?: string }>(join(home, "watches", `${id}.events.jsonl`));
const deliveredTo = (rowId: string) => ledger().filter((e) => e.id === rowId && e.ev === "delivered") as Extract<LedgerEvent, { ev: "delivered" }>[];
const seen = (rowId: string) => ledger().some((e) => e.id === rowId && e.ev === "closed" && e.why === "seen");
const prefix = (w: { id: string; name: string }) => `[watch ${w.name} ${w.id}] `;

/** `seori watch add ...` -> the new watch's id and name (from `WATCH <id> <name> for ...`). */
async function addWatch(argv: string[]): Promise<{ id: string; name: string }> {
  const out = await seori(["watch", "add", ...argv]);
  const m = /^WATCH (\S+) (\S+) for /.exec(out);
  if (!m) throw new Error(`unexpected watch add output: ${out}`);
  return { id: m[1]!, name: m[2]! };
}
const waitStatus = (id: string, status: Watch["status"], ms = 30_000) =>
  until(`watch ${id} ${status}`, () => (watchFile(id).status === status ? watchFile(id) : undefined), ms);
/** A file watch reports changes against its first snapshot, so a change made before that snapshot is not one. */
const waitCheckpoint = (id: string) => until(`watch ${id} checkpoint`, () => watchFile(id).checkpoint, 15_000);
const script = (name: string, body: string) => {
  const path = join(work, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
/** A command watch on a trigger file: the test appends lines, `tail -F` prints them. */
const tailTrigger = (name: string) => {
  const path = join(work, `${name}.trigger`);
  writeFileSync(path, "");
  return { path, command: `tail -n 0 -F ${shq(path)}`, fire: (line: string) => appendFileSync(path, `${line}\n`) };
};
const pids = async (pattern: string) => (await spawnExec("pgrep", ["-f", pattern])).stdout.split("\n").filter(Boolean);

// --- the lead in herdr ---
const lead = () => panes["lead"]!;
const paneInfo = async (pane: string) => (await herdr("pane", "get", pane)).pane as { agent?: string; agent_status?: string; agent_session?: { value?: string }; workspace_id?: string };
const leadStatus = async () => (await paneInfo(lead())).agent_status;
/** Idle for two polls in a row: a turn that ends and immediately continues (a followUp) does not count. */
const waitLeadIdle = async (ms = 180_000) => {
  let streak = 0;
  await until("the lead idle", async () => ((streak = (await leadStatus()) === "idle" ? streak + 1 : 0) >= 2 ? true : undefined), ms, 1500);
};
const prompt = (text: string) => herdr("agent", "prompt", lead(), text);
const foreground = async (pane: string) =>
  ((await herdr("pane", "process-info", "--pane", pane)).process_info.foreground_processes ?? []) as { pid: number; cmdline: string }[];
const leadOmpPid = async () => (await foreground(lead())).find((p) => /(^|\/)omp( |$)/.test(p.cmdline))?.pid;
const sessionFile = async (pane = lead()) => (await paneInfo(pane)).agent_session?.value;
const fileHas = (path: string | undefined, needle: string) => !!path && existsSync(path) && readFileSync(path, "utf8").includes(needle);

/**
 * The lead got this event: exactly one row with `needle` for the watch, delivered once (to `inSession` when given),
 * closed as seen, and its text in the lead's current omp session file. Returns the row.
 */
async function expectLeadGot(w: { id: string; name: string }, needle: string, ms = 60_000, inSession?: string): Promise<WatchRow> {
  const row = await until(`a ${w.name} row with ${needle}`, () => watchRows(w.id).find((r) => r.text.includes(needle)), ms);
  expect(row.text.startsWith(prefix(w))).toBe(true);
  expect(row.id).toMatch(new RegExp(`^watch:${w.id}:\\d+$`));
  await until(`${row.id} closed as seen`, () => (seen(row.id) ? true : undefined), 120_000, 1000);
  const firstLine = row.text.split("\n")[0]!;
  const file = await until("the event in the lead's session file", async () => {
    const f = await sessionFile();
    return fileHas(f, firstLine) ? f : undefined;
  }, 30_000, 1000);
  expect(watchRows(w.id).filter((r) => r.text.includes(needle))).toHaveLength(1);
  const deliveries = deliveredTo(row.id);
  expect(deliveries).toHaveLength(1);
  if (inSession !== undefined) expect(deliveries[0]!.session).toBe(inSession);
  log(`  ${row.id} delivered (${deliveries[0]!.mode}) and seen; in ${file}`);
  return row;
}

/** No more rows for the watch than `n`, also after a quiet period, and every row delivered exactly once. */
async function expectRows(w: { id: string }, n: number, quietMs = 8_000): Promise<WatchRow[]> {
  await Bun.sleep(quietMs);
  const rows = watchRows(w.id);
  expect(rows.map((r) => r.text)).toHaveLength(n);
  for (const r of rows) expect(deliveredTo(r.id).length).toBeLessThanOrEqual(1);
  return rows;
}

/**
 * Stops the lead's omp with SIGTERM and starts it again the way `seori up` does: `herdr agent start` in the same pane
 * (whose shell carries the workspace env) with the extension and the rendered lead prompt.
 */
async function restartLead(): Promise<void> {
  const pid = await leadOmpPid();
  if (pid === undefined) throw new Error("no omp in the lead pane");
  process.kill(pid, "SIGTERM");
  await until("the lead omp gone", async () => ((await paneInfo(lead())).agent ? undefined : true), 30_000);
  const d = { runtimes: defaultRuntimes(herdrApi), model } as unknown as Deps;
  // herdr clears the pane's agent before it frees the agent's name: a start right after the exit can get
  // agent_name_taken for a few seconds.
  for (let attempt = 1; ; attempt++) {
    try {
      await startAgent(d, "lead", herdrRef(lead()), ["-e", LEAD_EXTENSION, "--append-system-prompt", join(home, "prompts", "lead.md")]);
      return;
    } catch (e) {
      if (!(e instanceof HerdrError && e.result.stderr.includes("agent_name_taken")) || attempt >= 30) throw e;
      await Bun.sleep(1000);
    }
  }
}

const beat = () => JSON.parse(readFileSync(join(home, "messenger", "daemon.heartbeat"), "utf8")) as { at: number; pid: number };
const daemonPid = async () => (await foreground(panes["daemon"]!)).find((p) => p.cmdline.includes("cli.ts daemon") && !p.cmdline.startsWith("sh "))?.pid;

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(work, { recursive: true });
  server = Bun.spawn([herdrBin!, "--session", session, "server"], { env: inherited, cwd: home, stdout: "ignore", stderr: "ignore" });
  await until("herdr server", () => herdr("workspace", "list"));
  const up = await seori(["up", "--cwd", home]);
  log(up.trim());
  panes = Object.fromEntries([...up.matchAll(/(\w+)=(w\d+:p\d+)/g)].map((m) => [m[1]!, m[2]!]));
  expect(Object.keys(panes).sort()).toEqual(["daemon", "duty", "hourly", "lead", "loop"]);
  await until("the daemon heartbeat", () => beat(), 60_000);
  // `seori loop` reports its first run to the lead right away; start every scenario from an idle lead.
  await waitLeadIdle();
}, 300_000);

afterAll(async () => {
  if (!enabled) return;
  // Whatever a failed scenario left running: stop every live watch so the daemon takes its commands down.
  for (const line of (await seoriRaw(["watch", "list"])).out.split("\n")) {
    const id = /^(w\S+) /.exec(line)?.[1];
    if (id) await seoriRaw(["watch", "stop", id]);
  }
  await Bun.sleep(3000);
  await spawnExec("herdr", ["--session", session, "server", "stop"]);
  await server?.exited;
  await spawnExec("herdr", ["session", "delete", session]);
  // Reported by scenario 11 when it runs; here only cleaned up, so a failed run leaves nothing behind.
  await spawnExec("pkill", ["-KILL", "-f", work]);
  rmSync(home, { recursive: true, force: true });
}, 60_000);

test.skipIf(!scenario("1"))("1 command watch with --filter: one event for the matching line, a done event on exit 0", async () => {
  await waitLeadIdle();
  t0s.set("1", Date.now());
  const s = script("s1.sh", "echo noise one; echo noise two; sleep 2; echo 'FOUND s1-token'; echo noise three; sleep 2; exit 0");
  const w = await addWatch(["--command", s, "--filter", "FOUND", "--name", "s1", "--cwd", work]);
  const hit = await expectLeadGot(w, "FOUND s1-token");
  expect(hit.text).toBe(`${prefix(w)}FOUND s1-token`);
  log(`1: match delivered ${since("1")} after arming`);
  const done = await expectLeadGot(w, "exited 0");
  expect(done.text).toContain("noise three");
  log(`1: done delivered ${since("1")} after arming`);
  await expectRows(w, 2);
  expect(watchFile(w.id).status).toBe("done");
  const listed = (await seori(["watch", "list", "--all"])).split("\n").find((l) => l.startsWith(w.id));
  expect(listed).toMatch(/\bs1\s+lead\s+done\s+command:/);
  expect(listed).toContain("ended: exited 0");
  expect(await seori(["watch", "list"])).not.toContain(w.id);
}, 240_000);

test.skipIf(!scenario("2"))("2 a command that keeps crashing is restarted 3 times, then stopped with one event", async () => {
  t0s.set("2", Date.now());
  const s = script("s2.sh", "echo crash-once; exit 1");
  const w = await addWatch(["--command", s, "--filter", "NEVER-MATCHES", "--name", "s2", "--cwd", work]);
  // Backoff 5 + 15 + 45 s between the four runs.
  const stopped = await waitStatus(w.id, "stopped", 120_000);
  log(`2: stopped ${since("2")} after arming: ${stopped.reason}`);
  expect(stopped.restarts).toBe(MAX_RESTARTS);
  expect(stopped.reason).toBe("kept crashing (exit 1)");
  expect(watchEvents(w.id).filter((e) => e.ev === "spawned")).toHaveLength(MAX_RESTARTS + 1);
  const row = await expectLeadGot(w, "kept crashing");
  expect(row.text).toBe(`${prefix(w)}kept crashing (exit 1); stopped`);
  await expectRows(w, 1);
}, 240_000);

test.skipIf(!scenario("3"))("3 file watch: created, modified (a burst coalesced) and deleted are three events; still active", async () => {
  t0s.set("3", Date.now());
  const f = join(work, "s3.txt");
  const w = await addWatch(["--file", f, "--name", "s3"]);
  await waitCheckpoint(w.id);
  writeFileSync(f, "one\n");
  await expectLeadGot(w, `created ${f}`);
  for (const line of ["two", "three", "four"]) {
    appendFileSync(f, `${line}\n`);
    await Bun.sleep(150);
  }
  await expectLeadGot(w, `modified ${f}`);
  rmSync(f);
  await expectLeadGot(w, `deleted ${f}`);
  log(`3: three events delivered ${since("3")} after arming`);
  await expectRows(w, 3);
  expect(watchFile(w.id).status).toBe("active");
  await seori(["watch", "stop", w.id]);
}, 300_000);

test.skipIf(!scenario("4"))("4 a persistent watch survives /new: the next event lands in the new session", async () => {
  await waitLeadIdle();
  const trig = tailTrigger("s4");
  const w = await addWatch(["--command", trig.command, "--filter", "MATCH4", "--name", "s4", "--persistent", "--cwd", work]);
  await until("s4 command running", () => (watchEvents(w.id).some((e) => e.ev === "spawned") ? true : undefined), 15_000);
  const before = await until("the lead's session file", () => sessionFile(), 30_000);
  await prompt("/new");
  const after = await until("a new lead session file", async () => {
    const f = await sessionFile();
    return f && f !== before ? f : undefined;
  }, 60_000);
  await waitLeadIdle();
  t0s.set("4", Date.now());
  trig.fire("MATCH4 after-new");
  const row = await expectLeadGot(w, "MATCH4 after-new");
  log(`4: delivered ${since("4")} after the match, into ${after}`);
  expect(fileHas(after, row.text)).toBe(true);
  expect(fileHas(before, row.text)).toBe(false);
  await expectRows(w, 1);
  await seori(["watch", "stop", w.id]);
}, 300_000);

test.skipIf(!scenario("5"))("5 survives a lead restart: the event is delivered once, into the restarted lead", async () => {
  await waitLeadIdle();
  const trig = tailTrigger("s5");
  const w = await addWatch(["--command", trig.command, "--filter", "MATCH5", "--name", "s5", "--cwd", work]);
  await until("s5 command running", () => (watchEvents(w.id).some((e) => e.ev === "spawned") ? true : undefined), 15_000);
  const before = await sessionFile();
  await restartLead();
  await until("the restarted lead's session file", async () => {
    const f = await sessionFile();
    return f && f !== before ? f : undefined;
  }, 60_000);
  await waitLeadIdle();
  t0s.set("5", Date.now());
  trig.fire("MATCH5 after-restart");
  const row = await expectLeadGot(w, "MATCH5 after-restart");
  log(`5: delivered ${since("5")} after the match`);
  expect(fileHas(before, row.text)).toBe(false);
  await expectRows(w, 1);
  await seori(["watch", "stop", w.id]);
}, 300_000);

test.skipIf(!scenario("6"))("6 survives a daemon SIGKILL: the command is re-run, a file change made while down is reported once", async () => {
  const trig = tailTrigger("s6");
  const cmd = await addWatch(["--command", trig.command, "--filter", "MATCH6", "--name", "s6cmd", "--cwd", work]);
  const f = join(work, "s6.txt");
  writeFileSync(f, "before\n");
  const file = await addWatch(["--file", f, "--name", "s6file"]);
  await until("s6cmd command running", () => (watchEvents(cmd.id).some((e) => e.ev === "spawned") ? true : undefined), 15_000);
  await waitCheckpoint(file.id);
  const pid = await until("the daemon process", daemonPid, 15_000);
  expect(beat().pid).toBe(pid);
  process.kill(pid, "SIGKILL");
  t0s.set("6", Date.now());
  // Made while no daemon runs: the restart loop waits before starting the next one.
  appendFileSync(f, "while the daemon was down\n");
  const back = await until("a new daemon heartbeat", () => {
    const b = beat();
    return b.pid !== pid ? b : undefined;
  }, 30_000, 200);
  log(`6: new daemon pid ${back.pid} ${since("6")} after SIGKILL of ${pid}`);
  await until("s6cmd re-run", () => (watchEvents(cmd.id).filter((e) => e.ev === "spawned").length >= 2 ? true : undefined), 15_000);
  const tails = await pids(trig.path);
  if (tails.length !== 1) log(`6: ${tails.length} processes run the s6 command after the restart (orphan of the killed daemon?): ${tails.join(" ")}`);
  await expectLeadGot(file, `modified ${f}`);
  log(`6: file change delivered ${since("6")} after SIGKILL`);
  trig.fire("MATCH6 after-daemon-restart");
  await expectLeadGot(cmd, "MATCH6 after-daemon-restart");
  log(`6: command match delivered ${since("6")} after SIGKILL`);
  await expectRows(file, 1);
  await expectRows(cmd, 1, 0);
  const left = await pids(trig.path);
  log(`6: s6 command processes after the match: ${left.length}`);
  expect(left).toHaveLength(1);
  await seori(["watch", "stop", cmd.id]);
  await seori(["watch", "stop", file.id]);
}, 300_000);

test.skipIf(!scenario("7"))("7 wake budget: muted after 6 deliveries with one notice; rearm resumes", async () => {
  t0s.set("7", Date.now());
  const s = script("s7.sh", "i=0; while :; do i=$((i+1)); echo \"TICK $i\"; sleep 2; done");
  const w = await addWatch(["--command", s, "--filter", "TICK", "--name", "s7", "--cwd", work]);
  const muted = await waitStatus(w.id, "muted", 60_000);
  log(`7: muted ${since("7")} after arming`);
  expect(muted.wakes.length).toBe(WAKE_BUDGET + 1);
  // While muted the engine only counts in memory and writes the count every 30 s (DEFAULT_TIMING.mutedSaveMs).
  await until("muted events counted", () => (watchFile(w.id).mutedEvents >= 3 ? true : undefined), 50_000);
  const rows = watchRows(w.id);
  expect(rows).toHaveLength(WAKE_BUDGET + 1);
  expect(rows.slice(0, WAKE_BUDGET).map((r) => r.text)).toEqual(Array.from({ length: WAKE_BUDGET }, (_, i) => `${prefix(w)}TICK ${i + 1}`));
  expect(rows.filter((r) => r.text.includes("muted after"))).toHaveLength(1);
  expect(rows.at(-1)!.text).toBe(`${prefix(w)}muted after ${WAKE_BUDGET} wakes in 1h; seori watch rearm ${w.id} to resume`);
  for (const r of rows) await until(`${r.id} closed as seen`, () => (seen(r.id) ? true : undefined), 180_000, 1000);
  for (const r of rows) expect(deliveredTo(r.id)).toHaveLength(1);
  const rearm = await seori(["watch", "rearm", w.id]);
  log(`7: ${rearm.trim()}`);
  expect(rearm).toMatch(new RegExp(`^REARMED ${w.id} s7: \\d+ event\\(s\\) missed`));
  const next = await until("a TICK after rearm", () => watchRows(w.id).slice(WAKE_BUDGET + 1).find((r) => r.text.includes("TICK")), 30_000);
  await seori(["watch", "stop", w.id]);
  log(`7: resumed with ${next.text}`);
  await until(`${next.id} closed as seen`, () => (seen(next.id) ? true : undefined), 180_000, 1000);
  expect(deliveredTo(next.id)).toHaveLength(1);
  await until("s7 command gone", async () => ((await pids(s)).length === 0 ? true : undefined), 15_000);
}, 600_000);

test.skipIf(!scenario("8"))("8 lane-owned watch: the lane gets the event as a steer and reports it; seori done stops the watch", async () => {
  t0s.set("8", Date.now());
  const key = "watch-lane";
  const token = `lane-token-${process.pid}`;
  const s = script("s8.sh", `sleep 20; echo 'READY ${token}'; sleep 3600`);
  const brief = join(work, "s8-brief.md");
  writeFileSync(brief, [
    "You are an end-to-end test lane. Do exactly these steps, in order, and nothing else:",
    "",
    `1. Run exactly this shell command: ${seoriCmd} watch add --command ${shq(s)} --filter READY --name lanewatch`,
    "2. Then wait without running any command. Within about a minute a message that starts with `[watch lanewatch` arrives in",
    "   this pane by itself. Do not poll, do not sleep, do not run `watch list`.",
    `3. When it has arrived, run: ${seoriCmd} report ${key} --text '<the complete text of that watch message, verbatim>'`,
    `4. Then run: ${seoriCmd} ready ${key} --text 'watch event received' --evidence ${shq(`file://${brief}`)}`,
    "",
    "Do not edit files. After the ready command succeeds, stop.",
  ].join("\n"));
  const workspace = (await paneInfo(lead())).workspace_id;
  expect(workspace).toBeTruthy();
  await seori(["start", key, "--brief", brief, "--workspace", workspace!, "--cwd", work]);
  const lanePath = join(home, "lanes", `${key}.json`);
  const laneRec = () => JSON.parse(readFileSync(lanePath, "utf8")) as Lane;
  const w = await until("the lane's watch", () => allWatches().find((x) => x.name === "lanewatch"), 240_000, 1000);
  expect(w.owner).toEqual({ kind: "lane", key });
  log(`8: lane armed ${w.id} ${since("8")} after start`);
  const delivered = await until("the lane event delivered", () => watchEvents(w.id).find((e) => e.ev === "delivered" && e.text?.includes(token)), 90_000, 1000);
  const eventText = `${prefix(w)}${delivered.text}`;
  log(`8: delivered to the lane ${since("8")} after start: ${eventText}`);
  const laneSession = await until("the event in the lane's session file", async () => {
    const f = await sessionFile(laneRec().paneId);
    return fileHas(f, eventText) ? f : undefined;
  }, 60_000, 1000);
  log(`8: in the lane's session ${laneSession}`);
  const report = await until("the lane's REPORT with the event", () => laneRec().log.find((l) => l.kind === "report" && l.text.includes(token)), 240_000, 1000);
  log(`8: REPORT ${since("8")} after start: ${report.text}`);
  expect(report.text).toContain(`[watch lanewatch ${w.id}]`);
  expect(watchRows(w.id)).toHaveLength(0);
  expect(watchEvents(w.id).filter((e) => e.ev === "delivered")).toHaveLength(1);
  await until("the lane READY", () => (laneRec().status === "ready" || laneRec().status === "done" ? true : undefined), 240_000, 1000);
  // The lead is told to close READY lanes itself, so it may have run `seori done` already.
  if (laneRec().status !== "done") {
    await until(`lane ${key} idle`, async () => {
      const st = (await paneInfo(laneRec().paneId)).agent_status;
      return st === "idle" || st === "done" ? true : undefined;
    }, 180_000, 1000);
    const r = await seoriRaw(["done", key]);
    log(`8: seori done -> ${r.code} ${r.out.trim()} ${r.err.trim()}`);
    expect(r.code === 0 || laneRec().status === "done").toBe(true);
  } else log("8: the lead closed the lane itself");
  t0s.set("8done", Date.now());
  const stopped = await waitStatus(w.id, "stopped", 15_000);
  log(`8: watch ${stopped.status} (${stopped.reason}) ${since("8done")} after done`);
  expect(stopped.reason).toBe("owner lane closed");
  await until("s8 command gone", async () => ((await pids(s)).length === 0 ? true : undefined), 15_000);
}, 900_000);

test.skipIf(!scenario("9"))("9 pane watch: --status working fires once when the lead starts a turn, then the watch is done", async () => {
  await waitLeadIdle();
  const w = await addWatch(["--pane", lead(), "--status", "working", "--name", "s9"]);
  await Bun.sleep(6000);
  expect(watchRows(w.id)).toHaveLength(0);
  t0s.set("9", Date.now());
  await prompt("Run exactly this shell command and nothing else: sleep 15  -- then say finished.");
  const row = await expectLeadGot(w, `pane ${lead()} is working`);
  log(`9: delivered ${since("9")} after the prompt`);
  expect(row.text).toBe(`${prefix(w)}pane ${lead()} is working`);
  expect(watchFile(w.id).status).toBe("done");
  await waitLeadIdle();
  await expectRows(w, 1);
}, 300_000);

test.skipIf(!scenario("10"))("10 a 6th persistent watch for the lead is refused with exit 2", async () => {
  const livePersistent = () => allWatches().filter((w) => w.owner.kind === "lead" && w.persistent && (w.status === "active" || w.status === "muted"));
  const armed: string[] = [];
  for (let i = livePersistent().length; i < 5; i++) armed.push((await addWatch(["--file", join(work, `s10-${i}.txt`), "--name", `s10-${i}`, "--persistent"])).id);
  expect(livePersistent()).toHaveLength(5);
  const r = await seoriRaw(["watch", "add", "--file", join(work, "s10-6.txt"), "--name", "s10-6", "--persistent"]);
  log(`10: 6th persistent -> exit ${r.code}: ${r.err.trim()}`);
  expect(r.code).toBe(2);
  expect(r.err).toContain("at most 5 persistent watches per owner");
  expect(livePersistent()).toHaveLength(5);
  // A non-persistent one is still allowed next to five persistent ones.
  const extra = await addWatch(["--file", join(work, "s10-x.txt"), "--name", "s10-x"]);
  for (const id of [...armed, extra.id]) await seori(["watch", "stop", id]);
}, 60_000);

// Last, it ends the herdr server: closing the daemon's pane must take the commands of live watches down with the
// daemon (they run in their own process groups, so nothing else would).
test.skipIf(!scenario("11"))("11 herdr server stop: no watch command outlives the daemon", async () => {
  const trig = tailTrigger("s11");
  const w = await addWatch(["--command", trig.command, "--filter", "MATCH11", "--name", "s11", "--cwd", work]);
  await until("s11 command running", () => (watchEvents(w.id).some((e) => e.ev === "spawned") ? true : undefined), 15_000);
  expect(await pids(trig.path)).toHaveLength(1);
  await spawnExec("herdr", ["--session", session, "server", "stop"]);
  await server?.exited;
  const left = await until("the s11 command gone", async () => {
    const p = await pids(trig.path);
    return p.length === 0 ? p : undefined;
  }, 15_000).catch(async () => pids(trig.path));
  log(`11: s11 command processes after server stop: ${left.length}`);
  expect(left).toHaveLength(0);
  // A watch that was live when its daemon went away stays live in its file, so the next daemon resumes it.
  expect(watchFile(w.id).status).toBe("active");
}, 60_000);
