import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent } from "../src/channel.ts";
import { MAX_DELIVERIES } from "../src/channel.ts";
import { ALERT_TEXT } from "../src/harness.ts";
import { BACKOFF_MS } from "../src/lead-delivery.ts";
import type { FakeOutboundRow } from "../src/messenger/fake.ts";
import { enabled, jsonl, OmpRig, until } from "./e2e-hc-omp.ts";
import { startSwitchProxy, type SwitchProxy } from "./helpers/switch-proxy.ts";

// The lead channel end to end on hc: an isolated hc core, `seori up` (a REAL omp lead with the lead-channel extension,
// duty, and the daemon, duty and hourly units run by the fake systemctl), and the fake messenger in
// $SEORI_HOME/messenger/fake/. Opt-in (model calls, costs money): SEORI_E2E_HC=1 SEORI_E2E_OMP=1, see e2e-hc-omp.ts;
// SEORI_E2E_ONLY=1,4,8 runs only those scenarios. The scenarios share one lead, in order; each uses its own message
// ids and checks only those, so a subset still works. Real waits throughout: the timing under test is omp's and hc's
// (turns, Esc, step boundaries), not a fakeable clock. omp's PI_PROXY makes a refused provider request fail only after
// SDK-internal retries, and an id is given up only BACKOFF_MS.at(-1) after its 3rd delivery, so scenario 8 takes about
// 10 minutes. The lead's state is hc's (`hc get`: status.state as omp reports it over OSC 7501).
const only = process.env["SEORI_E2E_ONLY"]?.split(",").map((s) => s.trim()).filter(Boolean);
const scenario = (n: string) => enabled && (!only || only.includes(n));
const rig = enabled ? new OmpRig("ch") : undefined;
const home = rig?.home ?? "";
const OWNER = "u1";
const CHAT = "c1";
const fakeDir = join(home, "messenger", "fake");
const proxy: { current?: SwitchProxy } = {};
const strangers: string[] = [];
const log = (line: string) => rig?.log(line);

const r = () => rig!;
const lead = () => r().lead;
const seori = (argv: string[]) => r().seori(argv);
/**
 * A process whose whole command line is `cmd` runs: the shell command a scenario told the lead (or its subagent) to run.
 * The commands name /bin/sleep: omp's bash tool runs a bare `sleep` inside omp, where no process shows it.
 */
const waitRunning = (cmd: string, ms = 90_000) =>
  until(`\`${cmd}\` running`, async () => ((await r().pids(`^${cmd}$`)).length > 0 ? true : undefined), ms, 300);

// --- the fake messenger and the channel files ---
const idOf = (msgId: string) => `fake:${CHAT}:${msgId}`;
const sendFake = (rows: { msgId: string; text: string; from?: string }[]) =>
  appendFileSync(join(fakeDir, "in.jsonl"), rows.map((m) => `${JSON.stringify({ msgId: m.msgId, chat: CHAT, from: m.from ?? OWNER, text: m.text })}\n`).join(""));
/** The same message from someone else than the owner: the daemon must drop it, so it is never stored or answered. */
const sendStranger = (msgId: string) => {
  strangers.push(msgId);
  sendFake([{ msgId, from: "intruder", text: `Reply to this message with the word ${msgId}.` }]);
};
const ledger = () => r().ledger();
const inbound = () => r().inbound();
function events(msgId: string): LedgerEvent[];
function events<E extends LedgerEvent["ev"]>(msgId: string, ev: E): Extract<LedgerEvent, { ev: E }>[];
function events(msgId: string, ev?: LedgerEvent["ev"]): LedgerEvent[] {
  return ledger().filter((e) => e.id === idOf(msgId) && (!ev || e.ev === ev));
}
const ALERTS: ReadonlySet<string> = new Set(Object.values(ALERT_TEXT));
const outRows = () => jsonl<FakeOutboundRow>(join(fakeDir, "out.jsonl"));
/** What the lead sent in reply to this message (duty's alerts are seori's, not the lead's). */
const repliesTo = (msgId: string) => outRows().filter((o) => o.replyTo === msgId && !ALERTS.has(o.text));
/** Waits for the reply; a timeout names what the ledger has for the id and the lead's state. */
const waitReplied = (msgId: string, ms: number) =>
  until(`a reply to ${msgId}`, () => (events(msgId, "replied").length ? true : undefined), ms, 1000).catch(async (e: unknown) => {
    const seen = events(msgId).map((x) => `${x.ev}${"mode" in x ? `:${x.mode}` : ""}`).join(",") || "none";
    throw new Error(`${e instanceof Error ? e.message : e}; ledger for ${msgId}: ${seen}; lead ${await leadStatus().catch(() => "?")}`);
  });

