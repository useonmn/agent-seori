import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LedgerEvent } from "../src/channel.ts";
import { MAX_DELIVERIES } from "../src/channel.ts";
import { LEAD_EXTENSION } from "../src/cli.ts";
import { ALERT_TEXT, startAgent, type Deps } from "../src/harness.ts";
import { shq, spawnExec } from "../src/runtime/exec.ts";
import { Herdr, HerdrError } from "../src/runtime/herdr/client.ts";
import { defaultRuntimes } from "../src/runtime/index.ts";
import { BACKOFF_MS } from "../src/lead-delivery.ts";
import type { FakeOutboundRow } from "../src/messenger/fake.ts";
import { startSwitchProxy, type SwitchProxy } from "./helpers/switch-proxy.ts";
import { herdrRef } from "./fake.ts";

// The lead channel end to end: real herdr in an isolated named session, `seori up` (lead with the lead-channel
// extension, duty, loops and the messenger daemon), a REAL omp lead (model calls, costs money) and the fake messenger
// in $SEORI_HOME/messenger/fake/. Opt-in with SEORI_E2E_OMP=1; SEORI_E2E_ONLY=1,4,8 runs only those scenarios.
// The scenarios share one lead, in order; each uses its own message ids and checks only those, so a subset still works.
// Real waits throughout: the timing under test is omp's and herdr's (turns, Esc, step boundaries), not a fakeable clock.
// omp's PI_PROXY makes a refused provider request fail only after ~50 s of SDK-internal retries, and an id is given up
// only BACKOFF_MS.at(-1) after its 3rd delivery, so scenario 8 takes about 10 minutes.
const herdrBin = Bun.which("herdr");
const enabled = !!herdrBin && process.env["SEORI_E2E_OMP"] === "1";
const only = process.env["SEORI_E2E_ONLY"]?.split(",").map((s) => s.trim()).filter(Boolean);
const scenario = (n: string) => enabled && (!only || only.includes(n));
const session = `seori-e2e-ch-${process.pid}`;
// realpath: macOS hands out /var/... for /private/var/...; omp records the resolved cwd in its session paths.
const home = realpathSync(mkdtempSync(join(tmpdir(), "seori-e2e-ch-")));
const cli = resolve(import.meta.dir, "../src/cli.ts");
const model = process.env["SEORI_E2E_MODEL"] ?? "anthropic/claude-haiku-5-5";
// Run from inside herdr or omp, the caller's pane, socket, omp session and seori command would leak into the herdr
// server (and so into every pane and omp it starts) and into seori itself.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HERDR_|PI_|OMPCODE$|SEORI_)/.test(k)));
const env = { ...inherited, SEORI_HOME: home, SEORI_HERDR_SESSION: session, SEORI_MODEL: model };
const OWNER = "u1";
const CHAT = "c1";
const fakeDir = join(home, "messenger", "fake");
const herdrApi = new Herdr(spawnExec, session);
const proxy: { current?: SwitchProxy } = {};
let server: Bun.Subprocess | undefined;
let panes: Record<string, string> = {};
const strangers: string[] = [];

