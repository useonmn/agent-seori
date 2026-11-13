import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { ALERT_TEXT, DRAFTS_ALERT_MS, dutyTick } from "../src/harness.ts";
import { Outbox } from "../src/outbox.ts";
import { SendUncertain } from "../src/messenger/adapter.ts";
import { World, herdrRef } from "./fake.ts";

const FAKE = { source: "fake", owner: "u1" };
const MIN = 60_000;

function setup(opts: { messengers?: boolean } = {}) {
  const w = new World();
  const d = w.deps();
  const root = d.store.root;
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", herdrRef("w1:p1"));
  if (opts.messengers !== false) w.messengers(root, [FAKE]);
  w.heartbeat(root, 0);
  w.consumerLock(root, "alive");
  const channel = new Channel(root);
  channel.appendInbound({ id: "fake:c1:m1", kind: "messenger", source: "fake", chat: "c1", thread: "t1", from: "u1", at: w.clock, text: "hi" });
  /** Moves the clock; the daemon stays healthy unless `beat` is false. */
  const advance = (ms: number, beat = true) => {
    w.clock += ms;
    if (beat) w.heartbeat(root, 0);
  };
  const alerted = () => channel.ledger().filter((e) => e.ev === "alerted").map((e) => (e.ev === "alerted" ? e.why : ""));
  return { w, d, root, lead, channel, advance, alerted };
}

