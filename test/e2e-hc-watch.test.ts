import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent, WatchRow } from "../src/channel.ts";
import { HEARTBEAT_MS } from "../src/daemon.ts";
import { shq } from "../src/runtime/exec.ts";
import type { Lane } from "../src/store.ts";
import { DEFAULT_TIMING } from "../src/watch/engine.ts";
import { MAX_RESTARTS, WAKE_BUDGET, type Watch, WatchStore } from "../src/watch/store.ts";
import { enabled, jsonl, OmpRig, until } from "./e2e-hc-omp.ts";

// Watches end to end on hc: an isolated hc core, `seori up` (a REAL omp lead with the lead-channel extension, duty,
// and the daemon unit, which runs the watch engine, started by the fake systemctl), and `seori watch ...` run from this
// test the way an agent runs it. Opt-in (model calls, costs money): SEORI_E2E_HC=1 SEORI_E2E_OMP=1, see e2e-hc-omp.ts;
// SEORI_E2E_ONLY=1,4,8 runs only those. Each scenario arms its own watches and checks only their events, so a subset
// still works. Every lead event must end up as one `watch:` row in lead/inbound.jsonl, delivered once into the lead's
// omp session and closed there as seen. Real waits throughout: the engine's own intervals (1 s ticks, 5/15/45 s crash
// backoff, 5 s pane polls) are under test.
const only = process.env["SEORI_E2E_ONLY"]?.split(",").map((s) => s.trim()).filter(Boolean);
const scenario = (n: string) => enabled && (!only || only.includes(n));
const rig = enabled ? new OmpRig("w") : undefined;
const home = rig?.home ?? "";
const work = join(home, "work");
const t0s = new Map<string, number>();
const log = (line: string) => rig?.log(line);
const since = (label: string) => `${((Date.now() - (t0s.get(label) ?? Date.now())) / 1000).toFixed(1)} s`;

const r = () => rig!;
const lead = () => r().lead;
const seori = (argv: string[]) => r().seori(argv);

// --- watches and the lead channel files ---
const ledger = () => r().ledger();
const watchRows = (watchId: string) =>
  r().inbound<{ kind: string }>().filter((row): row is WatchRow => row.kind === "watch" && (row as WatchRow).watchId === watchId);
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
/** Waits for the watch's status; a timeout names where it is instead and what its events were. */
const waitStatus = (id: string, status: Watch["status"], ms = 30_000) =>
  until(`watch ${id} ${status}`, () => (watchFile(id).status === status ? watchFile(id) : undefined), ms).catch((e: unknown) => {
    const now = watchFile(id);
    throw new Error(`${e instanceof Error ? e.message : e}; it is ${now.status} ${now.reason ?? ""} (wakes ${now.wakes.length}); events ${watchEvents(id).map((x) => x.ev).join(",")}`);
  });
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
const pids = (pattern: string) => r().pids(pattern);
/** The trigger's `tail` itself (the engine runs it under `sh -c`, which may stay as its parent). */
const tails = (trig: { path: string }) => pids(`^tail -n 0 -F ${trig.path}$`);
const fileHas = (path: string | undefined, needle: string) => !!path && existsSync(path) && readFileSync(path, "utf8").includes(needle);

const waitLeadIdle = (ms = 180_000) => r().waitLeadIdle(ms);
const prompt = (text: string) => r().prompt(lead(), text);

/**
 * The lead got this event: exactly one row with `needle` for the watch, delivered once (to `inSession` when given),
 * closed as seen, and its text in the session file of the omp session it was delivered to. Returns the row and that
 * session id.
 */