const leadStatus = () => r().status(lead());
const waitLeadIdle = (ms = 180_000) => r().waitLeadIdle(ms);
const waitLeadWorking = (ms = 30_000) => r().waitWorking(lead(), ms);
const prompt = (text: string) => r().prompt(lead(), text);

/**
 * Exactly one reply per id once the lead has settled, and nothing for the strangers sent so far. A replied id is final
 * for the delivery schedule (lead-delivery.ts), so a second reply could only come from a turn that already holds the
 * message: wait until every id is replied and the lead is idle, then count.
 */
async function expectOneReply(msgIds: readonly string[]): Promise<void> {
  for (const m of msgIds) await waitReplied(m, 60_000);
  await waitLeadIdle();
  for (const m of msgIds) {
    expect(events(m, "replied")).toHaveLength(1);
    expect(events(m, "send-uncertain")).toHaveLength(0);
    expect(events(m, "gave-up")).toHaveLength(0);
  }
  // One out.jsonl row per reply command: a reply to several ids at once is one row that answers the first of them.
  const replyRows = outRows().filter((o) => o.replyTo !== undefined && msgIds.includes(o.replyTo) && !ALERTS.has(o.text));
  const messageIds = new Set(msgIds.map((m) => events(m, "replied")[0]!.messageId));
  expect(replyRows.map((o) => o.messageId).sort()).toEqual([...messageIds].sort());
  expectStrangersIgnored();
}
function expectStrangersIgnored(): void {
  const stored = new Set(inbound().map((row) => row.id));
  for (const s of strangers) {
    expect(stored.has(idOf(s))).toBe(false);
    expect(outRows().filter((o) => o.replyTo === s)).toHaveLength(0);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  writeFileSync(join(home, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: OWNER }] }));
  await r().startCore();
  log(await r().up());
  // `seori loop` reports its first run to the lead right away; start every scenario from an idle lead.
  await waitLeadIdle();
}, 300_000);

afterAll(async () => {
  if (!rig) return;
  proxy.current?.stop();
  const stopped = await rig.stop();
  log(`cleanup: core pid ${stopped.pid} alive=${stopped.alive}, sockets ${JSON.stringify(stopped.sockets)}, leftovers ${JSON.stringify(stopped.leftovers)}`);
  expect(stopped.alive).toBe(false);
  expect(stopped.sockets).toEqual([]);
  expect(stopped.leftovers).toEqual([]);
}, 120_000);

test.skipIf(!scenario("1"))("1 idle lead: one message gets exactly one reply; a non-owner's message is dropped", async () => {
  await waitLeadIdle();
  const t0 = Date.now();
  sendStranger("s1");
  sendFake([{ msgId: "m1", text: "What is 2+2? Reply with just the number." }]);
  await waitReplied("m1", 120_000);
  log(`1: replied ${(Date.now() - t0) / 1000} s after sending`);
  const delivered = events("m1", "delivered");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ attempt: 1, mode: "followUp" });
  expect(events("m1", "entered")).toHaveLength(1);
  await expectOneReply(["m1"]);
}, 240_000);