describe("duty channel alerts", () => {
  test("nothing happens without messengers.json", async () => {
    const { w, d, root, lead, channel, advance } = setup({ messengers: false });
    w.consumerLock(root, "none");
    w.heartbeat(root, undefined);
    channel.appendLedger({ id: "fake:c1:m1", ev: "gave-up", at: w.clock, attempts: 3 });
    advance(5 * MIN, false);
    expect(await dutyTick(d)).toEqual([]);
    expect(w.notified).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(existsSync(join(root, "lead", "duty-alerts.json"))).toBe(false);
  });

  test("daemon down is told to the lead once per outage, and a fresh heartbeat clears it", async () => {
    const { w, d, root, lead, advance } = setup();
    advance(100_000, false);
    expect((await dutyTick(d)).map((e) => e.action)).toEqual(["daemon-down"]);
    expect(lead.received).toEqual(["[MESSENGER] seori daemon is down (last heartbeat 100 s ago); messenger messages are not received until it runs again"]);
    advance(MIN, false);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received).toHaveLength(1);

    advance(MIN);
    expect(await dutyTick(d)).toEqual([{ action: "daemon-up", detail: "down 120 s" }]);
    expect(await dutyTick(d)).toEqual([]);

    w.heartbeat(root, undefined);
    expect((await dutyTick(d)).map((e) => e.action)).toEqual(["daemon-down"]);
    expect(lead.received.at(-1)).toContain("(no heartbeat)");
    expect(lead.received).toHaveLength(2);
  });

  test("a messenger failing to receive for 3 min is told once, and the health file going away ends it", async () => {
    const { w, d, root, lead, advance } = setup();
    const health = join(root, "messenger", "fake", "health.json");
    mkdirSync(join(root, "messenger", "fake"), { recursive: true });
    writeFileSync(health, JSON.stringify({ failingSince: w.clock, lastAt: w.clock, error: "401 Unauthorized", failures: 4 }));
    advance(2 * MIN);
    expect(await dutyTick(d)).toEqual([]); // a short blip is not told
    advance(MIN);
    expect((await dutyTick(d)).map((e) => e.action)).toEqual(["messenger-failing"]);
    expect(lead.received).toEqual(["[MESSENGER] fake has not been able to receive for 3 min (4 failures; last error: 401 Unauthorized); messages sent there are not reaching you until this is fixed"]);
    advance(MIN);
    expect(await dutyTick(d)).toEqual([]);
    rmSync(health);
    expect(await dutyTick(d)).toEqual([{ action: "messenger-recovered", detail: "fake" }]);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received).toHaveLength(1);
  });

  test("a health file left while the daemon is down is not told as a messenger failure (daemon-down covers it)", async () => {
    const { w, d, root, lead, advance } = setup();
    mkdirSync(join(root, "messenger", "fake"), { recursive: true });
    writeFileSync(join(root, "messenger", "fake", "health.json"), JSON.stringify({ failingSince: w.clock, lastAt: w.clock, error: "boom", failures: 1 }));
    advance(5 * MIN, false);
    expect((await dutyTick(d)).map((e) => e.action)).toEqual(["daemon-down"]);
    expect(lead.received).toHaveLength(1);
  });

  test("a heartbeat younger than 90 s is not an outage", async () => {
    const { w, d, root, lead } = setup();
    w.heartbeat(root, 89_000);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received).toEqual([]);
  });

  test("lead offline: after 2 min with no live consumer the owner is told once, as a reply in the message's thread", async () => {
    const { w, d, root, advance, alerted } = setup();
    w.consumerLock(root, "dead");
    advance(MIN);
    expect(await dutyTick(d)).toEqual([]);
    advance(2 * MIN);
    expect(await dutyTick(d)).toEqual([{ action: "alerted", detail: "fake:c1:m1 lead-offline" }]);
    expect(w.notified).toEqual([{ config: FAKE, target: { chat: "c1", thread: "t1", replyTo: "m1" }, text: ALERT_TEXT["lead-offline"] }]);
    expect(alerted()).toEqual(["lead-offline"]);
    advance(MIN);
    w.consumerLock(root, "none");
    expect(await dutyTick(d)).toEqual([]);
    expect(w.notified).toHaveLength(1);
  });

  test("lead offline is not raised while a live consumer holds the lock, or for a replied id", async () => {
    const { w, d, root, channel, advance } = setup();
    advance(5 * MIN);
    expect(await dutyTick(d)).toEqual([]);
    channel.appendLedger({ id: "fake:c1:m1", ev: "replied", at: w.clock, messageId: "r1" });
    w.consumerLock(root, "none");
    expect(await dutyTick(d)).toEqual([]);
    expect(w.notified).toEqual([]);
  });

  test("lead blocked: an id delivered over 2 min ago while the lead pane is blocked is told once", async () => {
    const { w, d, lead, channel, advance, alerted } = setup();
    channel.appendLedger({ id: "fake:c1:m1", ev: "delivered", at: w.clock, attempt: 1, mode: "followUp" });
    advance(3 * MIN);
    expect(await dutyTick(d)).toEqual([]);
    lead.status = "blocked";
    expect(await dutyTick(d)).toEqual([{ action: "alerted", detail: "fake:c1:m1 lead-blocked" }]);
    expect(w.notified.map((n) => n.text)).toEqual([ALERT_TEXT["lead-blocked"]]);
    expect(await dutyTick(d)).toEqual([]);
    expect(alerted()).toEqual(["lead-blocked"]);
  });

  test("gave up: the owner is told once", async () => {
    const { w, d, channel, alerted } = setup();
    channel.appendLedger({ id: "fake:c1:m1", ev: "gave-up", at: w.clock, attempts: 3 });
    expect(await dutyTick(d)).toEqual([{ action: "alerted", detail: "fake:c1:m1 gave-up" }]);
    expect(await dutyTick(d)).toEqual([]);
    expect(w.notified.map((n) => n.text)).toEqual([ALERT_TEXT["gave-up"]]);
    expect(alerted()).toEqual(["gave-up"]);
  });

  test("a failed notify is an event, records nothing, and is retried next tick", async () => {
    const { w, d, channel, alerted } = setup();
    channel.appendLedger({ id: "fake:c1:m1", ev: "gave-up", at: w.clock, attempts: 3 });
    w.notifyFails.push(new Error("401 unauthorized"));
    expect(await dutyTick(d)).toEqual([{ action: "alert-failed", detail: "fake:c1:m1 gave-up: 401 unauthorized" }]);
    expect(alerted()).toEqual([]);
    expect(await dutyTick(d)).toEqual([{ action: "alerted", detail: "fake:c1:m1 gave-up" }]);
    expect(w.notified).toHaveLength(1);
  });

  test("an uncertain notify is recorded and never resent", async () => {
    const { w, d, channel, alerted } = setup();
    channel.appendLedger({ id: "fake:c1:m1", ev: "gave-up", at: w.clock, attempts: 3 });
    w.notifyFails.push(new SendUncertain("timed out"));
    expect(await dutyTick(d)).toEqual([
      { action: "alert-uncertain", detail: "fake:c1:m1 gave-up: timed out" },
      { action: "alerted", detail: "fake:c1:m1 gave-up" },
    ]);
    expect(await dutyTick(d)).toEqual([]);
    expect(alerted()).toEqual(["gave-up"]);
  });

  test("an id from an unconfigured source is an event and stays unrecorded", async () => {
    const { w, d, channel, alerted } = setup();
    channel.appendInbound({ id: "slack:c9:m9", kind: "messenger", source: "slack", chat: "c9", from: "u1", at: w.clock, text: "x" });
    channel.appendLedger({ id: "slack:c9:m9", ev: "gave-up", at: w.clock, attempts: 3 });
    expect(await dutyTick(d)).toEqual([{ action: "alert-failed", detail: "slack:c9:m9 gave-up: no messenger configured for source slack" }]);
    expect(alerted()).toEqual([]);
  });

  test("send-uncertain and gave-up ids are final: no lead-offline or lead-blocked promise is sent for them", async () => {
    const { w, d, root, lead, channel, advance, alerted } = setup();
    channel.appendInbound({ id: "fake:c1:m2", kind: "messenger", source: "fake", chat: "c1", from: "u1", at: w.clock, text: "two" });
    channel.appendLedger({ id: "fake:c1:m1", ev: "delivered", at: w.clock, attempt: 1, mode: "followUp" });
    channel.appendLedger({ id: "fake:c1:m1", ev: "send-uncertain", at: w.clock, detail: "timed out" });
    channel.appendLedger({ id: "fake:c1:m2", ev: "delivered", at: w.clock, attempt: 3, mode: "followUp" });
    channel.appendLedger({ id: "fake:c1:m2", ev: "gave-up", at: w.clock, attempts: 3 });
    w.consumerLock(root, "dead");
    lead.status = "blocked";
    advance(5 * MIN);
    expect(await dutyTick(d)).toEqual([{ action: "alerted", detail: "fake:c1:m2 gave-up" }]);
    expect(await dutyTick(d)).toEqual([]);
    expect(w.notified.map((n) => n.text)).toEqual([ALERT_TEXT["gave-up"]]);
    expect(alerted()).toEqual(["gave-up"]);
  });

  test("watch rows get no messenger alert: not offline, not blocked, not gave-up", async () => {
    const { w, d, root, lead, channel, advance, alerted } = setup();
    channel.appendLedger({ id: "fake:c1:m1", ev: "replied", at: w.clock, messageId: "r1" });
    channel.appendInbound({ id: "watch:w1:1", kind: "watch", watchId: "w1", name: "ci", at: w.clock, text: "[watch ci w1] done" });
    channel.appendInbound({ id: "watch:w1:2", kind: "watch", watchId: "w1", name: "ci", at: w.clock, text: "[watch ci w1] again" });
    channel.appendLedger({ id: "watch:w1:1", ev: "delivered", at: w.clock, attempt: 1, mode: "followUp" });
    channel.appendLedger({ id: "watch:w1:2", ev: "gave-up", at: w.clock, attempts: 3 });
    w.consumerLock(root, "dead");
    lead.status = "blocked";
    advance(5 * MIN);
    expect(await dutyTick(d)).toEqual([]);
    expect(w.notified).toEqual([]);
    expect(alerted()).toEqual([]);
  });

  test("a broken messengers.json is told to the lead once per breakage, and the daemon outage is still told", async () => {
    const { w, d, root, lead, channel, advance } = setup();
    channel.appendLedger({ id: "fake:c1:m1", ev: "gave-up", at: w.clock, attempts: 3 });
    writeFileSync(join(root, "messengers.json"), "{ not json");
    advance(100_000, false); // the daemon cannot start on that file, so its heartbeat goes stale
    expect((await dutyTick(d)).map((e) => e.action)).toEqual(["config-broken", "daemon-down"]);
    expect(lead.received).toHaveLength(2);
    expect(lead.received[0]).toStartWith("[MESSENGER] messengers.json is invalid (");
    expect(lead.received[1]).toContain("seori daemon is down");
    advance(MIN, false);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received).toHaveLength(2);
    expect(w.notified).toEqual([]); // no messenger to reply through while the file is broken

    w.messengers(root, [FAKE]);
    advance(MIN);
    expect((await dutyTick(d)).map((e) => e.action)).toEqual(["config-fixed", "daemon-up", "alerted"]);
    expect(w.notified.map((n) => n.text)).toEqual([ALERT_TEXT["gave-up"]]);

    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: "fake" }));
    expect((await dutyTick(d)).map((e) => e.action)).toEqual(["config-broken"]);
    expect(lead.received.at(-1)).toContain('"messengers" must be an array');
  });

  test("a live lead's drafted id is answered: no lead-blocked or gave-up alert for it", async () => {
    const { w, d, root, lead, channel, advance, alerted } = setup();
    channel.appendLedger({ id: "fake:c1:m1", ev: "delivered", at: w.clock, attempt: 3, mode: "followUp" });
    channel.appendLedger({ id: "fake:c1:m1", ev: "gave-up", at: w.clock, attempts: 3 });
    new Outbox(root).append({ ev: "drafted", draft: "d1", at: w.clock, target: { kind: "reply", ids: ["fake:c1:m1"] }, text: "on it" });
    lead.status = "blocked";
    advance(3 * MIN);
    expect(await dutyTick(d)).toEqual([]);
    expect(w.notified).toEqual([]);
    expect(alerted()).toEqual([]);
  });

  test("a drafted id with no live consumer still gets the lead-offline alert: nobody is left to send the draft", async () => {
    const { w, d, root, channel, advance, alerted } = setup();
    new Outbox(root).append({ ev: "drafted", draft: "d1", at: w.clock, target: { kind: "reply", ids: ["fake:c1:m1"] }, text: "on it" });
    expect(channel.states()[0]!.drafted).toBe(true);
    w.consumerLock(root, "dead");
    advance(3 * MIN);
    expect(await dutyTick(d)).toEqual([{ action: "alerted", detail: "fake:c1:m1 lead-offline" }]);
    expect(w.notified.map((n) => n.text)).toEqual([ALERT_TEXT["lead-offline"]]);
    expect(alerted()).toEqual(["lead-offline"]);
  });
});

