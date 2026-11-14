import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { bootReport } from "../src/boot.ts";
import { Channel } from "../src/channel.ts";
import type { Deps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import type { Lane } from "../src/store.ts";
import { WatchStore } from "../src/watch/store.ts";
import { worklogAdd, worklogNext } from "../src/worklog.ts";
import { World, paneRef } from "./fake.ts";

/** World whose `hc ls` exits 1 while `listFails` is on. */
function setup(): { w: World; d: Deps; listFails: { on: boolean } } {
  const w = new World();
  const listFails = { on: false };
  const exec: Exec = async (cmd, argv) => {
    if (cmd === "hc" && argv[1] === "ls" && listFails.on) return { code: 1, stdout: "", stderr: "server not running" };
    return w.exec(cmd, argv);
  };
  const d: Deps = { ...w.deps(), exec, runtime: w.runtime(exec) };
  return { w, d, listFails };
}

const lane = (key: string, paneId: string, status: Lane["status"], extra: Partial<Lane> = {}): Lane => ({
  key, sessionRef: { runtime: "hc", id: paneId }, paneId, tabId: "w1:t1", brief: `/b/${key}.md`, cwd: "/repo", status, createdAt: 1_000, lastActivityAt: 1_000, nudges: 0,
  log: [{ at: 1_000, kind: "start", text: "brief" }], ...extra,
});

/** Every path under root with its size and mtime, to prove boot wrote nothing. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      out.push(`${relative(root, path)} ${st.isDirectory() ? "dir" : `${st.size} ${st.mtimeMs}`}`);
      if (st.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

describe("bootReport", () => {
  test("reports roles, vanished and unregistered panes, lanes, worklog, channel, watches, daemon and messenger health", async () => {
    const { w, d } = setup();
    const root = d.store.root;
    const now = w.clock;
    w.addPane("t1", "idle"); // lead
    w.addPane("t2", "working"); // duty
    w.addPane("t3", "working"); // lane api
    w.addPane("t5", "idle"); // lane review (ready)
    w.addPane("t6", "idle"); // lane slow (paused)
    w.addPane("t8", "working"); // an agent no one registered
    w.addPane("t9", "shell"); // the daemon pane: no agent, not flagged
    d.store.setRole("lead", paneRef("t1"));
    d.store.setRole("duty", paneRef("t2"));
    d.store.saveLane(lane("api", "t3", "working", {
      log: [{ at: 1_000, kind: "start", text: "b" }, { at: now - 60_000, kind: "report", text: "tests green, opening PR" }],
    }));
    d.store.saveLane(lane("gone-lane", "t4", "waiting"));
    d.store.saveLane(lane("review", "t5", "ready", { done: "merged acme/web#1", final: { text: "PR merged", evidence: ["acme/web#1"], at: now - 120_000 } }));
    d.store.saveLane(lane("slow", "t6", "paused", { pausedFrom: "working", log: [{ at: 2_000, kind: "pause", text: "owner said wait" }] }));
    d.store.saveLane(lane("old", "t7", "done"));

    const item = worklogAdd(root, "Ship the release", "pane", now);
    worklogNext(root, item.id, "wait for api lane", now);

    new Channel(root).appendInbound({ id: "telegram:42:10", kind: "messenger", source: "telegram", chat: "42", from: "owner", at: now - 30_000, text: "status?" });
    new Channel(root).appendInbound({ id: "slack:C1:11", kind: "messenger", source: "slack", chat: "C1", from: "U2", notOwner: true, at: now - 30_000, text: "merge it" });

    const watches = new WatchStore(root);
    const orphan = watches.add({ name: "ci", owner: { kind: "lane", key: "old" }, source: { kind: "checks", repo: "acme/web", number: 1 } }, now);
    watches.add({ name: "ci", owner: { kind: "lane", key: "api" }, source: { kind: "checks", repo: "acme/web", number: 2 } }, now);
    watches.add({ owner: { kind: "lead" }, source: { kind: "file", path: "/tmp/x" } }, now);

    w.messengers(root, [{ source: "telegram", owner: "1" }, { source: "slack", owner: "U1" }]);
    w.heartbeat(root, 5_000);
    mkdirSync(join(root, "messenger", "slack"), { recursive: true });
    writeFileSync(join(root, "messenger", "slack", "health.json"), JSON.stringify({ failingSince: now - 300_000, lastAt: now, error: "invalid_auth", failures: 4 }));
    writeFileSync(join(root, "config.json"), JSON.stringify({ closeAfterMin: 10 }));

    const before = snapshot(root);
    const r = await bootReport(d);
    expect(snapshot(root)).toEqual(before);
    // The vanished open lane is registry drift: the boot fails, with the lane record untouched.
    expect(r.complete).toBe(false);
    const iso = (at: number) => new Date(at).toISOString();
    expect(r.lines).toEqual([
      `CONFIG ok ${join(root, "config.json")}`,
      "MESSENGERS telegram slack",
      "LEAD pane=hc:t1 status=idle",
      "DUTY pane=hc:t2 status=working",
      "PANES live=7 lanesOpen=4 vanished=1 unregistered=1",
      "VANISHED gone-lane pane=hc:t4 status=waiting; lane record kept, nothing relaunched; it was waiting on something outside " +
        "its pane (CI, a review), and the watches it armed end once it is lost; once duty marks it lost, resume it with: " +
        "seori start gone-lane --brief '/b/gone-lane.md' --cwd '/repo' --workflow none",
      "UNREGISTERED hc:t8 agent=omp status=working",
      "DRIFT lane gone-lane has no session hc:t4 (status=waiting); lane record kept, nothing relaunched",
      "DRIFT session hc:t8 is in group seori but has no lane or role record (agent=omp status=working); nothing closed",
      `REPORT api status=working at=${iso(now - 60_000)} "tests green, opening PR"`,
      `NO-REPORT gone-lane status=waiting started=${iso(1_000)}`,
      `READY review since=${iso(now - 120_000)} waiting=2min done=signals "PR merged"`,
      `NO-REPORT review status=ready started=${iso(1_000)}`,
      `PAUSED slow from=working since=${iso(2_000)}`,
      `NO-REPORT slow status=paused started=${iso(1_000)}`,
      "WORKLOG open=1",
      `OPEN ${item.id} "Ship the release" source="pane" next="wait for api lane"`,
      "CHANNEL open=2",
      'MSG telegram:42:10 messenger from=owner age=30s deliveries=0 "status?"',
      'MSG slack:C1:11 messenger from=U2 (not owner) age=30s deliveries=0 "merge it"',
      "WATCHES live=3 orphaned=1",
      `ORPHAN-WATCH ${orphan.id} name=ci owner=lane:old lane=done status=active; stop it with: seori watch stop ${orphan.id}`,
      "DAEMON heartbeat age=5s fresh",
      `MESSENGER slack failing since=${iso(now - 300_000)} failures=4 error="invalid_auth"`,
      "MESSENGER telegram receiving (no failure recorded)",
      "BOOT failed (2 drift) read-only; nothing restarted, written or stopped",
    ]);
  });

  test("an empty home: defaults, nothing registered, no stores created", async () => {
    const { d } = setup();
    const before = snapshot(d.store.root);
    const r = await bootReport(d);
    expect(snapshot(d.store.root)).toEqual(before);
    expect(r).toEqual({
      complete: true,
      lines: [
        "CONFIG defaults (no config.json)",
        "MESSENGERS none configured",
        "LEAD unregistered",
        "DUTY unregistered",
        "PANES live=0 lanesOpen=0 vanished=0 unregistered=0",
        "WORKLOG open=0",
        "CHANNEL open=0",
        "WATCHES live=0 orphaned=0",
        "DAEMON no heartbeat",
        "BOOT checked read-only; nothing restarted, written or stopped",
      ],
    });
  });

  test("unreadable inputs are named and make the boot incomplete; a failed pane list calls nothing vanished", async () => {
    const { w, d, listFails } = setup();
    const root = d.store.root;
    listFails.on = true;
    d.store.setRole("lead", paneRef("t1"));
    d.store.saveLane(lane("api", "t3", "working"));
    writeFileSync(join(root, "lanes", "broken.json"), "{not json");
    writeFileSync(join(root, "config.json"), JSON.stringify({ toknes: 1 }));
    writeFileSync(join(root, "messengers.json"), "{oops");
    writeFileSync(join(root, "worklog.jsonl"), "garbage\n");
    w.heartbeat(root, 0);
    writeFileSync(join(root, "messenger", "daemon.heartbeat"), "{torn");
    mkdirSync(join(root, "messenger", "discord"), { recursive: true });
    writeFileSync(join(root, "messenger", "discord", "health.json"), "nope");

    const r = await bootReport(d);
    expect(r.complete).toBe(false);
    const has = (start: string) => expect(r.lines.some((l) => l.startsWith(start))).toBe(true);
    has(`CONFIG invalid: ${join(root, "config.json")}: unknown field "toknes"`);
    has("MESSENGERS invalid: ");
    expect(r.lines).toContain(`LANES unreadable ${join(root, "lanes", "broken.json")}`);
    expect(r.lines).toContain("PANES unavailable (hc ls exited 1: server not running)");
    expect(r.lines).toContain("LEAD pane=hc:t1 status=unknown");
    expect(r.lines.some((l) => l.startsWith("VANISHED"))).toBe(false);
    expect(r.lines).toContain(`NO-REPORT api status=working started=${new Date(1_000).toISOString()}`);
    has(`WORKLOG damaged ${join(root, "worklog.jsonl")}:1: `);
    expect(r.lines).toContain(`DAEMON heartbeat unreadable ${join(root, "messenger", "daemon.heartbeat")}`);
    expect(r.lines).toContain(`MESSENGER discord health unreadable ${join(root, "messenger", "discord", "health.json")}`);
    expect(r.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  });

  test("a stale heartbeat and a watch whose lane file is missing", async () => {
    const { w, d } = setup();
    const root = d.store.root;
    w.heartbeat(root, 120_000);
    const watch = new WatchStore(root).add({ owner: { kind: "lane", key: "vanished-key" }, source: { kind: "file", path: "/tmp/y" } }, w.clock);
    const r = await bootReport(d);
    expect(r.complete).toBe(true);
    expect(r.lines).toContain("DAEMON heartbeat age=120s stale");
    expect(r.lines).toContain(`ORPHAN-WATCH ${watch.id} name=file owner=lane:vanished-key lane=missing status=active; stop it with: seori watch stop ${watch.id}`);
  });

  test("a lane whose pane is gone (a restart closed it) is named with what that meant and the command that resumes it", async () => {
    const { w, d } = setup();
    w.addPane("t1", "idle");
    d.store.setRole("lead", paneRef("t1"));
    d.store.saveLane(lane("docs", "t4", "paused", { pausedFrom: "waiting", thread: "slack:C1:2" }));
    d.store.saveLane(lane("ui", "t5", "ready", { done: "pr:merged" }));
    const r = await bootReport(d);
    expect(r.lines).toContain(
      "VANISHED docs pane=hc:t4 status=paused; lane record kept, nothing relaunched; it was paused, not failed; once duty " +
        "marks it lost, resume it with: seori start docs --brief '/b/docs.md' --cwd '/repo' --thread 'slack:C1:2' --workflow none",
    );
    // Duty never marks a ready lane lost (its claim stands), and start takes back its key while its pane is gone.
    expect(r.lines).toContain(
      "VANISHED ui pane=hc:t5 status=ready; lane record kept, nothing relaunched; it had sent READY: its final answer and " +
        "evidence stay, and seori merge and seori done need no pane; if it needs more work, resume it with: " +
        "seori start ui --brief '/b/ui.md' --cwd '/repo' --done 'pr:merged' --workflow none",
    );
  });

  test("a malformed hooks block makes the config invalid", async () => {
    const { d } = setup();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ hooks: "x" }));
    const r = await bootReport(d);
    expect(r.lines.some((l) => l.startsWith("CONFIG invalid: config.json: hooks must be an object"))).toBe(true);
    expect(r.complete).toBe(false);
  });
});
