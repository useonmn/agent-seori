// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyPass, main } from "../src/cli.ts";
import { dutyTick, send } from "../src/harness.ts";
import { HerdrRecord } from "../src/refs.ts";
import { World } from "./fake.ts";

// Records a seori that ran on herdr wrote: a lane with only paneId/tabId (or a herdr sessionRef), bare role values and
// an inbox file named after the pane. seori runs on hc only and refuses each with one line naming the file.
const OLD_LANE = {
  key: "old-lane",
  paneId: "w1:p3",
  tabId: "w1:t3",
  brief: "/b.md",
  cwd: "/w",
  status: "working",
  createdAt: 1,
  lastActivityAt: 1,
  nudges: 0,
  log: [],
};

const home = () => new World().deps();

describe("closed herdr history next to live hc work", () => {
  test("a done or lost herdr lane is skipped, an empty herdr inbox too, and duty still delivers to the hc lane", async () => {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("t1", "idle");
    d.store.setRole("lead", { runtime: "hc", id: "t1" });
    writeFileSync(join(d.store.root, "lanes", "old-done.json"), JSON.stringify({ ...OLD_LANE, key: "old-done", status: "done" }));
    writeFileSync(join(d.store.root, "lanes", "old-lost.json"), JSON.stringify({ ...OLD_LANE, key: "old-lost", status: "lost", sessionRef: { runtime: "herdr", id: "w1:p4" } }));
    writeFileSync(join(d.store.root, "inbox", "w1_p3.jsonl"), "");
    lead.status = "working";
    expect(await send(d, "lead", "for the lead", "cli")).toBe("QUEUED");
    expect(d.store.lanes()).toEqual([]);
    expect(d.store.lane("old-done")).toBeUndefined();
    lead.status = "idle";
    expect(await dutyTick(d)).toContainEqual({ pane: "hc:t1", action: "flushed" });
    expect(lead.received).toEqual(["for the lead"]);
  });
});

describe("records a herdr seori wrote", () => {
  test("a lane without sessionRef, or with a herdr one, is refused naming its file and pane", () => {
    const d = home();
    const file = join(d.store.root, "lanes", "old-lane.json");
    writeFileSync(file, JSON.stringify(OLD_LANE));
    expect(() => d.store.lane("old-lane")).toThrow(HerdrRecord);
    expect(() => d.store.lanes()).toThrow(`${file} names the herdr pane w1:p3; seori runs on hc only`);
    writeFileSync(file, JSON.stringify({ ...OLD_LANE, sessionRef: { runtime: "herdr", id: "w1:p3" } }));
    expect(() => d.store.lane("old-lane")).toThrow(HerdrRecord);
  });

  test("a bare role value is refused; an hc one reads back", () => {
    const d = home();
    const file = join(d.store.root, "roles.json");
    writeFileSync(file, JSON.stringify({ lead: "w1:p1" }));
    expect(() => d.store.roles()).toThrow(`${file} names the herdr pane w1:p1`);
    writeFileSync(file, JSON.stringify({ lead: "hc:t1" }));
    expect(d.store.roles()).toEqual({ lead: { runtime: "hc", id: "t1" } });
  });

  test("an inbox file without the hc-- prefix is refused; an hc one is listed back", () => {
    const d = home();
    d.store.enqueue({ runtime: "hc", id: "t7" }, { at: 1, from: "cli", text: "b" });
    expect(d.store.inboxPanes()).toEqual([{ runtime: "hc", id: "t7" }]);
    writeFileSync(join(d.store.root, "inbox", "w1_p3.jsonl"), `${JSON.stringify({ at: 1, from: "cli", text: "a" })}\n`);
    expect(() => d.store.inboxPanes()).toThrow("names the herdr pane w1:p3");
  });

  test("a duty loop pass skips an open herdr lane and a herdr inbox with messages, names each once, and still delivers to hc; other errors still throw", async () => {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("t1", "idle");
    d.store.setRole("lead", { runtime: "hc", id: "t1" });
    const file = join(d.store.root, "lanes", "old-lane.json");
    writeFileSync(file, JSON.stringify(OLD_LANE));
    const inbox = join(d.store.root, "inbox", "w1_p3.jsonl");
    writeFileSync(inbox, `${JSON.stringify({ at: 1, from: "cli", text: "old" })}\n`);
    d.store.enqueue({ runtime: "hc", id: "t1" }, { at: 2, from: "cli", text: "for the lead" });
    const out: string[] = [];
    const err: string[] = [];
    await dutyPass(d, (l) => void out.push(l), (l) => void err.push(l));
    expect(err).toEqual([
      `DUTY ERROR ${inbox} names the herdr pane w1:p3; seori runs on hc only: close that pane and read its 1 queued message(s), then remove ${inbox} (they are dropped with it)`,
      `DUTY ERROR ${file} names the herdr pane w1:p3; seori runs on hc only: close that pane and remove ${file}`,
    ]);
    expect(out).toContain("DUTY hc:t1 flushed");
    expect(lead.received).toEqual(["for the lead"]);
    expect(() => d.store.lanes()).toThrow(HerdrRecord);
    const broken = { ...d, store: Object.assign(Object.create(d.store), { inboxPanes: () => { throw new Error("disk gone"); } }) };
    await expect(dutyPass(broken, () => {}, () => {})).rejects.toThrow("disk gone");
  });

  test("a herdr inbox that still holds messages names how many are dropped with it", () => {
    const d = home();
    const file = join(d.store.root, "inbox", "w1_p3.jsonl");
    writeFileSync(file, `${JSON.stringify({ at: 1, from: "cli", text: "a" })}\n${JSON.stringify({ at: 2, from: "cli", text: "b" })}\n`);
    expect(() => d.store.inboxPanes()).toThrow(`read its 2 queued message(s), then remove ${file} (they are dropped with it)`);
  });

  test("seori status refuses a herdr home with one line, exit 2 at the CLI", async () => {
    const d = home();
    writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "w1:p1" }));
    await expect(main(["status"], d)).rejects.toThrow(HerdrRecord);
  });
});