const herdr = async (...argv: string[]) => {
  const r = await spawnExec("herdr", ["--session", session, ...argv]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout || "{}").result;
};
const seori = async (argv: string[]) => {
  const p = Bun.spawn(["bun", cli, ...argv], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`seori ${argv.join(" ")} -> ${code}: ${err}`);
  return out;
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
const log = (line: string) => console.log(`[e2e-channel ${new Date().toISOString().slice(11, 19)}] ${line}`);

// --- the fake messenger and the channel files ---
const idOf = (msgId: string) => `fake:${CHAT}:${msgId}`;
const sendFake = (rows: { msgId: string; text: string; from?: string }[]) =>
  appendFileSync(join(fakeDir, "in.jsonl"), rows.map((r) => `${JSON.stringify({ msgId: r.msgId, chat: CHAT, from: r.from ?? OWNER, text: r.text })}\n`).join(""));
/** The same message from someone else than the owner: the daemon must drop it, so it is never stored or answered. */
const sendStranger = (msgId: string) => {
  strangers.push(msgId);
  sendFake([{ msgId, from: "intruder", text: `Reply to this message with the word ${msgId}.` }]);
};
const jsonl = <T>(path: string): T[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T) : [];
const ledger = () => jsonl<LedgerEvent>(join(home, "lead", "ledger.jsonl"));
const inbound = () => jsonl<{ id: string }>(join(home, "lead", "inbound.jsonl"));
function events(msgId: string): LedgerEvent[];
function events<E extends LedgerEvent["ev"]>(msgId: string, ev: E): Extract<LedgerEvent, { ev: E }>[];
function events(msgId: string, ev?: LedgerEvent["ev"]): LedgerEvent[] {
  return ledger().filter((e) => e.id === idOf(msgId) && (!ev || e.ev === ev));
}
const ALERTS: ReadonlySet<string> = new Set(Object.values(ALERT_TEXT));
const outRows = () => jsonl<FakeOutboundRow>(join(fakeDir, "out.jsonl"));
/** What the lead sent in reply to this message (duty's alerts are seori's, not the lead's). */
const repliesTo = (msgId: string) => outRows().filter((r) => r.replyTo === msgId && !ALERTS.has(r.text));
const waitReplied = (msgId: string, ms: number) =>
  until(`a reply to ${msgId}`, () => (events(msgId, "replied").length ? true : undefined), ms, 1000);

/**
 * Exactly one reply per id, also after a quiet period (a second reply would come from a redelivery a few seconds
 * later), and nothing for the strangers sent so far.
 */
async function expectOneReply(msgIds: readonly string[], quietMs = 15_000): Promise<void> {
  await Bun.sleep(quietMs);
  for (const m of msgIds) {
    expect(events(m, "replied")).toHaveLength(1);
    expect(events(m, "send-uncertain")).toHaveLength(0);
    expect(events(m, "gave-up")).toHaveLength(0);
  }
  // One out.jsonl row per reply command: a reply to several ids at once is one row that answers the first of them.
  const replyRows = outRows().filter((r) => r.replyTo !== undefined && msgIds.includes(r.replyTo) && !ALERTS.has(r.text));
  const messageIds = new Set(msgIds.map((m) => events(m, "replied")[0]!.messageId));
  expect(replyRows.map((r) => r.messageId).sort()).toEqual([...messageIds].sort());
  expectStrangersIgnored();
}
function expectStrangersIgnored(): void {
  const stored = new Set(inbound().map((r) => r.id));
  for (const s of strangers) {
    expect(stored.has(idOf(s))).toBe(false);
    expect(outRows().filter((r) => r.replyTo === s)).toHaveLength(0);
  }
}

// --- the lead in herdr ---
const lead = () => panes["lead"]!;
const paneInfo = async (pane: string) => (await herdr("pane", "get", pane)).pane as { agent?: string; agent_status?: string; agent_session?: { value?: string } };
const leadStatus = async () => (await paneInfo(lead())).agent_status;
/** Idle for two polls in a row: a turn that ends and immediately continues (a followUp) does not count. */
const waitLeadIdle = async (ms = 180_000) => {
  let streak = 0;
  await until("the lead idle", async () => ((streak = (await leadStatus()) === "idle" ? streak + 1 : 0) >= 2 ? true : undefined), ms, 1500);
};
const waitLeadWorking = (ms = 30_000) => until("the lead working", async () => ((await leadStatus()) === "working" ? true : undefined), ms, 300);
const prompt = (text: string) => herdr("agent", "prompt", lead(), text);
const foreground = async (pane: string) =>
  ((await herdr("pane", "process-info", "--pane", pane)).process_info.foreground_processes ?? []) as { pid: number; cmdline: string }[];
const leadOmpPid = async () => (await foreground(lead())).find((p) => /(^|\/)omp( |$)/.test(p.cmdline))?.pid;
const sessionFile = async () => (await paneInfo(lead())).agent_session?.value;

/**
 * Stops the lead's omp with SIGTERM and starts it again the way `seori up` does: `herdr agent start` in the same pane
 * (whose shell carries the workspace env) with the extension and the rendered lead prompt. `exports` are exported in
 * that shell first; they stay for every later start in this pane.
 */
async function restartLead(exports: Record<string, string> = {}): Promise<void> {
  const pid = await leadOmpPid();
  if (pid === undefined) throw new Error("no omp in the lead pane");
  process.kill(pid, "SIGTERM");
  await until("the lead omp gone", async () => ((await paneInfo(lead())).agent ? undefined : true), 30_000);
  if (Object.keys(exports).length) {
    await herdr("pane", "run", lead(), `export ${Object.entries(exports).map(([k, v]) => `${k}=${shq(v)}`).join(" ")}`);
    await Bun.sleep(500);
  }
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

beforeAll(async () => {
  if (!enabled) return;
  writeFileSync(join(home, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: OWNER }] }));
  server = Bun.spawn([herdrBin!, "--session", session, "server"], { env: inherited, cwd: home, stdout: "ignore", stderr: "ignore" });
  await until("herdr server", () => herdr("workspace", "list"));
  const up = await seori(["up", "--cwd", home]);
  log(up.trim());
  panes = Object.fromEntries([...up.matchAll(/(\w+)=(w\d+:p\d+)/g)].map((m) => [m[1]!, m[2]!]));
  expect(Object.keys(panes).sort()).toEqual(["daemon", "duty", "hourly", "lead", "loop"]);
  // `seori loop` reports its first run to the lead right away; start every scenario from an idle lead.
  await waitLeadIdle();
}, 300_000);

