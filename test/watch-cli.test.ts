import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { main } from "../src/cli.ts";
import { Refusal, type Deps } from "../src/harness.ts";
import type { Lane } from "../src/store.ts";
import { parseDuration } from "../src/watch/cli.ts";
import { DEFAULT_TIMEOUT_MS, PERSISTENT_TTL_MS, WatchRefusal, WatchStore } from "../src/watch/store.ts";
import { World } from "./fake.ts";

// `seori watch ...` through main(): what an agent types and the lines it reads back. The engine is not running here;
// these tests only cover what the CLI writes to the watch store and prints.

async function run(argv: string[], d: Deps): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { code: await main(argv, d), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

const savedLane = process.env["SEORI_LANE"];
afterEach(() => {
  if (savedLane === undefined) delete process.env["SEORI_LANE"];
  else process.env["SEORI_LANE"] = savedLane;
});

function setup() {
  delete process.env["SEORI_LANE"];
  const w = new World();
  const d = w.deps();
  const lane = (key: string, status: Lane["status"] = "working") =>
    d.store.saveLane({ key, paneId: "w1:p9", tabId: "w1:t9", brief: "b", cwd: "/", status, createdAt: w.clock, lastActivityAt: w.clock, nudges: 0, log: [] });
  return { w, d, lane, watches: () => new WatchStore(d.store.root) };
}

const idOf = (out: string): string => out.split(" ")[1]!;

describe("seori watch add", () => {
  test("arms a command watch for the lead by default and prints its id, owner and expiry", async () => {
    const { w, d, watches } = setup();
    const r = await run(["watch", "add", "--command", "bun dev", "--filter", "ERROR|ready", "--cwd", "/tmp", "--name", "dev"], d);
    expect(r.code).toBe(0);
    const id = idOf(r.out);
    expect(r.out).toBe(`WATCH ${id} dev for lead until ${new Date(w.clock + DEFAULT_TIMEOUT_MS).toISOString()}`);
    expect(watches().get(id)).toMatchObject({
      name: "dev", owner: { kind: "lead" }, persistent: false, status: "active",
      source: { kind: "command", command: "bun dev", cwd: "/tmp", filter: "ERROR|ready" },
    });
  });

  test("the owner defaults to the lane in SEORI_LANE; --for overrides it", async () => {
    const { d, lane, watches } = setup();
    lane("fix-login");
    lane("other-lane");
    process.env["SEORI_LANE"] = "fix-login";
    const mine = await run(["watch", "add", "--checks", "acme/app#12"], d);
    expect(mine.out).toMatch(/^WATCH \S+ checks for fix-login until /);
    expect(watches().get(idOf(mine.out))).toMatchObject({ owner: { kind: "lane", key: "fix-login" }, source: { kind: "checks", repo: "acme/app", number: 12 } });
    const lead = await run(["watch", "add", "--file", "notes.txt", "--for", "lead"], d);
    expect(watches().get(idOf(lead.out))).toMatchObject({ owner: { kind: "lead" }, source: { kind: "file", path: resolve("notes.txt") } });
    const other = await run(["watch", "add", "--pane", "w1:p3", "--status", "idle", "--for", "other-lane"], d);
    expect(watches().get(idOf(other.out))).toMatchObject({ owner: { kind: "lane", key: "other-lane" }, source: { kind: "pane", pane: "w1:p3", status: "idle" } });
  });

  test("--timeout and --persistent set the expiry", async () => {
    const { w, d } = setup();
    expect((await run(["watch", "add", "--file", "/tmp/x", "--timeout", "30m"], d)).out).toEndWith(`until ${new Date(w.clock + 30 * 60_000).toISOString()}`);
    // --persistent takes no value: the flag after it is still read as a flag.
    const p = await run(["watch", "add", "--persistent", "--file", "/tmp/y", "--name", "y"], d);
    expect(p.out).toMatch(new RegExp(`^WATCH \\S+ y for lead until ${new Date(w.clock + PERSISTENT_TTL_MS).toISOString()}$`));
  });

  test("refuses bad input: no or two sources, bad --checks, --pane without --status, a closed lane, a bad duration", async () => {
    const { d, lane } = setup();
    lane("gone-lane", "done");
    await expect(main(["watch", "add", "--name", "x"], d)).rejects.toThrow(/exactly one of/);
    await expect(main(["watch", "add", "--file", "a", "--command", "b"], d)).rejects.toThrow(/exactly one of/);
    await expect(main(["watch", "add", "--checks", "acme/app"], d)).rejects.toThrow(/OWNER\/REPO#N/);
    await expect(main(["watch", "add", "--pane", "w1:p1"], d)).rejects.toThrow(/--status/);
    await expect(main(["watch", "add", "--pane", "w1:p1", "--status", "done"], d)).rejects.toThrow(/--status/);
    await expect(main(["watch", "add", "--file", "a", "--for", "gone-lane"], d)).rejects.toThrow(/is done/);
    await expect(main(["watch", "add", "--file", "a", "--for", "nope"], d)).rejects.toThrow(/no lane nope/);
    await expect(main(["watch", "add", "--file", "a", "--timeout", "2 hours"], d)).rejects.toThrow(Refusal);
  });

  test("store limits refuse with WatchRefusal: timeout over 24h, a 6th persistent watch, a bad regex", async () => {
    const { d } = setup();
    await expect(main(["watch", "add", "--file", "a", "--timeout", "25h"], d)).rejects.toThrow(WatchRefusal);
    await expect(main(["watch", "add", "--command", "x", "--filter", "("], d)).rejects.toThrow(/invalid --filter/);
    for (let i = 0; i < 5; i++) expect((await run(["watch", "add", "--persistent", "--file", `/tmp/${i}`], d)).code).toBe(0);
    await expect(main(["watch", "add", "--persistent", "--file", "/tmp/6"], d)).rejects.toThrow(/at most 5 persistent/);
  });
});

describe("seori watch list, stop, rearm, log", () => {
  test("list shows live watches with kind, target, age, expiry, wakes and muted events; --all adds ended ones", async () => {
    const { w, d } = setup();
    expect(await run(["watch", "list"], d)).toEqual({ code: 0, out: "EMPTY" });
    const a = idOf((await run(["watch", "add", "--checks", "acme/app#7", "--name", "ci"], d)).out);
    w.clock += 60_000;
    const b = idOf((await run(["watch", "add", "--file", "/tmp/f", "--name", "f"], d)).out);
    w.clock += 14 * 60_000;
    expect((await run(["watch", "list"], d)).out.split("\n")).toEqual([
      `${a}  ci  lead  active  checks: acme/app#7  age 15m  expires in 1h45m  wakes 0/6 last hour  muted events 0`,
      `${b}  f  lead  active  file: /tmp/f  age 14m  expires in 1h46m  wakes 0/6 last hour  muted events 0`,
    ]);
    expect(await run(["watch", "stop", "ci"], d)).toEqual({ code: 0, out: `STOPPED ${a} ci` });
    expect((await run(["watch", "list"], d)).out.split("\n").map((l) => l.split("  ")[0])).toEqual([b]);
    const all = (await run(["watch", "list", "--all"], d)).out.split("\n");
    expect(all[0]).toBe(`${a}  ci  lead  stopped  checks: acme/app#7  age 15m  ended: stopped by seori watch stop  wakes 0/6 last hour  muted events 0`);
    await expect(main(["watch", "stop", a], d)).rejects.toThrow(/already stopped/);
    await expect(main(["watch", "stop", "nothing"], d)).rejects.toThrow(/no watch nothing/);
  });

  test("rearm unmutes a muted watch, resets its wakes and reports the missed events; an active watch is refused", async () => {
    const { w, d, watches } = setup();
    const id = idOf((await run(["watch", "add", "--command", "tail -f log", "--name", "log"], d)).out);
    await expect(main(["watch", "rearm", id], d)).rejects.toThrow(/is active, not muted/);
    const store = watches();
    const old = w.clock - 2 * 3_600_000;
    store.save({ ...store.get(id)!, status: "muted", wakes: [old, old, old, old, old, w.clock], mutedEvents: 4 });
    expect((await run(["watch", "list"], d)).out).toContain("  muted  command: tail -f log  ");
    expect((await run(["watch", "list"], d)).out).toEndWith("wakes 1/6 last hour  muted events 4");
    expect(await run(["watch", "rearm", "log"], d)).toEqual({ code: 0, out: `REARMED ${id} log: 4 event(s) missed while muted; wake budget reset` });
    expect(store.get(id)).toMatchObject({ status: "active", wakes: [], mutedEvents: 0 });
  });

  test("log prints the last events, -n limits them, EMPTY when there are none", async () => {
    const { w, d, watches } = setup();
    const id = idOf((await run(["watch", "add", "--file", "/tmp/f", "--name", "f"], d)).out);
    expect(await run(["watch", "log", "f"], d)).toEqual({ code: 0, out: "EMPTY" });
    const store = watches();
    for (const n of [1, 2, 3]) store.appendEvent(id, { at: w.clock + n * 1000, ev: "delivered", text: `change ${n}` });
    const iso = (n: number) => new Date(w.clock + n * 1000).toISOString();
    expect((await run(["watch", "log", id, "-n", "2"], d)).out.split("\n")).toEqual([
      `${iso(2)} {"ev":"delivered","text":"change 2"}`,
      `${iso(3)} {"ev":"delivered","text":"change 3"}`,
    ]);
    expect((await run(["watch", "log", "f"], d)).out.split("\n")).toHaveLength(3);
    await expect(main(["watch", "log", "f", "-n", "0"], d)).rejects.toThrow(/-n/);
  });

  test("parseDuration reads s, m, h, d", () => {
    expect([parseDuration("90s"), parseDuration("30m"), parseDuration("2h"), parseDuration("1d")]).toEqual([90_000, 1_800_000, 7_200_000, 86_400_000]);
  });
});