async function expectLeadGot(w: { id: string; name: string }, needle: string, ms = 60_000, inSession?: string): Promise<{ row: WatchRow; session: string }> {
  const row = await until(`a ${w.name} row with ${needle}`, () => watchRows(w.id).find((x) => x.text.includes(needle)), ms);
  expect(row.text.startsWith(prefix(w))).toBe(true);
  expect(row.id).toMatch(new RegExp(`^watch:${w.id}:\\d+$`));
  await until(`${row.id} closed as seen`, () => (seen(row.id) ? true : undefined), 120_000, 1000);
  const deliveries = deliveredTo(row.id);
  expect(deliveries).toHaveLength(1);
  const session = deliveries[0]!.session;
  if (session === undefined) throw new Error(`${row.id} was delivered without a session id`);
  if (inSession !== undefined) expect(session).toBe(inSession);
  const firstLine = row.text.split("\n")[0]!;
  const file = await until("the event in the lead's session file", () => {
    const f = r().sessionFile(session);
    return fileHas(f, firstLine) ? f : undefined;
  }, 30_000, 1000);
  expect(watchRows(w.id).filter((x) => x.text.includes(needle))).toHaveLength(1);
  log(`  ${row.id} delivered (${deliveries[0]!.mode}) and seen; in ${file}`);
  return { row, session };
}

/** The longest the engine takes from a change to its row: a file poll plus the file coalescing window, or a pane poll. */
const SETTLE_MS = Math.max(DEFAULT_TIMING.filePollMs + DEFAULT_TIMING.fileCoalesceMs, DEFAULT_TIMING.coalesceMs, DEFAULT_TIMING.panePollMs);
/** The daemon, which runs the watch engine, has gone on past `at` on its own clock: it wrote a heartbeat stamped later. */
const daemonPast = (at: number) =>
  until(`a daemon heartbeat after ${new Date(at).toISOString()}`, () => (r().beat().at >= at ? true : undefined), Math.max(0, at - Date.now()) + 3 * HEARTBEAT_MS);

/**
 * No more rows for the watch than `n`, and every row delivered at most once, checked once the daemon has run SETTLE_MS
 * past the last row: a duplicate of it would have been written by then.
 */
async function expectRows(w: { id: string }, n: number): Promise<WatchRow[]> {
  await daemonPast(Math.max(watchFile(w.id).createdAt, ...watchRows(w.id).map((x) => x.at)) + SETTLE_MS);
  const rows = watchRows(w.id);
  expect(rows.map((x) => x.text)).toHaveLength(n);
  for (const x of rows) expect(deliveredTo(x.id).length).toBeLessThanOrEqual(1);
  return rows;
}

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(work, { recursive: true });
  await r().startCore();
  log(await r().up());
  await until("the daemon heartbeat", () => r().beat(), 60_000);
  // `seori loop` reports its first run to the lead right away; start every scenario from an idle lead.
  await waitLeadIdle();
  // The lead is free to act on what it gets: told nothing, it may stop a watch it takes for noise, which is not what
  // these scenarios check.
  await prompt("This seori home is an end-to-end test of watches. [watch ...] events will arrive in this session while the test runs. Do not act on them: do not stop, rearm or add any watch and run no command for them; answer each with the one word: noted.");
  await waitLeadIdle();
}, 300_000);

afterAll(async () => {
  if (!rig) return;
  // Whatever a failed scenario left running: stop every live watch so the daemon takes its commands down.
  for (const line of (await rig.seoriRaw(["watch", "list"])).out.split("\n")) {
    const id = /^(w\S+) /.exec(line)?.[1];
    if (id) await rig.seoriRaw(["watch", "stop", id]);
  }
  const stopped = await rig.stop();
  log(`cleanup: core pid ${stopped.pid} alive=${stopped.alive}, sockets ${JSON.stringify(stopped.sockets)}, leftovers ${JSON.stringify(stopped.leftovers)}`);
  expect(stopped.alive).toBe(false);
  expect(stopped.sockets).toEqual([]);
  expect(stopped.leftovers).toEqual([]);
}, 120_000);

