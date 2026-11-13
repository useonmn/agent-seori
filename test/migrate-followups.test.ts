// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Deps, done, Refusal } from "../src/harness.ts";
import { migrate } from "../src/migrate.ts";
import { moveBack, moveInbox } from "../src/migrate-inbox.ts";
import { readJournal, writeJournal } from "../src/migrate-journal.ts";
import { herdrRef } from "./fake.ts";
import { terminal } from "./helpers/hc-rig.ts";
import { migrateWorld, msg, NEW, OLD } from "./migrate-setup.ts";

const T9 = { runtime: "hc" as const, id: "t9" };

/** Deps whose first clock read (the one `seori migrate` takes its lock with) runs `then` first. */
const atLock = (d: Deps, then: () => void): Deps => {
  let fired = false;
  return {
    ...d,
    now: () => {
      if (!fired) {
        fired = true;
        then();
      }
      return d.now();
    },
  };
};

describe("seori migrate follow-ups", () => {
  test("a checkpoint written before the ask's delivery returns ends the wait at once", async () => {
    const { w, r, d, lines, opts, pane } = migrateWorld("idle");
    // A wall clock, so the checkpoint's mtime and the run's clock compare as they do outside tests.
    w.clock = Date.now();
    const start = w.clock;
    const handoff = join(d.store.root, "briefs", "k.handoff.md");
    // The agent writes its checkpoint and stops while the delivery is still returning; it is never seen working.
    pane.onPrompt = () => {
      writeFileSync(handoff, "CHECKPOINT-BEFORE-DELIVER-RETURNED\n");
      w.clock += 5_000;
    };
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1"]);
    expect(w.clock - start).toBeLessThan(60_000);
    const kickoff = r.sent().find((s) => s.id === "t1" && s.text.startsWith("/goal "))!.text;
    expect(readFileSync(/Read your brief at (\S+) and execute it/.exec(kickoff)![1]!, "utf8")).toContain("CHECKPOINT-BEFORE-DELIVER-RETURNED");
  });

  test("a run resumed from a journal whose hold was never set sets it again before asking", async () => {
    const { d, lines, opts, pane } = migrateWorld("idle");
    writeJournal(d.store.root, { name: "k", kind: "lane", phase: "hold", from: OLD, to: "hc", at: 1 });
    expect(d.store.lane("k")!.migration).toBeUndefined();
    let heldAtAsk: boolean | undefined;
    pane.onPrompt = () => void (heldAtAsk = d.store.lane("k")!.migration);
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(heldAtAsk).toBe(true);
    expect(lines).toEqual(["MIGRATED k w1:p3 -> hc:t1"]);
    expect(d.store.lane("k")!.migration).toBeUndefined();
  });

  test("a lane another run moved to the target while this one waited for the lock is skipped, not migrated again", async () => {
    const { r, d, lines, opts, asks } = migrateWorld("idle", {}, { t9: terminal() });
    const dd = atLock(d, () => d.store.saveLane({ ...d.store.lane("k")!, sessionRef: T9, migratedFrom: [OLD] }));
    expect(await migrate(dd, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["SKIP k already on hc"]);
    expect(asks()).toEqual([]);
    expect(r.sent()).toEqual([]);
    expect(d.store.lane("k")!.sessionRef).toEqual(T9);
    expect(d.store.lane("k")!.migratedFrom).toEqual([OLD]);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
  });

  test("a role another run moved to the target while this one waited for the lock is skipped", async () => {
    const { r, d, lines, opts, asks } = migrateWorld("idle", {}, { t9: terminal() });
    const dd = atLock(d, () => d.store.setRole("lead", T9));
    expect(await migrate(dd, { role: "lead" }, opts())).toBe(0);
    expect(lines).toEqual(["SKIP lead already on hc"]);
    expect(asks()).toEqual([]);
    expect(r.sent()).toEqual([]);
    expect(d.store.roles().lead).toEqual(T9);
  });

  test("a journal another run left toward another runtime while this one waited for the lock is refused", async () => {
    const { d, opts, asks } = migrateWorld();
    const dd = atLock(d, () => writeJournal(d.store.root, { name: "k", kind: "lane", phase: "hold", from: OLD, to: "herdr", at: 1 }));
    await expect(migrate(dd, { lane: "k" }, opts())).rejects.toThrow(/in progress toward herdr/);
    expect(asks()).toEqual([]);
    expect(readJournal(d.store.root, "k")!.to).toBe("herdr");
  });

  test("a delivery refused as not ready (not blocked) is DEFERRED as not ready, not as working past the wait", async () => {
    const { w, d, lines, opts } = migrateWorld("idle", {}, { t5: terminal({ status: { state: "error" } }) });
    const before = w.clock;
    d.store.saveLane({ ...d.store.lane("k")!, sessionRef: { runtime: "hc", id: "t5" } });
    expect(await migrate(d, { lane: "k" }, opts({ to: "herdr" }))).toBe(0);
    expect(lines).toEqual(["DEFERRED k not ready (unknown)"]);
    expect(w.clock).toBe(before);
    expect(d.store.lane("k")!.migration).toBeUndefined();
    expect(readJournal(d.store.root, "k")).toBeUndefined();
  });

  test("moving the inbox waits for a sender's append in flight, so its entry reaches the new inbox", async () => {
    const { w, d } = migrateWorld();
    d.store.saveInbox(OLD, [msg("one", 1)]);
    const old = d.store.inboxPath(OLD);
    // A sender that resolved the old inbox (no forward marker yet) and has not appended yet holds its append lock.
    const sender = d.store.lockAppend(OLD, w.clock)!;
    let waits = 0;
    const dd: Deps = {
      ...d,
      sleep: async (ms) => {
        if (waits++ === 0) {
          expect(existsSync(`${old}.forward`)).toBe(false);
          appendFileSync(old, `${JSON.stringify(msg("in flight", 2))}\n`);
          sender();
        }
        w.clock += ms;
      },
    };
    await moveInbox(dd, OLD, NEW);
    expect(waits).toBe(1);
    expect(d.store.queued(NEW).map((m) => m.text)).toEqual(["one", "in flight"]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(`${old}.merging`)).toBe(false);
  });

  test("a rollback waits for a sender that followed the forward marker, so its entry goes back to the old inbox", async () => {
    const { w, d } = migrateWorld();
    writeFileSync(`${d.store.inboxPath(OLD)}.forward`, "hc:t1\n");
    d.store.saveInbox(NEW, [msg("one", 1)]);
    // A sender to the old session that read the marker (so it appends to the new inbox) holds the old append lock.
    const sender = d.store.lockAppend(OLD, w.clock)!;
    let waits = 0;
    const dd: Deps = {
      ...d,
      sleep: async (ms) => {
        if (waits++ === 0) {
          appendFileSync(d.store.inboxPath(NEW), `${JSON.stringify(msg("in flight", 2))}\n`);
          sender();
        }
        w.clock += ms;
      },
    };
    await moveBack(dd, OLD, NEW);
    expect(waits).toBe(1);
    expect(d.store.queued(OLD).map((m) => m.text)).toEqual(["one", "in flight"]);
    expect(existsSync(d.store.inboxPath(NEW))).toBe(false);
  });

  test("a lane paused while it was asked for its checkpoint is DEFERRED, and its replacement never gets a kickoff", async () => {
    const { r, d, lines, opts, pane } = migrateWorld("idle");
    // The owner's pause lands while the [MIGRATE k] ask is out (a pause begun before the hold was set).
    pane.onPrompt = () => d.store.saveLane({ ...d.store.lane("k")!, status: "paused", pausedFrom: "working" });
    expect(await migrate(d, { lane: "k" }, opts())).toBe(0);
    expect(lines).toEqual(["DEFERRED k paused"]);
    expect(r.sent().filter((s) => s.text.startsWith("/goal "))).toEqual([]);
    expect(Object.keys(r.terminals())).toEqual([]);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(d.store.lane("k")!.migration).toBeUndefined();
    expect(d.store.lane("k")!.status).toBe("paused");
    expect(d.store.lane("k")!.sessionRef).toEqual(OLD);
  });

  test("a throw while the checkpoint is captured lifts the hold and drops the journal: nothing had moved yet", async () => {
    const { d, opts } = migrateWorld("idle");
    rmSync(d.store.briefPath("k"));
    await expect(migrate(d, { lane: "k" }, opts())).rejects.toThrow(/ENOENT|no such file/);
    expect(readJournal(d.store.root, "k")).toBeUndefined();
    expect(d.store.lane("k")!.migration).toBeUndefined();
    expect(d.store.lane("k")!.sessionRef).toEqual(OLD);
  });

  test("a rollback whose replacement could not be closed says so on the MIGRATE_ROLLBACK line", async () => {
    const { r, d, lines, opts } = migrateWorld("idle", { agentReportsAs: "done" });
    r.rt.close = async () => {
      throw new Error("hc core unavailable");
    };
    expect(await migrate(d, { lane: "k" }, opts())).toBe(3);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("MIGRATE_ROLLBACK k hc:t1 never reached idle or working");
    expect(lines[0]).toContain("replacement hc:t1 NOT closed: hc core unavailable");
    expect(r.terminals()["t1"]).toBeDefined();
  });

  test("a failed close of the old session after the switch keeps the journal and names how to finish", async () => {
    const { w, d, opts } = migrateWorld("idle");
    const real = w.exec;
    w.exec = async (cmd, argv) => {
      if (cmd === "herdr" && argv[0] === "pane" && argv[1] === "close") throw new Error("herdr socket gone");
      return real(cmd, argv);
    };
    const err = (await migrate(d, { lane: "k" }, opts()).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(join(d.store.root, "migrate", "k.json"));
    expect(err.message).toContain("seori migrate --to hc");
    expect(err.message).toContain("herdr socket gone");
    expect(readJournal(d.store.root, "k")!.phase).toBe("switched");
    expect(d.store.lane("k")!.sessionRef).toMatchObject(NEW);
  });

  test("done refuses a lane being migrated", async () => {
    const { d, lines } = migrateWorld("idle");
    d.store.saveLane({ ...d.store.lane("k")!, status: "ready", migration: true });
    expect(await done(d, "k").catch((e: unknown) => e)).toBeInstanceOf(Refusal);
    expect(d.store.lane("k")!.status).toBe("ready");
    expect(lines).toEqual([]);
  });

  test("enqueue appends under the append lock: refused while another process holds it, free again after", () => {
    const { w, d } = migrateWorld();
    const held = d.store.lockAppend(OLD, w.clock)!;
    expect(() => d.store.enqueue(OLD, msg("blocked", 1))).toThrow(/stays locked/);
    expect(d.store.queued(OLD)).toEqual([]);
    held();
    d.store.enqueue(OLD, msg("after", 2));
    expect(d.store.queued(OLD).map((m) => m.text)).toEqual(["after"]);
    expect(existsSync(`${d.store.inboxPath(OLD)}.append.lock`)).toBe(false);
    expect(d.store.queued(herdrRef("w1:p1"))).toEqual([]);
  });
});
