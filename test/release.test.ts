import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import type { MessengerAdapter, MessengerConfig } from "../src/messenger/adapter.ts";
import { msgFlush, msgSend, type MsgDeps } from "../src/msg.ts";
import { isAdvisorMessage, RELEASE_GRACE_MS, ReleaseScheduler } from "../src/release.ts";

/** Fake clock and timers: `advance` moves the clock and runs what is due. */
function timers(start = 1_000_000) {
  let now = start;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: now + ms, fn, live: true };
    due.push(t);
    return () => void (t.live = false);
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of due.filter((x) => x.live && x.at <= now)) {
      t.live = false;
      t.fn();
    }
  };
  return { schedule, advance, now: () => now };
}

const END = { willContinue: false };
const ADVISOR = { role: "custom", customType: "advisor", content: "concern: the reply names the wrong PR" };
const INBOUND = { role: "custom", customType: "seori-inbound", content: "messages from your owner's messenger" };

describe("ReleaseScheduler", () => {
  function setup() {
    const t = timers();
    const windows: { since: number; until: number }[] = [];
    const errors: unknown[] = [];
    const s = new ReleaseScheduler(t.schedule, t.now, async (w) => void windows.push(w), (e) => errors.push(e));
    s.armed();
    return { t, s, windows, errors };
  }

  test("a turn end flushes after the grace, up to that agent_end; a scheduled continuation's agent_end does not", async () => {
    const { t, s, windows } = setup();
    s.agentEnd({ willContinue: true }, true);
    expect(s.pending).toBe(false);
    t.advance(10);
    s.agentEnd(END, true);
    expect(s.pending).toBe(true);
    t.advance(RELEASE_GRACE_MS - 1);
    expect(windows).toEqual([]);
    t.advance(1);
    await s.idle();
    expect(windows).toEqual([{ since: 1_000_000, until: 1_000_010 }]);
    expect(s.pending).toBe(false);
  });

  test("an agent_end that only waits for background work (awaitingAsyncWork) is a turn end: its review has run", async () => {
    const { t, s, windows } = setup();
    s.agentEnd({ willContinue: true, awaitingAsyncWork: true }, true);
    expect(s.pending).toBe(true);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(windows).toHaveLength(1);
  });

  test("only the consumer-lock holder schedules, and only once armed", async () => {
    const t = timers();
    const windows: unknown[] = [];
    const s = new ReleaseScheduler(t.schedule, t.now, async (w) => void windows.push(w), () => {});
    s.agentEnd(END, true); // not armed yet (no session_start in the lead session)
    expect(s.pending).toBe(false);
    s.armed();
    s.agentEnd(END, false); // a second omp on this home that does not hold the consumer lock
    expect(s.pending).toBe(false);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(windows).toEqual([]);
  });

  test("a new run right after agent_end (the next owner message, a lane prompt) does not cancel the flush", async () => {
    const { t, s, windows } = setup();
    s.agentEnd(END, true);
    // The lead channel delivers a queued message with followUp + triggerTurn: a new run starts within the grace.
    s.agentStart();
    s.message(INBOUND);
    s.message({ role: "user", content: "[REPORT fix-login] ..." });
    s.message({ role: "assistant", content: [] });
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(windows).toHaveLength(1);
  });

  test("an advisor steer within the grace cancels the flush; the continuation's end flushes", async () => {
    const { t, s, windows } = setup();
    s.agentEnd(END, true);
    t.advance(1000);
    s.message(ADVISOR);
    expect(s.pending).toBe(false);
    t.advance(RELEASE_GRACE_MS * 2);
    await s.idle();
    expect(windows).toEqual([]);
    s.agentStart();
    s.agentEnd(END, true);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(windows).toHaveLength(1);
  });

  test("a later agent_end restarts the grace; cancel (session switch, shutdown) drops a pending flush", async () => {
    const { t, s, windows } = setup();
    s.agentEnd(END, true);
    t.advance(2000);
    s.agentEnd(END, true);
    t.advance(2000);
    expect(windows).toEqual([]);
    t.advance(1000);
    await s.idle();
    expect(windows).toHaveLength(1);
    s.agentEnd(END, true);
    s.cancel();
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(windows).toHaveLength(1);
  });

  test("a flush failure goes to onError, never to the caller; a turn end during a flush runs one more after it", async () => {
    const t = timers();
    const errors: unknown[] = [];
    const untils: number[] = [];
    const gate = Promise.withResolvers<void>();
    const s = new ReleaseScheduler(t.schedule, t.now, async (w) => {
      untils.push(w.until);
      if (untils.length === 1) await gate.promise;
      if (untils.length === 2) throw new Error("messengers.json is invalid");
    }, (e) => errors.push(e));
    s.armed();
    s.agentEnd(END, true);
    t.advance(RELEASE_GRACE_MS);
    s.agentEnd(END, true);
    t.advance(RELEASE_GRACE_MS); // fires while the first flush still runs
    expect(untils).toHaveLength(1);
    gate.resolve();
    await s.idle();
    expect(untils).toEqual([1_000_000, 1_000_000 + RELEASE_GRACE_MS]);
    expect(errors.map((e) => (e as Error).message)).toEqual(["messengers.json is invalid"]);
  });

  test("isAdvisorMessage: only omp's advisor custom message", () => {
    expect(isAdvisorMessage(ADVISOR)).toBe(true);
    expect(isAdvisorMessage(INBOUND)).toBe(false);
    expect(isAdvisorMessage({ role: "user", customType: "advisor" })).toBe(false);
    expect(isAdvisorMessage(undefined)).toBe(false);
  });
});