test.skipIf(!scenario("1"))("1 command watch with --filter: one event for the matching line, a done event on exit 0", async () => {
  await waitLeadIdle();
  t0s.set("1", Date.now());
  const s = script("s1.sh", "echo noise one; echo noise two; sleep 2; echo 'FOUND s1-token'; echo noise three; sleep 2; exit 0");
  const w = await addWatch(["--command", s, "--filter", "FOUND", "--name", "s1", "--cwd", work]);
  const hit = await expectLeadGot(w, "FOUND s1-token");
  expect(hit.row.text).toBe(`${prefix(w)}FOUND s1-token`);
  log(`1: match delivered ${since("1")} after arming`);
  const done = await expectLeadGot(w, "exited 0");
  expect(done.row.text).toContain("noise three");
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
  const got = await expectLeadGot(w, "kept crashing");
  expect(got.row.text).toBe(`${prefix(w)}kept crashing (exit 1); stopped`);
  await expectRows(w, 1);
}, 240_000);

test.skipIf(!scenario("3"))("3 file watch: created, modified (a burst coalesced) and deleted are three events; still active", async () => {
  t0s.set("3", Date.now());
  const f = join(work, "s3.txt");
  const w = await addWatch(["--file", f, "--name", "s3"]);
  await waitCheckpoint(w.id);
  writeFileSync(f, "one\n");
  await expectLeadGot(w, `created ${f}`);
  // A burst that crosses a poll and still ends inside the coalescing window must be one event. The engine polls every
  // filePollMs; the window of the poll that saw the file created closed (its `seen` event) just before the next poll,
  // so the polls fall on that phase. One append lands just after a poll, the rest just after the following poll, which
  // is the one that opened the window; they are in before it closes.
  const every = DEFAULT_TIMING.filePollMs;
  const phase = watchEvents(w.id).find((e) => e.ev === "seen" && e.text?.startsWith("created"))!.at;
  const poll = phase + Math.ceil((Date.now() + 100 - phase) / every) * every;
  const at = async (t: number) => Bun.sleep(Math.max(0, t - Date.now()));
  await at(poll + every * 0.3);
  appendFileSync(f, "two\n");
  await at(poll + every * 1.3);
  appendFileSync(f, "three\nfour\n");
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
  // hc does not report omp's session: an event before /new names the session it was delivered to.
  trig.fire("MATCH4 before-new");
  const first = await expectLeadGot(w, "MATCH4 before-new");
  await waitLeadIdle();
  // omp writes the new session's file as soon as it takes /new.
  const dir = r().sessionsDir(home)!;
  const known = new Set(readdirSync(dir));
  await prompt("/new");
  const fresh = await until("the new session's file", () => readdirSync(dir).find((n) => n.endsWith(".jsonl") && !known.has(n)), 30_000);
  await waitLeadIdle();
  t0s.set("4", Date.now());
  trig.fire("MATCH4 after-new");
  const { row, session } = await expectLeadGot(w, "MATCH4 after-new");
  log(`4: delivered ${since("4")} after the match, into session ${session} (before /new: ${first.session})`);
  expect(session).not.toBe(first.session);
  expect(r().sessionFile(session)).toBe(join(dir, fresh));
  expect(fileHas(r().sessionFile(session), row.text)).toBe(true);
  expect(fileHas(r().sessionFile(first.session), row.text)).toBe(false);
  await expectRows(w, 2);
  await seori(["watch", "stop", w.id]);
}, 300_000);