afterAll(async () => {
  if (!enabled) return;
  proxy.current?.stop();
  await spawnExec("herdr", ["--session", session, "server", "stop"]);
  await server?.exited;
  await spawnExec("herdr", ["session", "delete", session]);
});

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
  await prompt(`Run exactly this shell command and nothing else: sleep 20 && echo ok > ${done}  -- then say finished.`);
  await waitLeadWorking();
  await Bun.sleep(5000);
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
  sendFake([{ msgId: "m4", text: "First run the shell command `sleep 15`, and only after it has finished, reply with the word kill-ok." }]);
  await until("m4 entered", () => (events("m4", "entered").length ? true : undefined), 60_000);
  // Long enough for the lead to be inside `sleep 15`, well before it could reply.
  await Bun.sleep(6000);
  expect(events("m4", "replied")).toHaveLength(0);
  const before = events("m4", "delivered").at(-1)!;
  await restartLead();
  log(`4: lead restarted ${(Date.now() - t0) / 1000} s after sending`);
  await waitReplied("m4", 180_000);
  log(`4: replied ${(Date.now() - t0) / 1000} s after sending`);
  const delivered = events("m4", "delivered");
  expect(delivered.length).toBeGreaterThanOrEqual(2);
  expect(delivered.at(-1)!.session).not.toBe(before.session);
  await expectOneReply(["m4"], 25_000);
}, 360_000);

test.skipIf(!scenario("5"))("5 /new with an open id: carried into the new session and answered once", async () => {
  await waitLeadIdle();
  const t0 = Date.now();
  sendStranger("s5");
  sendFake([{ msgId: "m5", text: "First run the shell command `sleep 15`, and only after it has finished, reply with the word new-ok." }]);
  await until("m5 entered", () => (events("m5", "entered").length ? true : undefined), 60_000);
  await Bun.sleep(4000);
  const before = events("m5", "delivered").at(-1)!;
  // omp takes /new only at an idle prompt: stop the turn first, then switch sessions right away (well within the
  // 10 s grace an aborted turn gets before a plain redelivery, so the carry-over is what answers it).
  await herdr("pane", "send-keys", lead(), "esc");
  await until("the lead idle after Esc", async () => ((await leadStatus()) === "idle" ? true : undefined), 15_000, 300);
  await prompt("/new");
  await waitReplied("m5", 180_000);
  log(`5: replied ${(Date.now() - t0) / 1000} s after sending`);
  const after = events("m5", "delivered");
  expect(after.some((e) => e.session !== before.session)).toBe(true);
  expect(after.length).toBeLessThanOrEqual(MAX_DELIVERIES);
  await expectOneReply(["m5"], 25_000);
}, 360_000);

