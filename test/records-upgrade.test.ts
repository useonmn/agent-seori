// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
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

  test("seori status refuses a herdr home with one line, exit 2 at the CLI", async () => {
    const d = home();
    writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "w1:p1" }));
    await expect(main(["status"], d)).rejects.toThrow(HerdrRecord);
  });
});