describe("ReleaseScheduler with the real outbox", () => {
  function world() {
    const root = mkdtempSync(join(tmpdir(), "seori-release-"));
    const channel = new Channel(root);
    writeFileSync(channel.consumerLockPath, JSON.stringify({ pid: process.pid, host: hostname(), at: 0 }));
    for (const n of ["1", "2", "3"]) {
      channel.appendInbound({ id: `fake:c1:${n}`, kind: "messenger", source: "fake", chat: "c1", from: "u1", at: 0, text: `q${n}` });
    }
    const sent: string[] = [];
    let n = 0;
    const adapterFor = (c: MessengerConfig): MessengerAdapter => ({
      source: c.source,
      receive: async () => {},
      send: async (_target, text) => {
        sent.push(text);
        return { messageId: `m${++n}` };
      },
      check: async () => "stub",
    });
    const t = timers();
    // The CLI that drafts and the extension that flushes read the same clock.
    const d: MsgDeps = { adapterFor, configs: [{ source: "fake", owner: "u1" }], now: t.now };
    const errors: unknown[] = [];
    const s = new ReleaseScheduler(t.schedule, t.now, async (w) => void (await msgFlush(root, d, w)), (e) => errors.push(e));
    /** One step of time between events, as real calls never share a millisecond with the agent_end before them. */
    const step = () => t.advance(1);
    return { root, d, sent, t, s, errors, step };
  }

  test("a queued inbound delivery starts a run right after agent_end: the turn's draft goes out, the next run's waits for its end", async () => {
    const { root, d, sent, t, s, errors, step } = world();
    s.armed();
    step();
    await msgSend(root, { replyTo: ["fake:c1:1"], text: "answer one" }, d);
    step();
    s.agentEnd(END, true);
    // The extension's own evaluate() delivers fake:c1:2 (followUp + triggerTurn): a run starts and drafts within the grace.
    step();
    s.agentStart();
    s.message(INBOUND);
    await msgSend(root, { replyTo: ["fake:c1:2"], text: "answer two" }, d);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(sent).toEqual(["answer one"]); // answer two was written after that agent_end: not reviewed yet
    step();
    s.agentEnd(END, true);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(sent).toEqual(["answer one", "answer two"]);
    expect(errors).toEqual([]);
  });

  test("a draft the next run replaces within the grace waits for that run's end and goes out with the new text", async () => {
    const { root, d, sent, t, s, errors, step } = world();
    s.armed();
    step();
    const { draft } = await msgSend(root, { replyTo: ["fake:c1:1"], text: "first text" }, d);
    step();
    s.agentEnd(END, true);
    step();
    s.agentStart();
    expect(await msgSend(root, { replyTo: ["fake:c1:1"], text: "second text" }, d)).toMatchObject({ status: "REPLACED", draft });
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(sent).toEqual([]);
    step();
    s.agentEnd(END, true);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(sent).toEqual(["second text"]);
    expect(errors).toEqual([]);
  });

  test("an advisor steer within the grace holds the draft; the lead replaces it and the next agent_end sends the new text", async () => {
    const { root, d, sent, t, s, errors, step } = world();
    s.armed();
    step();
    const { draft } = await msgSend(root, { replyTo: ["fake:c1:1"], text: "PR #12 is merged" }, d);
    step();
    s.agentEnd(END, true);
    t.advance(500);
    s.message(ADVISOR);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(sent).toEqual([]);
    s.agentStart();
    expect(await msgSend(root, { replyTo: ["fake:c1:1"], text: "PR #13 is merged" }, d)).toMatchObject({ status: "REPLACED", draft });
    step();
    s.agentEnd(END, true);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(sent).toEqual(["PR #13 is merged"]);
    expect(errors).toEqual([]);
  });

  test("drafts left before this extension armed (a crashed earlier lead) are not flushed: duty tells the lead", async () => {
    const { root, d, sent, t, s, errors, step } = world();
    await msgSend(root, { replyTo: ["fake:c1:3"], text: "half-done leftover" }, d);
    step();
    s.armed();
    step();
    await msgSend(root, { replyTo: ["fake:c1:1"], text: "this turn's answer" }, d);
    step();
    s.agentEnd(END, true);
    t.advance(RELEASE_GRACE_MS);
    await s.idle();
    expect(sent).toEqual(["this turn's answer"]);
    expect(errors).toEqual([]);
  });
});