test.skipIf(!scenario("6"))("6 subagent running: the delivery lands only in the lead's session, never in the subagent's", async () => {
  await waitLeadIdle();
  await prompt("Use the task tool to spawn exactly one subagent whose only job is to run the shell command `sleep 20` and then report done. Wait for it to finish. Do nothing else yourself.");
  const main = await until("the lead's session file", sessionFile, 30_000);
  const subDir = main.replace(/\.jsonl$/, "");
  const subFiles = () => (existsSync(subDir) ? readdirSync(subDir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("__")) : []);
  const known = new Set(subFiles());
  const sub = await until("a subagent session", () => subFiles().find((f) => !known.has(f)), 90_000);
  await Bun.sleep(3000);
  const t0 = Date.now();
  sendStranger("s6");
  sendFake([{ msgId: "m6", text: "Reply with the word pong." }]);
  await waitReplied("m6", 150_000);
  log(`6: replied ${(Date.now() - t0) / 1000} s after sending (subagent ${sub})`);
  await waitLeadIdle();
  const delivered = events("m6", "delivered");
  expect(statSync(join(subDir, sub)).birthtimeMs).toBeLessThan(delivered[0]!.at);
  const custom = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => l.includes('"customType":"seori-inbound"') && l.includes(idOf("m6")));
  expect(custom(main).length).toBeGreaterThanOrEqual(1);
  for (const f of readdirSync(subDir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("__"))) expect(custom(join(subDir, f))).toHaveLength(0);
  await expectOneReply(["m6"]);
}, 360_000);

test.skipIf(!scenario("7"))("7 Esc mid-task, then a message: answered within about 20 s", async () => {
  await waitLeadIdle();
  await prompt("Run exactly this shell command and nothing else: sleep 25  -- then say finished.");
  await waitLeadWorking();
  await Bun.sleep(5000);
  await herdr("pane", "send-keys", lead(), "esc");
  await until("the lead idle after Esc", async () => ((await leadStatus()) === "idle" ? true : undefined), 15_000, 300);
  const t0 = Date.now();
  sendStranger("s7");
  sendFake([{ msgId: "m7", text: "Reply with the word esc-ok." }]);
  await waitReplied("m7", 60_000);
  const secs = (Date.now() - t0) / 1000;
  log(`7: replied ${secs} s after sending`);
  expect(secs).toBeLessThanOrEqual(25);
  expect(events("m7", "delivered")[0]).toMatchObject({ attempt: 1, mode: "followUp" });
  await expectOneReply(["m7"]);
}, 240_000);

test.skipIf(!scenario("7b"))("7b message delivered aside to a busy lead, then Esc before it is answered: still answered once", async () => {
  await waitLeadIdle();
  await prompt("Run exactly this shell command and nothing else: sleep 25  -- then say finished.");
  await waitLeadWorking();
  await Bun.sleep(3000);
  const t0 = Date.now();
  sendStranger("s7b");
  sendFake([{ msgId: "m7b", text: "Reply with the word aside-esc-ok." }]);
  await until("m7b delivered", () => (events("m7b", "delivered").length ? true : undefined), 15_000, 300);
  await Bun.sleep(2000);
  await herdr("pane", "send-keys", lead(), "esc");
  await waitReplied("m7b", 120_000);
  log(`7b: replied ${(Date.now() - t0) / 1000} s after sending; deliveries ${events("m7b", "delivered").map((e) => e.mode).join(",")}`);
  expect(events("m7b", "delivered")[0]).toMatchObject({ attempt: 1, mode: "aside" });
  await expectOneReply(["m7b"]);
}, 240_000);