test.skipIf(!scenario("2"))("2 busy lead: a message mid-task is delivered aside and answered, and the task still finishes", async () => {
  await waitLeadIdle();
  const done = join(home, "task2.done");
  await prompt(`Run exactly this shell command and nothing else: /bin/sleep 20 && echo ok > ${done}  -- then say finished.`);
  await waitLeadWorking();
  await waitRunning("/bin/sleep 20");
  const t0 = Date.now();
  sendStranger("s2");
  sendFake([{ msgId: "m2", text: "Quick question while you work: what is the capital of France? Reply with one word." }]);
  await waitReplied("m2", 150_000);
  log(`2: replied ${(Date.now() - t0) / 1000} s after sending`);
  expect(events("m2", "delivered")[0]).toMatchObject({ attempt: 1, mode: "aside" });
  await until("the lead's task file", () => (existsSync(done) ? true : undefined), 120_000, 1000);
  await waitLeadIdle();
  expect(readFileSync(done, "utf8").trim()).toBe("ok");
  expect(events("m2", "delivered")).toHaveLength(1);
  await expectOneReply(["m2"]);
}, 360_000);

test.skipIf(!scenario("3"))("3 burst of five: five answered ids, at most two deliveries each", async () => {
  await waitLeadIdle();
  const ids = ["m3a", "m3b", "m3c", "m3d", "m3e"];
  const t0 = Date.now();
  sendStranger("s3");
  sendFake(ids.map((msgId, i) => ({ msgId, text: `Burst message ${i + 1} of 5: reply to this one with the number ${i + 1}.` })));
  for (const m of ids) await waitReplied(m, 240_000);
  log(`3: all five replied ${(Date.now() - t0) / 1000} s after sending`);
  for (const m of ids) {
    const n = events(m, "delivered").length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
  }
  log(`3: deliveries per id ${ids.map((m) => events(m, "delivered").length).join(",")}`);
  await expectOneReply(ids);
}, 420_000);

test.skipIf(!scenario("4"))("4 lead killed after delivery, before replying: restarted the seori way, exactly one reply in total", async () => {
  await waitLeadIdle();
  const t0 = Date.now();
  sendStranger("s4");
  sendFake([{ msgId: "m4", text: "First run the shell command `/bin/sleep 15`, and only after it has finished, reply with the word kill-ok." }]);
  await until("m4 entered", () => (events("m4", "entered").length ? true : undefined), 60_000);
  // The lead is inside `/bin/sleep 15`, well before it could reply.
  await waitRunning("/bin/sleep 15");
  expect(events("m4", "replied")).toHaveLength(0);
  const before = events("m4", "delivered").at(-1)!;
  await r().restartLead();
  log(`4: lead restarted ${(Date.now() - t0) / 1000} s after sending`);
  await waitReplied("m4", 180_000);
  log(`4: replied ${(Date.now() - t0) / 1000} s after sending`);
  const delivered = events("m4", "delivered");
  expect(delivered.length).toBeGreaterThanOrEqual(2);
  expect(delivered.at(-1)!.session).not.toBe(before.session);
  await expectOneReply(["m4"]);
}, 360_000);

test.skipIf(!scenario("5"))("5 /new with an open id: carried into the new session and answered once", async () => {
  await waitLeadIdle();
  const t0 = Date.now();
  sendStranger("s5");
  sendFake([{ msgId: "m5", text: "First run the shell command `/bin/sleep 15`, and only after it has finished, reply with the word new-ok." }]);
  await until("m5 entered", () => (events("m5", "entered").length ? true : undefined), 60_000);
  await waitRunning("/bin/sleep 15");
  const before = events("m5", "delivered").at(-1)!;
  // omp takes /new only at an idle prompt: stop the turn first, then switch sessions right away (well within the
  // 10 s grace an aborted turn gets before a plain redelivery, so the carry-over is what answers it).
  await r().esc(lead());
  await until("the lead idle after Esc", async () => ((await r().settled(lead())) ? true : undefined), 15_000, 300);
  await prompt("/new");
  await waitReplied("m5", 180_000);
  log(`5: replied ${(Date.now() - t0) / 1000} s after sending`);
  const after = events("m5", "delivered");
  expect(after.some((e) => e.session !== before.session)).toBe(true);
  expect(after.length).toBeLessThanOrEqual(MAX_DELIVERIES);
  await expectOneReply(["m5"]);
}, 360_000);

