// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { World } from "./fake.ts";

// A lanes/<key>.json and a roles.json exactly as a binary from before runtimes existed wrote them.
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

function oldHome() {
  const w = new World();
  const d = w.deps();
  const laneFile = join(d.store.root, "lanes", "old-lane.json");
  writeFileSync(laneFile, JSON.stringify(OLD_LANE));
  writeFileSync(join(d.store.root, "lanes", "no-tab.json"), JSON.stringify({ ...OLD_LANE, key: "no-tab", tabId: "", createdAt: 2 }));
  writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "w1:p1", duty: "w1:p2" }));
  return { w, d, laneFile };
}

async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("records written before runtimes existed", () => {
  test("lane() and lanes() read an old lane as the herdr pane it names; bare roles are herdr refs", () => {
    const { d } = oldHome();
    const want: SessionRef = { runtime: "herdr", id: "w1:p3", container: "w1:t3" };
    const bare: SessionRef = { runtime: "herdr", id: "w1:p3" };
    expect(d.store.lane("old-lane")?.sessionRef).toEqual(want);
    expect(d.store.lanes().map((l) => l.sessionRef)).toEqual([want, bare]);
    expect(d.store.roles()).toEqual({
      lead: { runtime: "herdr", id: "w1:p1" },
      duty: { runtime: "herdr", id: "w1:p2" },
    });
    expect(d.store.laneBySession({ runtime: "herdr", id: "w1:p3" })?.key).toBe("old-lane");
  });

  test("run twice, the result is identical; reading writes nothing, saving keeps paneId/tabId and saves the same bytes again", () => {
    const { d, laneFile } = oldHome();
    const before = readFileSync(laneFile, "utf8");
    const first = { lane: d.store.lane("old-lane"), lanes: d.store.lanes(), roles: d.store.roles() };
    const second = { lane: d.store.lane("old-lane"), lanes: d.store.lanes(), roles: d.store.roles() };
    expect(second).toEqual(first);
    expect(readFileSync(laneFile, "utf8")).toBe(before);
    d.store.saveLane(first.lane!);
    const saved = readFileSync(laneFile, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ paneId: "w1:p3", tabId: "w1:t3", sessionRef: first.lane!.sessionRef });
    d.store.saveLane(d.store.lane("old-lane")!);
    expect(readFileSync(laneFile, "utf8")).toBe(saved);
    expect(d.store.lane("old-lane")).toEqual(first.lane!);
  });

  test("roles.json keeps a herdr role bare and an hc role prefixed, so an older binary still reads it", () => {
    const { d } = oldHome();
    d.store.setRole("duty", { runtime: "hc", id: "t7" });
    expect(JSON.parse(readFileSync(join(d.store.root, "roles.json"), "utf8"))).toEqual({ lead: "w1:p1", duty: "hc:t7" });
    expect(d.store.roles().duty).toEqual({ runtime: "hc", id: "t7" });
  });

  test("a herdr inbox keeps its old file name; an hc inbox is prefixed, and both are listed back as refs", () => {
    const { d } = oldHome();
    d.store.enqueue({ runtime: "herdr", id: "w1:p3" }, { at: 1, from: "cli", text: "a" });
    d.store.enqueue({ runtime: "hc", id: "t7" }, { at: 1, from: "cli", text: "b" });
    expect(existsSync(join(d.store.root, "inbox", "w1_p3.jsonl"))).toBe(true);
    expect(existsSync(join(d.store.root, "inbox", "hc--t7.jsonl"))).toBe(true);
    expect(d.store.inboxPanes()).toEqual(expect.arrayContaining([{ runtime: "herdr", id: "w1:p3" }, { runtime: "hc", id: "t7" }]));
  });

  test("seori status shows the old lane and roles exactly as before", async () => {
    const { d } = oldHome();
    const out = (await captureLog(() => main(["status"], d))).split("\n");
    expect(out[0]).toStartWith("lead=w1:p1 duty=w1:p2 ");
    expect(out.find((l) => l.startsWith("old-lane"))).toMatch(/^old-lane\s+working\s+w1:p3\s/);
  });
});