const beat = () => JSON.parse(readFileSync(join(home, "messenger", "daemon.heartbeat"), "utf8")) as { at: number; pid: number };
const daemonPid = async () => (await foreground(panes["daemon"]!)).find((p) => p.cmdline.includes("cli.ts daemon") && !p.cmdline.startsWith("sh "))?.pid;

/** Stops the running daemon with `stop`, sends one message right away, and expects a new daemon to store and answer it. */
async function daemonComesBack(label: string, msgId: string, stop: (pid: number) => void): Promise<void> {
  // Not idle: after scenario 8 herdr keeps reporting the lead `blocked` (its last turn ended in a provider error) until
  // its next turn, though omp takes input and the extension delivers as to an idle lead.
  await until("the lead not working", async () => ((await leadStatus()) !== "working" ? true : undefined), 180_000, 1500);
  const pid = await until("the daemon process", daemonPid, 15_000);
  expect(beat().pid).toBe(pid);
  stop(pid);
  const t0 = Date.now();
  sendStranger(`s${msgId}`);
  sendFake([{ msgId, text: `Reply with the word ${label}-ok.` }]);
  const back = await until("a new daemon heartbeat", () => {
    const b = beat();
    return b.pid !== pid ? b : undefined;
  }, 30_000, 200).catch(async (e) => {
    const front = (await foreground(panes["daemon"]!)).map((p) => p.cmdline);
    throw new Error(`${e instanceof Error ? e.message : e}; daemon pane foreground now: ${JSON.stringify(front)}`);
  });
  log(`${label}: new daemon pid ${back.pid} ${(Date.now() - t0) / 1000} s after stopping ${pid}`);
  await until(`${msgId} stored`, () => (inbound().some((r) => r.id === idOf(msgId)) ? true : undefined), 30_000);
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
  // omp sends provider traffic through PI_PROXY (it ignores HTTPS_PROXY for Anthropic); no retries inside omp, so a
  // refused request ends the turn with an error and only seori's redelivery can bring the message back.
  const overlay = join(home, "e2e-omp-retry.yml");
  writeFileSync(overlay, "retry:\n  maxRetries: 0\n  modelFallback: false\n");
  await restartLead({ PI_PROXY: p.url, HTTPS_PROXY: p.url, HTTP_PROXY: p.url, PI_CONFIG_FILES: overlay });
  await waitLeadIdle();

  try {
    // Phase A: refused at first delivery, passed afterwards.
    const t0 = Date.now();
    sendStranger("s8a");
    sendFake([{ msgId: "m8a", text: "Reply with the word proxy-ok." }]);
    await until("m8a delivered", () => (events("m8a", "delivered").length ? true : undefined), 30_000);
    await until("a refused provider request", () => (p.seen.refuse > 0 ? true : undefined), 60_000);
    // herdr reports a turn that ended in a provider error as `blocked`, not idle; the redelivery follows 10 s later.
    await until("the failed turn's end", async () => (["blocked", "idle"].includes((await leadStatus()) ?? "") ? true : undefined), 120_000, 500);
    log(`8a: first turn failed ${(Date.now() - t0) / 1000} s after sending (refused ${p.seen.refuse}); passing from now on`);
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
    // The duty pane runs `seori duty --interval 60` too; whichever tick comes first, the human hears about it once.
    log(`8b: duty --once: ${(await seori(["duty", "--once"])).trim() || "(no events)"}`);
    const notices = outRows().filter((r) => r.replyTo === "m8b" && r.text === ALERT_TEXT["gave-up"]);
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
  const unrecorded = outRows().filter((r) => !ALERTS.has(r.text) && !recorded.has(r.messageId));
  expect(unrecorded).toEqual([]);
  expectStrangersIgnored();
  log(`summary: ${inbound().length} stored, ${replied.size} replied, ledger in ${join(home, "lead")}, out rows ${outRows().length}`);
});
