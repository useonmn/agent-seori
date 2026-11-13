// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick, flushInbox, Refusal } from "../src/harness.ts";
import { migrate } from "../src/migrate.ts";
import { moveBack } from "../src/migrate-inbox.ts";
import { readJournal, writeJournal } from "../src/migrate-journal.ts";
import { refText } from "../src/refs.ts";
import { herdrRef } from "./fake.ts";
import { terminal } from "./helpers/hc-rig.ts";
import { migrateWorld, msg, NEW, OLD, snapshot } from "./migrate-setup.ts";

const HELD = { at: 5, state: "ambiguous" as const, detail: "timeout" };
const T9 = { runtime: "hc" as const, id: "t9" };
const laneFile = (root: string): string => readFileSync(join(root, "lanes", "k.json"), "utf8");

describe("seori migrate: one lane herdr -> hc", () => {
  test("happy: MIGRATED, checkpoint asked, handoff brief, queued stay queued, held stay held, typed become held, old closed", async () => {
    const { w, r, d, lines, opts, asks } = migrateWorld();
    d.store.saveInbox(OLD, [msg("one", 1), msg("two", 2), msg("held", 3, HELD), msg("typed", 4, { at: 6, state: "typed", agent: "omp", pgid: 101 })]);
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1"]);
    expect(asks()).toEqual([
      `[MIGRATE k] write a handoff checkpoint now (goal, open todos, last state) to ${join(d.store.root, "briefs", "k.handoff.md")}, then stop`,
    ]);
    expect(w.panes.has("w1:p3")).toBe(false);
    expect(w.panes.has("w1:p1")).toBe(true);
    const lane = d.store.lane("k")!;
    expect(lane.sessionRef).toMatchObject(NEW);
    expect(lane.migratedFrom).toEqual([OLD]);
    expect(lane.migration).toBeUndefined();
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(d.store.queued(NEW).map((m) => [m.text, m.attempt?.state])).toEqual([
      ["one", undefined],
      ["two", undefined],
      ["held", "ambiguous"],
      ["typed", "ambiguous"],
    ]);
    expect(existsSync(d.store.inboxPath(OLD))).toBe(false);
    expect(existsSync(`${d.store.inboxPath(OLD)}.forward`)).toBe(false);
    const kickoff = r.sent().find((s) => s.id === "t1" && s.text.startsWith("/goal "))!.text;
    const handoff = /Read your brief at (\S+) and execute it/.exec(kickoff)![1]!;
    expect(handoff).toBe(join(d.store.root, "briefs", "k.migrate-1000000.md"));
    const text = readFileSync(handoff, "utf8");
    expect(text).toStartWith("Fix the flaky login test.");
    expect(text).toContain("## Handoff");
    expect(text).toContain("screen line 2");
    expect(text).toContain("may already have reached the previous session; see seori inbox list");
    expect(text.match(/## Lane rules/g)).toHaveLength(1);
    expect(r.terminals()["t1"]!.labels).toMatchObject({ "seori.lane": "k", "seori.role": "lane", "seori.group": "seori" });
    // The moved inbox delivers on the new session: queued entries only, the held ones stay.
    expect(await flushInbox(d, NEW)).toBe("delivered");
    expect(r.sent().at(-1)!.text).toContain("one");
    expect(r.sent().at(-1)!.text).not.toContain("held");
    expect(d.store.queued(NEW).map((m) => m.text)).toEqual(["held", "typed"]);
  });

  test("rollback: the replacement never reaches idle or working -> exit 3, replacement closed, lane and inbox untouched", async () => {
    const { w, r, d, lines, opts } = migrateWorld("idle", { agentReportsAs: "done" });
    d.store.saveInbox(OLD, [msg("one", 1)]);
    const before = laneFile(d.store.root);
    expect(await migrate(d, { lane: "k" }, opts())).toBe(3);
    expect(lines).toEqual(["MIGRATE_ROLLBACK k hc:t1 never reached idle or working within 3 min (last: done)"]);
    expect(laneFile(d.store.root)).toBe(before);
    expect(d.store.lane("k")!.migration).toBeUndefined();
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(r.terminals()["t1"]).toBeUndefined();
    expect(w.panes.has("w1:p3")).toBe(true);
    expect(d.store.queued(OLD).map((m) => m.text)).toEqual(["one"]);
  });

  test("rollback after the inbox moved: entries go back to the old inbox, marker gone, hold lifted", async () => {
    const { r, d, lines, opts } = migrateWorld("idle", {}, { t9: terminal({ status: { state: "done", app: "omp" } }) });
    d.store.saveLane({ ...d.store.lane("k")!, migration: true });
    d.store.saveInbox(T9, [msg("one", 1), msg("held", 3, HELD)]);
    writeFileSync(`${d.store.inboxPath(OLD)}.forward`, "hc:t9\n");
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "opened", from: OLD, to: "hc", at: 1, newRef: T9 });
    expect(await migrate(d, { lane: "k" }, opts())).toBe(3);
    expect(lines).toEqual(["MIGRATE_ROLLBACK k hc:t9 never reached idle or working within 3 min (last: done)"]);
    expect(d.store.queued(OLD).map((m) => [m.text, m.attempt?.state])).toEqual([["one", undefined], ["held", "ambiguous"]]);
    expect(existsSync(`${d.store.inboxPath(OLD)}.forward`)).toBe(false);
    expect(d.store.queued(T9)).toEqual([]);
    expect(d.store.lane("k")!.migration).toBeUndefined();
    expect(d.store.lane("k")!.sessionRef).toEqual(OLD);
    expect(r.terminals()["t9"]).toBeUndefined();
    expect(readJournal(d.store.root, "k")).toBeUndefined();
  });

  test.each(["hold", "opened", "switched"] as const)("resumes a cut-short run from a journal in phase %s", async (phase) => {
    const { w, d, lines, opts, asks } = migrateWorld("idle", {}, phase === "hold" ? {} : { t9: terminal() });
    const lane = d.store.lane("k")!;
    d.store.saveLane({ ...lane, migration: true });
    const briefPath = join(d.store.root, "briefs", "k.migrate-1.md");
    writeFileSync(briefPath, "handoff");
    if (phase === "switched") d.store.saveLane({ ...lane, migration: true, sessionRef: T9, migratedFrom: [OLD] });
    writeJournal(d.store.root, { name: "k", kind: "lane", phase, from: OLD, to: "hc", at: 1, briefPath, ...(phase === "hold" ? {} : { newRef: T9 }) });
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    const want = phase === "hold" ? "t1" : "t9";
    expect(lines).toEqual([`MIGRATED k w1:p3 -> hc:${want}`]);
    expect(d.store.lane("k")!.sessionRef.id).toBe(want);
    expect(d.store.lane("k")!.migratedFrom).toEqual([OLD]);
    expect(d.store.lane("k")!.migration).toBeUndefined();
    expect(w.panes.has("w1:p3")).toBe(false);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(asks()).toEqual([]);
  });

  test("a sender appending to the old inbox while the old session closes is merged into the new one, once", async () => {
    const { w, d, opts } = migrateWorld();
    const real = w.exec;
    w.exec = async (cmd, argv) => {
      if (cmd === "herdr" && argv[0] === "pane" && argv[1] === "close") appendFileSync(d.store.inboxPath(OLD), `${JSON.stringify(msg("late", 9))}\n`);
      return real(cmd, argv);
    };
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(d.store.queued(NEW).map((m) => m.text)).toEqual(["late"]);
    expect(existsSync(d.store.inboxPath(OLD))).toBe(false);
  });

  test("--dry-run prints the plan and writes nothing", async () => {
    const { w, r, d, lines, opts } = migrateWorld();
    d.store.saveInbox(OLD, [msg("one", 1)]);
    const before = snapshot(d.store.root);
    expect(await migrate(d, { lane: "k" }, opts({ dryRun: true }))).toBe(0);
    expect(lines).toEqual(["PLAN k w1:p3 -> hc (inbox entries: 1)"]);
    expect(snapshot(d.store.root)).toEqual(before);
    expect(r.calls()).toEqual([]);
    expect(w.calls.filter((c) => c.argv[0] === "agent" || c.argv[1] === "close")).toEqual([]);
  });

  test("SKIP when the lane is already on the target", async () => {
    const { d, lines, opts } = migrateWorld();
    expect(await migrate(d, { lane: "k" }, opts({ to: "herdr" }))).toBe(0);
    expect(lines).toEqual(["SKIP k already on herdr"]);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
  });

  test("DEFERRED blocked: nothing is delivered to a blocked agent, hold lifted, nothing opened", async () => {
    const { w, r, d, lines, opts } = migrateWorld("blocked");
    const before = laneFile(d.store.root);
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["DEFERRED k blocked"]);
    expect(w.panes.get("w1:p3")!.received).toEqual([]);
    expect(laneFile(d.store.root)).toBe(before);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(r.calls()).toEqual([]);
  });

  test("DEFERRED when the lane keeps working past the wait: it already got the checkpoint ask", async () => {
    const { w, r, d, lines, opts, asks } = migrateWorld("working");
    expect(await migrate(d, { lane: "k" }, opts({ waitMinutes: 1 }))).toBe(0);
    expect(lines).toEqual(["DEFERRED k working past 1 min"]);
    expect(w.panes.get("w1:p3")!.received).toHaveLength(1);
    expect(asks()).toHaveLength(1);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(r.calls()).toEqual([]);
  });

  test("an agent still idle right after the ask is waited for: it turns working, writes the checkpoint, the brief has it", async () => {
    const { w, r, d, lines, opts, pane } = migrateWorld("idle");
    const handoff = join(d.store.root, "briefs", "k.handoff.md");
    let afterAsk = 0;
    pane.onPrompt = () => void (afterAsk = 1);
    // Reads after the ask: idle (the prompt is in, omp has not turned yet), working twice (writing), then idle.
    w.getHook.set("w1:p3", () => {
      if (afterAsk === 0) return;
      const n = afterAsk++;
      pane.status = n === 2 || n === 3 ? "working" : "idle";
      if (n === 2) writeFileSync(handoff, "CHECKPOINT-WRITTEN-AFTER-THE-ASK\n");
    });
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1"]);
    const kickoff = r.sent().find((s) => s.id === "t1" && s.text.startsWith("/goal "))!.text;
    expect(readFileSync(/Read your brief at (\S+) and execute it/.exec(kickoff)![1]!, "utf8")).toContain("CHECKPOINT-WRITTEN-AFTER-THE-ASK");
  });

  test("a journal at opened whose lane record already points at the replacement: migratedFrom gets no second entry", async () => {
    const { w, r, d, lines, opts } = migrateWorld("idle", {}, { t9: terminal() });
    d.store.saveLane({ ...d.store.lane("k")!, migration: true, sessionRef: T9, migratedFrom: [OLD] });
    const briefPath = join(d.store.root, "briefs", "k.migrate-1.md");
    writeFileSync(briefPath, "handoff");
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "opened", from: OLD, to: "hc", at: 1, briefPath, newRef: T9 });
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t9"]);
    expect(r.terminals()["t9"]).toBeDefined();
    expect(d.store.lane("k")!.sessionRef).toEqual(T9);
    expect(d.store.lane("k")!.migratedFrom).toEqual([OLD]);
    expect(w.panes.has("w1:p3")).toBe(false);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
  });

  test("a resumed run whose replacement is gone rolls back the record too: lane back on the old session, no migratedFrom", async () => {
    const { d, lines, opts } = migrateWorld();
    d.store.saveLane({ ...d.store.lane("k")!, migration: true, sessionRef: T9, migratedFrom: [OLD] });
    writeFileSync(`${d.store.inboxPath(OLD)}.forward`, "hc:t9\n");
    d.store.saveInbox(T9, [msg("moved", 1)]);
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "opened", from: OLD, to: "hc", at: 1, briefPath: "/b", newRef: T9 });
    expect(await migrate(d, { lane: "k" }, opts())).toBe(3);
    expect(lines[0]).toStartWith("MIGRATE_ROLLBACK k hc:t9 ");
    const lane = d.store.lane("k")!;
    expect(lane.sessionRef).toEqual(OLD);
    expect(lane.migratedFrom).toBeUndefined();
    expect(lane.migration).toBeUndefined();
    expect(d.store.queued(OLD).map((m) => m.text)).toEqual(["moved"]);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
  });

  test("a resumed run from inside the old session is refused even though the record already names the replacement", async () => {
    const { d, opts } = migrateWorld();
    d.store.saveLane({ ...d.store.lane("k")!, migration: true, sessionRef: T9, migratedFrom: [OLD] });
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "switched", from: OLD, to: "hc", at: 1, briefPath: "/b", newRef: T9 });
    await expect(migrate(d, { lane: "k" }, opts({ self: OLD }))).rejects.toThrow("k is the session running this seori migrate");
    expect(readJournal(d.store.root, "k")?.phase).toBe("switched");
  });

  test("the replacement fails to open: MIGRATE_ROLLBACK, exit 3, hold lifted, no journal, inbox and record untouched", async () => {
    const { w, d, lines, opts } = migrateWorld("idle", { sendError: "unavailable" });
    d.store.saveInbox(OLD, [msg("one", 1)]);
    expect(await migrate(d, { lane: "k" }, opts())).toBe(3);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("MIGRATE_ROLLBACK k hc:- did not open: ");
    const lane = d.store.lane("k")!;
    expect(lane.migration).toBeUndefined();
    expect(lane.sessionRef).toEqual(OLD);
    expect(lane.migratedFrom).toBeUndefined();
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(d.store.queued(OLD).map((m) => m.text)).toEqual(["one"]);
    expect(w.panes.has("w1:p3")).toBe(true);
  });

  test("the session running seori migrate is refused: nothing asked, nothing written", async () => {
    const { d, opts, asks } = migrateWorld();
    const before = snapshot(d.store.root);
    await expect(migrate(d, { lane: "k" }, opts({ self: OLD }))).rejects.toThrow("k is the session running this seori migrate");
    expect(asks()).toEqual([]);
    expect(snapshot(d.store.root)).toEqual(before);
  });

  test.each(["idle", "shell"] as const)("a checkpoint an earlier run left is not reused (agent %s, writes none)", async (status) => {
    const { r, d, opts } = migrateWorld(status);
    writeFileSync(join(d.store.root, "briefs", "k.handoff.md"), "STALE-CHECKPOINT-FROM-AN-EARLIER-RUN\n");
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    const kickoff = r.sent().find((s) => s.id === "t1" && s.text.startsWith("/goal "))!.text;
    const text = readFileSync(/Read your brief at (\S+) and execute it/.exec(kickoff)![1]!, "utf8");
    expect(text).toContain("## Handoff");
    expect(text).not.toContain("STALE-CHECKPOINT-FROM-AN-EARLIER-RUN");
  });

  test("moveBack with both <inbox>.merging and <inbox> left: every entry lands in the old inbox once, both files gone", async () => {
    const { d } = migrateWorld();
    const inbox = d.store.inboxPath(T9);
    writeFileSync(`${d.store.inboxPath(OLD)}.forward`, "hc:t9\n");
    d.store.saveInbox(OLD, [msg("already", 1)]);
    const line = (m: ReturnType<typeof msg>): string => `${JSON.stringify(m)}\n`;
    writeFileSync(`${inbox}.merging`, [msg("already", 1), msg("aside", 2), msg("held", 3, HELD)].map(line).join(""));
    writeFileSync(inbox, [msg("aside", 2), msg("fresh", 4)].map(line).join(""));
    await moveBack(d, OLD, T9);
    expect(d.store.queued(OLD).map((m) => [m.text, m.attempt?.state])).toEqual([
      ["already", undefined],
      ["aside", undefined],
      ["held", "ambiguous"],
      ["fresh", undefined],
    ]);
    expect(existsSync(inbox)).toBe(false);
    expect(existsSync(`${inbox}.merging`)).toBe(false);
    expect(existsSync(`${d.store.inboxPath(OLD)}.forward`)).toBe(false);
  });

  test("a migration already running for the name is refused", async () => {
    const { d, opts } = migrateWorld();
    mkdirSync(join(d.store.root, "migrate"), { recursive: true });
    writeFileSync(join(d.store.root, "migrate", "k.lock"), JSON.stringify({ pid: process.pid, host: hostname(), at: 1 }));
    await expect(migrate(d, { lane: "k" }, opts())).rejects.toThrow(/another seori migrate of k is running/);
    expect(d.store.lane("k")!.sessionRef).toEqual(OLD);
  });

  test("a journal toward another runtime is refused, not overwritten", async () => {
    const { d, opts } = migrateWorld();
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "hold", from: OLD, to: "herdr", at: 1 });
    await expect(migrate(d, { lane: "k" }, opts())).rejects.toThrow(/in progress toward herdr/);
    expect(readJournal(d.store.root, "k")!.to).toBe("herdr");
  });

  test("the duty loop leaves a migrating lane's record alone and holds its inbox", async () => {
    const { w, d } = migrateWorld();
    w.clock += 60 * 60_000;
    d.store.saveLane({ ...d.store.lane("k")!, migration: true });
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "hold", from: OLD, to: "hc", at: 1 });
    d.store.saveInbox(OLD, [msg("wait", 1)]);
    const before = laneFile(d.store.root);
    await dutyTick(d);
    expect(laneFile(d.store.root)).toBe(before);
    expect(w.panes.get("w1:p3")!.received).toEqual([]);
    expect(d.store.queued(OLD).map((m) => m.text)).toEqual(["wait"]);
  });

  test("a message sent to the old session while its inbox is forwarded lands in the new inbox", () => {
    const { d } = migrateWorld();
    writeFileSync(`${d.store.inboxPath(OLD)}.forward`, "hc:t1\n");
    d.store.enqueue(OLD, msg("after", 1));
    expect(d.store.queued(NEW).map((m) => m.text)).toEqual(["after"]);
    expect(d.store.queued(OLD)).toEqual([]);
  });
});