test.skipIf(!scenario("5"))("5 survives a lead restart: the event is delivered once, into the restarted lead", async () => {
  await waitLeadIdle();
  const trig = tailTrigger("s5");
  const w = await addWatch(["--command", trig.command, "--filter", "MATCH5", "--name", "s5", "--cwd", work]);
  await until("s5 command running", () => (watchEvents(w.id).some((e) => e.ev === "spawned") ? true : undefined), 15_000);
  trig.fire("MATCH5 before-restart");
  const first = await expectLeadGot(w, "MATCH5 before-restart");
  await waitLeadIdle();
  await r().restartLead();
  await waitLeadIdle();
  t0s.set("5", Date.now());
  trig.fire("MATCH5 after-restart");
  const { row, session } = await expectLeadGot(w, "MATCH5 after-restart");
  log(`5: delivered ${since("5")} after the match`);
  expect(session).not.toBe(first.session);
  expect(fileHas(r().sessionFile(first.session), row.text)).toBe(false);
  await expectRows(w, 2);
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
  const pid = await until("the daemon process", () => r().daemonPid(), 15_000);
  process.kill(pid, "SIGKILL");
  t0s.set("6", Date.now());
  // Made while no daemon runs: the restart loop waits before starting the next one.
  appendFileSync(f, "while the daemon was down\n");
  const back = await until("a new daemon heartbeat", () => {
    const b = r().beat();
    return b.pid !== pid ? b : undefined;
  }, 30_000, 200);
  log(`6: new daemon pid ${back.pid} ${since("6")} after SIGKILL of ${pid}`);
  await until("s6cmd re-run", () => (watchEvents(cmd.id).filter((e) => e.ev === "spawned").length >= 2 ? true : undefined), 15_000);
  const running = await tails(trig);
  if (running.length !== 1) log(`6: ${running.length} processes run the s6 command after the restart (orphan of the killed daemon?): ${running.join(" ")}`);
  await expectLeadGot(file, `modified ${f}`);
  log(`6: file change delivered ${since("6")} after SIGKILL`);
  trig.fire("MATCH6 after-daemon-restart");
  await expectLeadGot(cmd, "MATCH6 after-daemon-restart");
  log(`6: command match delivered ${since("6")} after SIGKILL`);
  await expectRows(file, 1);
  await expectRows(cmd, 1);
  const left = await tails(trig);
  log(`6: s6 command processes after the match: ${left.length}; watch ${watchFile(cmd.id).status} ${watchFile(cmd.id).reason ?? ""}; events ${watchEvents(cmd.id).map((e) => e.ev).join(",")}`);
  expect(left).toHaveLength(1);
  await seori(["watch", "stop", cmd.id]);
  await seori(["watch", "stop", file.id]);
}, 300_000);