test.skipIf(!scenario("6"))("6 subagent running: the delivery lands only in the lead's session, never in the subagent's", async () => {
  await waitLeadIdle();
  // omp keeps a subagent's session file in a directory named after its parent's session file. Only the lead spawns
  // subagents here (duty's omp shares the cwd but sits idle), so a new file in such a directory is the lead's subagent.
  const dir = await until("the lead's session dir", () => r().sessionsDir(home), 30_000);
  const subFiles = () =>
    readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) =>
      readdirSync(join(dir, e.name)).filter((f) => f.endsWith(".jsonl") && !f.startsWith("__")).map((f) => join(e.name, f)));
  const known = new Set(subFiles());
  await prompt("Use the task tool to spawn exactly one subagent whose only job is to run the shell command `/bin/sleep 20` and then report done. Wait for it to finish. Do nothing else yourself.");
  const sub = await until("a subagent session", () => subFiles().find((f) => !known.has(f)), 90_000);
  const subDir = join(dir, sub.split("/")[0]!);
  const main = `${subDir}.jsonl`;
  await waitRunning("/bin/sleep 20");
  const t0 = Date.now();
  sendStranger("s6");
  sendFake([{ msgId: "m6", text: "Reply with the word pong." }]);
  await waitReplied("m6", 150_000);
  log(`6: replied ${(Date.now() - t0) / 1000} s after sending (subagent ${sub})`);
  await waitLeadIdle();
  const delivered = events("m6", "delivered");
  expect(statSync(join(dir, sub)).birthtimeMs).toBeLessThan(delivered[0]!.at);
  // The extension names the session it delivered to: the lead's, the parent of the subagent's directory.
  expect(r().sessionFile(delivered[0]!.session ?? "(none)")).toBe(main);
  const custom = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => l.includes('"customType":"seori-inbound"') && l.includes(idOf("m6")));
  expect(custom(main).length).toBeGreaterThanOrEqual(1);
  for (const f of readdirSync(subDir).filter((n) => n.endsWith(".jsonl") && !n.startsWith("__"))) expect(custom(join(subDir, f))).toHaveLength(0);
  await expectOneReply(["m6"]);
}, 360_000);

test.skipIf(!scenario("7"))("7 Esc mid-task, then a message: in the lead's session within 5 s and answered", async () => {
  await waitLeadIdle();
  await prompt("Run exactly this shell command and nothing else: /bin/sleep 25  -- then say finished.");
  await waitLeadWorking();
  await waitRunning("/bin/sleep 25");
  await r().esc(lead());
  await until("the lead idle after Esc", async () => ((await r().settled(lead())) ? true : undefined), 15_000, 300);
  const t0 = Date.now();
  sendStranger("s7");
  sendFake([{ msgId: "m7", text: "Reply with the word esc-ok." }]);
  await waitReplied("m7", 60_000);
  const secs = (Date.now() - t0) / 1000;
  log(`7: replied ${secs} s after sending; ledger ${events("m7").map((e) => `${e.ev}@${((e.at - t0) / 1000).toFixed(1)}`).join(" ")}`);
  // seori's part: delivered and entered right after the Esc, neither held behind the aborted command nor the 10 s
  // grace of an aborted turn. How long the reply turn then takes is the model's.
  const entered = events("m7", "entered")[0]!;
  expect(entered.at - t0).toBeLessThanOrEqual(5_000);
  expect(events("m7", "delivered")[0]).toMatchObject({ attempt: 1, mode: "followUp" });
  await expectOneReply(["m7"]);
}, 240_000);

