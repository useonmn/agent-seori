import { describe, expect, test } from "bun:test";
import type { IdState } from "../src/channel.ts";
import { BACKOFF_MS, type Decision, DeliverySchedule, GRACE_MS, renderDelivery } from "../src/lead-delivery.ts";

const T0 = 1_000_000;

const state = (id: string, s: Partial<Omit<IdState, "row">> = {}): IdState => ({
  row: { id, kind: "messenger", source: "fake", chat: "c1", from: "u1", at: T0, text: `text of ${id}` },
  deliveries: 0,
  entered: false,
  replied: false,
  closed: false,
  uncertain: false,
  gaveUp: false,
  alerted: [],
  ...s,
});

const delivered = (id: string, deliveries: number, at: number, s: Partial<Omit<IdState, "row">> = {}): IdState =>
  state(id, { deliveries, lastDeliveredAt: at, entered: true, ...s });

const ids = (d: Decision) => d.deliver.map((x) => `${x.row.id}:${x.header}:${x.attempt}`);

describe("DeliverySchedule", () => {
  test("new ids are delivered together, followUp when idle and aside when busy", () => {
    const s = new DeliverySchedule();
    const states = [state("a"), state("b")];
    const idle = s.decide(states, T0, true, { kind: "scan" });
    expect(ids(idle)).toEqual(["a:new:1", "b:new:1"]);
    expect(idle.mode).toBe("followUp");
    expect(s.decide(states, T0, false, { kind: "timer" }).mode).toBe("aside");
  });

  test("final ids are never delivered again, whatever the trigger", () => {
    const s = new DeliverySchedule();
    const states = [
      delivered("r", 1, T0, { replied: true }),
      delivered("c", 1, T0, { closed: true }),
      delivered("u", 1, T0, { uncertain: true }),
      delivered("g", 3, T0, { gaveUp: true }),
      state("fresh-but-closed", { closed: true }),
    ];
    for (const kind of ["scan", "timer", "session_start", "session_switch"] as const) {
      const d = s.decide(states, T0 + 60 * 60_000, true, { kind });
      expect(d.deliver).toEqual([]);
      expect(d.giveUp).toEqual([]);
    }
  });

  test("session start and switch carry every open delivered id over, busy or idle", () => {
    const s = new DeliverySchedule();
    const states = [delivered("old", 1, T0), state("new")];
    expect(ids(s.decide(states, T0 + 1, false, { kind: "session_start" }))).toEqual(["old:carried:2", "new:new:1"]);
    expect(ids(s.decide(states, T0 + 1, true, { kind: "session_switch" }))).toEqual(["old:carried:2", "new:new:1"]);
  });

  test("a delivered id is not redelivered by a plain scan", () => {
    const s = new DeliverySchedule();
    s.noteDelivered(["a"], T0);
    s.noteEntered(["a"]);
    expect(s.decide([delivered("a", 1, T0)], T0 + BACKOFF_MS[0]! * 10, true, { kind: "scan" }).deliver).toEqual([]);
  });

  test("timer redelivers after 2 min, then 5 min, and only to an idle lead", () => {
    const s = new DeliverySchedule();
    const one = [delivered("a", 1, T0)];
    expect(s.decide(one, T0 + 2 * 60_000 - 1, true, { kind: "timer" }).deliver).toEqual([]);
    expect(s.decide(one, T0 + 2 * 60_000, false, { kind: "timer" }).deliver).toEqual([]);
    expect(ids(s.decide(one, T0 + 2 * 60_000, true, { kind: "timer" }))).toEqual(["a:retry:2"]);
    const two = [delivered("a", 2, T0)];
    expect(s.decide(two, T0 + 5 * 60_000 - 1, true, { kind: "timer" }).deliver).toEqual([]);
    expect(ids(s.decide(two, T0 + 5 * 60_000, true, { kind: "timer" }))).toEqual(["a:retry:3"]);
  });

  test("the cap gives up only once the last delivery had its chance", () => {
    const s = new DeliverySchedule();
    const three = [delivered("a", 3, T0)];
    expect(s.decide(three, T0 + 5 * 60_000 - 1, true, { kind: "timer" })).toMatchObject({ deliver: [], giveUp: [] });
    expect(s.decide(three, T0 + 5 * 60_000, true, { kind: "timer" })).toMatchObject({ deliver: [], giveUp: [{ id: "a", attempts: 3 }] });
    // a restart with the cap already reached gives up instead of carrying over
    expect(new DeliverySchedule().decide(three, T0 + 1, true, { kind: "session_start" })).toMatchObject({ deliver: [], giveUp: [{ id: "a", attempts: 3 }] });
  });

  test("a delivery that never entered is redelivered after the grace once the lead is idle", () => {
    const s = new DeliverySchedule();
    s.noteDelivered(["a"], T0);
    const st = [delivered("a", 1, T0, { entered: false })];
    expect(s.decide(st, T0 + GRACE_MS - 1, true, { kind: "timer" }).deliver).toEqual([]);
    expect(s.decide(st, T0 + GRACE_MS, false, { kind: "timer" }).deliver).toEqual([]);
    expect(ids(s.decide(st, T0 + GRACE_MS, true, { kind: "scan" }))).toEqual(["a:retry:2"]);
    s.noteEntered(["a"]);
    expect(s.decide(st, T0 + GRACE_MS, true, { kind: "timer" }).deliver).toEqual([]);
  });

  test("a turn that ended without stop redelivers its ids after the grace; a stop does not", () => {
    const s = new DeliverySchedule();
    s.noteDelivered(["a"], T0);
    s.noteEntered(["a"]);
    const st = [delivered("a", 1, T0)];
    expect(s.decide(st, T0 + 1000, true, { kind: "agent_end", stopReason: "aborted" }).deliver).toEqual([]);
    expect(s.decide(st, T0 + 1000 + GRACE_MS - 1, true, { kind: "timer" }).deliver).toEqual([]);
    expect(ids(s.decide(st, T0 + 1000 + GRACE_MS, true, { kind: "timer" }))).toEqual(["a:retry:2"]);
    // once redelivered, the old abort no longer counts
    s.noteDelivered(["a"], T0 + 1000 + GRACE_MS);
    s.noteEntered(["a"]);
    const st2 = [delivered("a", 2, T0 + 1000 + GRACE_MS)];
    expect(s.decide(st2, T0 + 1000 + 3 * GRACE_MS, true, { kind: "timer" }).deliver).toEqual([]);

    const ok = new DeliverySchedule();
    ok.noteDelivered(["b"], T0);
    ok.noteEntered(["b"]);
    ok.decide([delivered("b", 1, T0)], T0 + 1000, true, { kind: "agent_end", stopReason: "stop" });
    expect(ok.decide([delivered("b", 1, T0)], T0 + 1000 + GRACE_MS, true, { kind: "timer" }).deliver).toEqual([]);
  });

  test("an abort before the delivery does not count against it", () => {
    const s = new DeliverySchedule();
    s.decide([], T0, true, { kind: "agent_end", stopReason: "aborted" });
    s.noteDelivered(["a"], T0 + 1);
    s.noteEntered(["a"]);
    expect(s.decide([delivered("a", 1, T0 + 1)], T0 + 1 + GRACE_MS, true, { kind: "timer" }).deliver).toEqual([]);
  });

  test("ids delivered by another process or session only follow the backoff", () => {
    const s = new DeliverySchedule();
    const st = [delivered("a", 1, T0, { entered: false })];
    expect(s.decide(st, T0 + GRACE_MS, true, { kind: "timer" }).deliver).toEqual([]);
    s.noteDelivered(["b"], T0);
    s.decide([], T0, true, { kind: "session_switch" }); // forgets this session's deliveries
    expect(s.decide([delivered("b", 1, T0, { entered: false })], T0 + GRACE_MS, true, { kind: "timer" }).deliver).toEqual([]);
  });
});

describe("renderDelivery", () => {
  test("tells the lead how to answer, lists each message under its header, and ends with the instruction", () => {
    const s = new DeliverySchedule();
    const d = s.decide([delivered("fake:c1:1", 1, T0), state("fake:c1:2")], T0 + 1, true, { kind: "session_start" });
    const text = renderDelivery(d.deliver, "bun /x/cli.ts");
    expect(text).toContain("bun /x/cli.ts msg send --reply-to <id> --text '...'");
    expect(text).toContain("bun /x/cli.ts msg close <id> --why '...'");
    expect(text).toContain("[fake:c1:2] fake from u1: text of fake:c1:2");
    expect(text).toContain("reply only if you have not already");
    expect(text.indexOf("New messenger messages:")).toBeLessThan(text.indexOf("[fake:c1:2]"));
    expect(text.indexOf("[fake:c1:2]")).toBeLessThan(text.indexOf("Carried over"));
    expect(text.indexOf("Carried over")).toBeLessThan(text.indexOf("[fake:c1:1]"));
    expect(text.endsWith("Answer these, then continue your current task.")).toBe(true);
  });
});