test.skipIf(!scenario("7"))("7 wake budget: muted after 6 deliveries with one notice; rearm resumes", async () => {
  // A command that ticks forever only ends by `seori watch stop`, and a lead deep into this run has taken a TICK
  // flood for noise and stopped it: say it again right before.
  await waitLeadIdle();
  await prompt("The next watch, s7, prints TICK every 2 seconds on purpose and is part of this test. Leave it alone even when it gets muted: do not stop, rearm or change it. Answer each of its events with the one word: noted.");
  await waitLeadIdle();
  t0s.set("7", Date.now());
  const s = script("s7.sh", "i=0; while :; do i=$((i+1)); echo \"TICK $i\"; sleep 2; done");
  const w = await addWatch(["--command", s, "--filter", "TICK", "--name", "s7", "--cwd", work]);
  const muted = await waitStatus(w.id, "muted", 60_000);
  log(`7: muted ${since("7")} after arming`);
  expect(muted.wakes.length).toBe(WAKE_BUDGET + 1);
  // While muted the engine only counts in memory and writes the count every 30 s (DEFAULT_TIMING.mutedSaveMs).
  await until("muted events counted", () => (watchFile(w.id).mutedEvents >= 3 ? true : undefined), 50_000).catch((e: unknown) => {
    const now = watchFile(w.id);
    throw new Error(`${e instanceof Error ? e.message : e}; watch ${now.status} ${now.reason ?? ""} mutedEvents=${now.mutedEvents}; events ${watchEvents(w.id).map((x) => x.ev).join(",")}`);
  });
  const rows = watchRows(w.id);
  expect(rows).toHaveLength(WAKE_BUDGET + 1);
  expect(rows.slice(0, WAKE_BUDGET).map((x) => x.text)).toEqual(Array.from({ length: WAKE_BUDGET }, (_, i) => `${prefix(w)}TICK ${i + 1}`));
  expect(rows.filter((x) => x.text.includes("muted after"))).toHaveLength(1);
  expect(rows.at(-1)!.text).toBe(`${prefix(w)}muted after ${WAKE_BUDGET} wakes in 1h; seori watch rearm ${w.id} to resume`);
  for (const x of rows) await until(`${x.id} closed as seen`, () => (seen(x.id) ? true : undefined), 180_000, 1000);
  for (const x of rows) expect(deliveredTo(x.id)).toHaveLength(1);
  const rearm = await seori(["watch", "rearm", w.id]);
  log(`7: ${rearm.trim()}`);
  expect(rearm).toMatch(new RegExp(`^REARMED ${w.id} s7: \\d+ event\\(s\\) missed`));
  const next = await until("a TICK after rearm", () => watchRows(w.id).slice(WAKE_BUDGET + 1).find((x) => x.text.includes("TICK")), 30_000);
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
  const seoriCmd = r().seoriCmd;
  writeFileSync(brief, [
    "You are an end-to-end test lane. Do exactly these steps, in order, and nothing else:",
    "",
    `1. Run exactly this shell command: ${seoriCmd} watch add --command ${shq(s)} --filter READY --name lanewatch`,
    "2. Then wait without running any command. Within about a minute a message that starts with `[watch lanewatch` arrives in",
    "   this terminal by itself. Do not poll, do not sleep, do not run `watch list`.",
    `3. When it has arrived, run: ${seoriCmd} report ${key} --text '<the complete text of that watch message, verbatim>'`,
    `4. Then run: ${seoriCmd} ready ${key} --text 'watch event received' --evidence ${shq(`file://${brief}`)}`,
    "",
    "Do not edit files. After the ready command succeeds, stop.",
  ].join("\n"));
  // --force: the free-disk/memory guard is not under test.
  await seori(["start", key, "--brief", brief, "--cwd", work, "--force"]);
  const lanePath = join(home, "lanes", `${key}.json`);
  const laneRec = () => JSON.parse(readFileSync(lanePath, "utf8")) as Lane;
  const w = await until("the lane's watch", () => allWatches().find((x) => x.name === "lanewatch"), 240_000, 1000);
  expect(w.owner).toEqual({ kind: "lane", key });
  log(`8: lane armed ${w.id} ${since("8")} after start`);
  const delivered = await until("the lane event delivered", () => watchEvents(w.id).find((e) => e.ev === "delivered" && e.text?.includes(token)), 90_000, 1000);
  const eventText = `${prefix(w)}${delivered.text}`;
  log(`8: delivered to the lane ${since("8")} after start: ${eventText}`);
  // The lane is the only omp started in `work`: its session file is the one there that holds the event.
  const laneSession = await until("the event in the lane's session file", () => {
    const laneDir = r().sessionsDir(work);
    return (laneDir === undefined ? [] : readdirSync(laneDir)).map((n) => join(laneDir!, n)).find((p) => p.endsWith(".jsonl") && fileHas(p, eventText));
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
      return (await r().settled(laneRec().sessionRef.id)) ? true : undefined;
    }, 180_000, 1000);
    const d = await r().seoriRaw(["done", key]);
    log(`8: seori done -> ${d.code} ${d.out.trim()} ${d.err.trim()}`);
    expect(d.code === 0 || laneRec().status === "done").toBe(true);
  } else log("8: the lead closed the lane itself");
  t0s.set("8done", Date.now());
  const stopped = await waitStatus(w.id, "stopped", 15_000);
  log(`8: watch ${stopped.status} (${stopped.reason}) ${since("8done")} after done`);
  expect(stopped.reason).toBe("owner lane closed");
  await until("s8 command gone", async () => ((await pids(s)).length === 0 ? true : undefined), 15_000);
}, 900_000);