test.skipIf(!scenario("7b"))("7b message delivered aside to a busy lead, then Esc before it is answered: still answered once", async () => {
  await waitLeadIdle();
  await prompt("Run exactly this shell command and nothing else: /bin/sleep 25  -- then say finished.");
  await waitLeadWorking();
  await waitRunning("/bin/sleep 25");
  const t0 = Date.now();
  sendStranger("s7b");
  sendFake([{ msgId: "m7b", text: "Reply with the word aside-esc-ok." }]);
  await until("m7b delivered", () => (events("m7b", "delivered").length ? true : undefined), 15_000, 300);
  // `delivered` is written once omp holds the aside; Esc while the lead's command still runs, before any reply.
  expect(events("m7b", "replied")).toHaveLength(0);
  await r().esc(lead());
  await waitReplied("m7b", 120_000);
  log(`7b: replied ${(Date.now() - t0) / 1000} s after sending; deliveries ${events("m7b", "delivered").map((e) => e.mode).join(",")}`);
  expect(events("m7b", "delivered")[0]).toMatchObject({ attempt: 1, mode: "aside" });
  await expectOneReply(["m7b"]);
}, 240_000);

/** Stops the running daemon with `stop`, sends one message right away, and expects a new daemon to store and answer it. */
async function daemonComesBack(label: string, msgId: string, stop: (pid: number) => void): Promise<void> {
  // Not idle: after scenario 8 the lead's last turn may have ended in a provider error, which omp may report as other
  // than idle until its next turn, though omp takes input and the extension delivers as to an idle lead.
  await until("the lead not working", async () => ((await leadStatus()) !== "working" ? true : undefined), 180_000, 1500);
  const pid = await until("the daemon process", () => r().daemonPid(), 15_000);
  stop(pid);
  const t0 = Date.now();
  sendStranger(`s${msgId}`);
  sendFake([{ msgId, text: `Reply with the word ${label}-ok.` }]);
  const back = await until("a new daemon heartbeat", () => {
    const b = r().beat();
    return b.pid !== pid ? b : undefined;
  }, 30_000, 200);
  expect(await r().daemonPid()).toBe(back.pid);
  log(`${label}: new daemon pid ${back.pid} ${(Date.now() - t0) / 1000} s after stopping ${pid}`);
  await until(`${msgId} stored`, () => (inbound().some((row) => row.id === idOf(msgId)) ? true : undefined), 30_000);
  await waitReplied(msgId, 120_000);
  log(`${label}: replied ${(Date.now() - t0) / 1000} s after sending`);
  await expectOneReply([msgId]);
}

test.skipIf(!scenario("9a"))("9a messengers.json edited: the daemon exits to reload it, the loop restarts it, a message sent meanwhile is answered", async () => {
  await daemonComesBack("9a", "m9a", () =>
    writeFileSync(join(home, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: OWNER }] }, null, 2)));
}, 240_000);