describe("duty reply drafts", () => {
  test("open drafts older than 5 min are told to the lead once per draft; released and dropped ones never", async () => {
    const { w, d, root, lead, advance } = setup();
    const outbox = new Outbox(root);
    outbox.append({ ev: "drafted", draft: "aaaa1111", at: w.clock, target: { kind: "reply", ids: ["fake:c1:m1"] }, text: "one" });
    outbox.append({ ev: "drafted", draft: "bbbb2222", at: w.clock, target: { kind: "notice", source: "fake", chat: "c1" }, text: "two" });
    outbox.append({ ev: "drafted", draft: "cccc3333", at: w.clock, target: { kind: "notice", source: "fake", chat: "c1" }, text: "sent" });
    outbox.append({ ev: "released", draft: "cccc3333", at: w.clock });
    advance(DRAFTS_ALERT_MS);
    expect(await dutyTick(d)).toEqual([]); // not older than 5 min yet
    advance(1000);
    expect(await dutyTick(d)).toEqual([{ action: "drafts-alerted", detail: "aaaa1111, bbbb2222" }]);
    expect(lead.received).toEqual([
      "[DRAFTS] 2 reply draft(s) not sent: aaaa1111, bbbb2222; send them with seori msg flush or drop them with seori msg drop <draft> --why '...'",
    ]);
    advance(MIN);
    expect(await dutyTick(d)).toEqual([]);

    outbox.append({ ev: "dropped", draft: "aaaa1111", at: w.clock, why: "x" });
    outbox.append({ ev: "drafted", draft: "dddd4444", at: w.clock, target: { kind: "reply", ids: ["fake:c1:m1"] }, text: "three" });
    advance(DRAFTS_ALERT_MS + 1000);
    expect(await dutyTick(d)).toEqual([{ action: "drafts-alerted", detail: "dddd4444" }]);
    expect(lead.received.at(-1)).toStartWith("[DRAFTS] 1 reply draft(s) not sent: dddd4444;");
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received).toHaveLength(2);
  });
});