test.skipIf(!scenario("9"))("9 pane watch: --status working fires once when the lead starts a turn, then the watch is done", async () => {
  // After scenario 8 the lead still works through the lane's START, REPORT and READY and duty's notices, one turn each.
  await waitLeadIdle(420_000);
  const pane = `hc:${lead()}`;
  const w = await addWatch(["--pane", pane, "--status", "working", "--name", "s9"]);
  // The engine picks a new watch up on its next 1 s tick and polls the terminal right away: it has seen the idle lead.
  await daemonPast(watchFile(w.id).createdAt + 1_000 + DEFAULT_TIMING.panePollMs);
  expect(watchRows(w.id).map((x) => x.text)).toEqual([]);
  expect(watchFile(w.id).status).toBe("active");
  t0s.set("9", Date.now());
  await prompt("Run exactly this shell command and nothing else: sleep 15  -- then say finished.");
  const { row } = await expectLeadGot(w, `pane ${pane} is working`);
  log(`9: delivered ${since("9")} after the prompt`);
  expect(row.text).toBe(`${prefix(w)}pane ${pane} is working`);
  expect(watchFile(w.id).status).toBe("done");
  await waitLeadIdle();
  await expectRows(w, 1);
}, 720_000);

test.skipIf(!scenario("10"))("10 a 6th persistent watch for the lead is refused with exit 2", async () => {
  const livePersistent = () => allWatches().filter((w) => w.owner.kind === "lead" && w.persistent && (w.status === "active" || w.status === "muted"));
  const armed: string[] = [];
  for (let i = livePersistent().length; i < 5; i++) armed.push((await addWatch(["--file", join(work, `s10-${i}.txt`), "--name", `s10-${i}`, "--persistent"])).id);
  expect(livePersistent()).toHaveLength(5);
  const refused = await r().seoriRaw(["watch", "add", "--file", join(work, "s10-6.txt"), "--name", "s10-6", "--persistent"]);
  log(`10: 6th persistent -> exit ${refused.code}: ${refused.err.trim()}`);
  expect(refused.code).toBe(2);
  expect(refused.err).toContain("at most 5 persistent watches per owner");
  expect(livePersistent()).toHaveLength(5);
  // A non-persistent one is still allowed next to five persistent ones.
  const extra = await addWatch(["--file", join(work, "s10-x.txt"), "--name", "s10-x"]);
  for (const id of [...armed, extra.id]) await seori(["watch", "stop", id]);
}, 60_000);

// Last, it stops the daemon: its stop must take the commands of live watches down with it (they run in their own
// process groups, so nothing else would).
test.skipIf(!scenario("11"))("11 seori down daemon: no watch command outlives the daemon", async () => {
  const trig = tailTrigger("s11");
  const w = await addWatch(["--command", trig.command, "--filter", "MATCH11", "--name", "s11", "--cwd", work]);
  await until("s11 command running", () => (watchEvents(w.id).some((e) => e.ev === "spawned") ? true : undefined), 15_000);
  expect(await tails(trig)).toHaveLength(1);
  const daemon = await until("the daemon process", () => r().daemonPid(), 15_000);
  const down = await seori(["down", "daemon"]);
  log(`11: ${down.trim().replaceAll("\n", " | ")}`);
  await until("the daemon gone", () => (existsSync(`/proc/${daemon}`) ? undefined : true), 15_000);
  const left = await until("the s11 command gone", async () => {
    const p = await pids(trig.path);
    return p.length === 0 ? p : undefined;
  }, 15_000).catch(async () => pids(trig.path));
  log(`11: s11 command processes after the daemon stopped: ${left.length}`);
  expect(left).toHaveLength(0);
  // A watch that was live when its daemon went away stays live in its file, so the next daemon resumes it.
  expect(watchFile(w.id).status).toBe("active");
}, 60_000);