test.skipIf(!scenario("8"))("8 provider outage: redelivered and answered once it recovers; a permanent outage ends in gave-up and a duty notice", async () => {
  await waitLeadIdle();
  const p = (proxy.current = startSwitchProxy("refuse"));
  // omp sends provider traffic through PI_PROXY; no retries inside omp, so a refused request ends the turn with an
  // error and only seori's redelivery can bring the message back. The overlay goes after the lead's own settings files.
  const overlay = join(home, "e2e-omp-retry.yml");
  writeFileSync(overlay, "retry:\n  maxRetries: 0\n  modelFallback: false\n");
  const files = await r().ompEnv(lead(), "PI_CONFIG_FILES");
  expect(files).toContain(join(home, "prompts", "lead-omp.yml"));
  await r().restartLead({ PI_PROXY: p.url, HTTPS_PROXY: p.url, HTTP_PROXY: p.url, PI_CONFIG_FILES: `${files}:${overlay}` });
  await waitLeadIdle();

  try {
    // Phase A: refused at first delivery, passed afterwards.
    const t0 = Date.now();
    sendStranger("s8a");
    sendFake([{ msgId: "m8a", text: "Reply with the word proxy-ok." }]);
    await until("m8a delivered", () => (events("m8a", "delivered").length ? true : undefined), 30_000);
    await until("a refused provider request", () => (p.seen.refuse > 0 ? true : undefined), 60_000);
    // The turn that ended in a provider error is no longer working; the redelivery follows 10 s later.
    await until("the failed turn's end", async () => ((await leadStatus()) !== "working" ? true : undefined), 120_000, 500);
    log(`8a: first turn failed ${(Date.now() - t0) / 1000} s after sending (refused ${p.seen.refuse}, status ${await leadStatus()}); passing from now on`);
    expect(events("m8a", "replied")).toHaveLength(0);
    p.mode = "pass";
    await waitReplied("m8a", 180_000);
    log(`8a: replied ${(Date.now() - t0) / 1000} s after sending; deliveries ${events("m8a", "delivered").length}`);
    expect(events("m8a", "delivered").length).toBeGreaterThanOrEqual(2);
    await expectOneReply(["m8a"]);

    // Phase B: refused for good.
    await waitLeadIdle();
    p.mode = "refuse";
    const t1 = Date.now();
    sendFake([{ msgId: "m8b", text: "Reply with the word never." }]);
    // Three failed turns (~1 min each), then the final backoff after the 3rd delivery before it counts as given up.
    const gaveUp = await until("m8b gave-up", () => events("m8b", "gave-up")[0], (3 * 90 + BACKOFF_MS.at(-1)! / 1000 + 120) * 1000, 2000);
    const third = events("m8b", "delivered")[MAX_DELIVERIES - 1]!;
    expect(gaveUp.at - third.at).toBeGreaterThanOrEqual(BACKOFF_MS.at(-1)!);
    log(`8b: gave-up ${(Date.now() - t1) / 1000} s after sending: ${JSON.stringify(gaveUp)}`);
    expect(gaveUp).toMatchObject({ attempts: MAX_DELIVERIES });
    expect(events("m8b", "delivered")).toHaveLength(MAX_DELIVERIES);
    expect(events("m8b", "replied")).toHaveLength(0);
    // The duty unit runs `seori duty --interval 60` too; whichever tick comes first, the human hears about it once.
    log(`8b: duty --once: ${(await seori(["duty", "--once"])).trim() || "(no events)"}`);
    const notices = outRows().filter((o) => o.replyTo === "m8b" && o.text === ALERT_TEXT["gave-up"]);
    expect(notices).toHaveLength(1);
    expect(events("m8b", "alerted").filter((e) => e.why === "gave-up")).toHaveLength(1);
    expect(repliesTo("m8b")).toHaveLength(0);
  } finally {
    // Scenario 9 needs a lead that can answer again.
    p.mode = "pass";
  }
}, 1_500_000);

// Last: if a killed daemon is not restarted, nothing after this could receive messages.
test.skipIf(!scenario("9"))("9 daemon crashed (SIGKILL): the restart loop brings it back and a message sent right after is stored and answered", async () => {
  await daemonComesBack("9", "m9", (pid) => process.kill(pid, "SIGKILL"));
}, 240_000);

test.skipIf(!enabled)("across every scenario run: no id answered twice, every lead message recorded, strangers never stored", () => {
  const replied = new Map<string, number>();
  for (const e of ledger()) if (e.ev === "replied") replied.set(e.id, (replied.get(e.id) ?? 0) + 1);
  for (const [id, n] of replied) expect(`${id} x${n}`).toBe(`${id} x1`);
  const recorded = new Set(ledger().flatMap((e) => (e.ev === "replied" ? [e.messageId] : [])));
  const unrecorded = outRows().filter((o) => !ALERTS.has(o.text) && !recorded.has(o.messageId));
  expect(unrecorded).toEqual([]);
  expectStrangersIgnored();
  log(`summary: ${inbound().length} stored, ${replied.size} replied, out rows ${outRows().length}`);
});