describe("seori migrate: roles, --all and --resume", () => {
  test("--role lead: omp started like seori up with the handoff brief, roles.json switched, its inbox moved", async () => {
    const { w, r, d, lines, opts } = migrateWorld();
    d.store.saveInbox(herdrRef("w1:p1"), [{ at: 1, from: "k", text: "[REPORT k] hi" }]);
    expect(await migrate(d, { role: "lead" }, opts(), "/x/lead-channel.ts")).toBe(0);
    expect(lines).toEqual(["MIGRATED lead w1:p1 -> hc:t1"]);
    expect(refText(d.store.roles().lead!)).toBe("hc:t1");
    expect(w.panes.has("w1:p1")).toBe(false);
    const start = r.sent().find((s) => s.id === "t1")!.text;
    expect(start).toStartWith("'omp' '-e' '/x/lead-channel.ts' '--append-system-prompt' ");
    const brief = start.split(" ").at(-1)!.replaceAll("'", "");
    expect(readFileSync(brief, "utf8")).toContain("## Handoff");
    expect(d.store.queued(NEW).map((m) => m.text)).toEqual(["[REPORT k] hi"]);
  });

  test("--role duty: duty's replacement, roles.json switched", async () => {
    const { w, r, d, lines, opts } = migrateWorld();
    w.addPane("w1:p2", "idle");
    d.store.setRole("duty", herdrRef("w1:p2"));
    expect(await migrate(d, { role: "duty" }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED duty w1:p2 -> hc:t1"]);
    expect(refText(d.store.roles().duty!)).toBe("hc:t1");
    expect(r.sent().find((s) => s.id === "t1")!.text).toStartWith("'omp' '--append-system-prompt' ");
  });

  test("--role lead resumed after the switch, replacement gone: roles.json points back at the old lead", async () => {
    const { d, lines, opts } = migrateWorld();
    d.store.setRole("lead", T9);
    writeJournal(d.store.root, { name: "lead", kind: "role", phase: "opened", from: herdrRef("w1:p1"), to: "hc", at: 1, briefPath: "/b", newRef: T9 });
    expect(await migrate(d, { role: "lead" }, opts())).toBe(3);
    expect(lines[0]).toStartWith("MIGRATE_ROLLBACK lead hc:t9 ");
    expect(refText(d.store.roles().lead!)).toBe("w1:p1");
  });

  test("--all run from the lead: the lead is skipped, the lane still migrates", async () => {
    const { d, lines, opts } = migrateWorld();
    expect(await migrate(d, { all: true }, opts({ self: herdrRef("w1:p1") }))).toBe(0);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1", "SKIP lead is the session running seori migrate"]);
    expect(refText(d.store.roles().lead!)).toBe("w1:p1");
  });

  test("--all: every open lane first, then lead and duty", async () => {
    const { w, d, lines, opts } = migrateWorld();
    w.addPane("w1:p2", "idle");
    d.store.setRole("duty", herdrRef("w1:p2"));
    expect(await migrate(d, { all: true }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1", "MIGRATED lead w1:p1 -> hc:t2", "MIGRATED duty w1:p2 -> hc:t3"]);
  });

  test("--role accepts only lead and duty: the loops are not runtime sessions", async () => {
    const { d } = migrateWorld();
    await expect(main(["migrate", "--role", "duty-loop"], d)).rejects.toThrow(/--role must be lead or duty/);
    await expect(main(["migrate"], d)).rejects.toThrow(Refusal);
  });

  test("--resume is refused when no omp session path is on record", async () => {
    const { r, d, opts } = migrateWorld();
    await expect(migrate(d, { lane: "k" }, opts({ resume: true }))).rejects.toThrow(/no omp session path on record/);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(r.calls()).toEqual([]);
  });

  test("--resume is refused on a working source", async () => {
    const { w, r, d, opts, pane } = migrateWorld("working");
    pane.session = "/s/k.jsonl";
    await expect(migrate(d, { lane: "k" }, opts({ resume: true }))).rejects.toThrow(/its session is working, not idle or done/);
    expect(w.panes.get("w1:p3")!.received).toEqual([]);
    expect(r.calls()).toEqual([]);
  });

  test("--resume on an idle source starts omp on its session, no checkpoint ask, no kickoff", async () => {
    const { r, d, lines, opts, pane, asks } = migrateWorld();
    pane.session = "/s/k.jsonl";
    expect(await migrate(d, { lane: "k" }, opts({ resume: true }))).toBe(0);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1"]);
    const sent = r.sent().filter((s) => s.id === "t1").map((s) => s.text);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("'omp' '--resume' '/s/k.jsonl'");
    expect(asks()).toEqual([]);
  });
});
