// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { Herdr } from "../src/runtime/herdr/client.ts";
import { defaultRuntimes } from "../src/runtime/index.ts";
import type { AgentStatus, SessionRef } from "../src/runtime/types.ts";
import type { Lane, QueuedMessage } from "../src/store.ts";
import { herdrRef, World } from "./fake.ts";
import type { FakeKnobs, FakeTerminal } from "./helpers/fake-hc.ts";
import { rig } from "./helpers/hc-rig.ts";

export const OLD = herdrRef("w1:p3");
export const NEW: SessionRef = { runtime: "hc", id: "t1" };
export const FOOTER = "## Lane rules (added by seori for lane `k`)\n\nrules";
export const msg = (text: string, at: number, attempt?: QueuedMessage["attempt"]): QueuedMessage => ({
  at,
  from: "cli",
  text,
  ...(attempt ? { attempt } : {}),
});

/**
 * A herdr lane `k` in pane w1:p3 (the lead is w1:p1), selected runtime hc over the fake hc binary. Every omp started
 * in an hc terminal reports `knobs.agentReportsAs` (default idle). Deps.sleep advances the world clock.
 */
export function migrateWorld(status: AgentStatus = "idle", knobs: FakeKnobs = {}, terminals: Record<string, FakeTerminal> = {}) {
  const w = new World();
  const r = rig(terminals, {}, { agentReports: true, ...knobs });
  const base = w.deps();
  // Through a closure, so a test can wrap w.exec after the world is built.
  const herdr = new Herdr((cmd, argv) => w.exec(cmd, argv), "", join(base.store.root, "messages"));
  const d: Deps = { ...base, runtimes: defaultRuntimes(herdr, () => r.rt, "hc") };
  w.addPane("w1:p1", "idle");
  d.store.setRole("lead", herdrRef("w1:p1"));
  const pane = w.addPane("w1:p3", status);
  pane.screen = ["screen line 1", "screen line 2"];
  writeFileSync(d.store.briefPath("k"), `Fix the flaky login test.\n\n${FOOTER}\n`);
  const lane: Lane = {
    key: "k",
    sessionRef: OLD,
    paneId: OLD.id,
    tabId: "w1:t3",
    brief: d.store.briefPath("k"),
    cwd: "/w",
    status: "working",
    createdAt: 1,
    lastActivityAt: w.clock,
    nudges: 0,
    log: [{ at: 1, kind: "start", text: "brief.md" }],
  };
  d.store.saveLane(lane);
  const lines: string[] = [];
  const opts = (over: Partial<MigrateOpts> = {}): MigrateOpts => ({
    to: "hc",
    dryRun: false,
    waitMinutes: 10,
    resume: false,
    log: (l) => void lines.push(l),
    ...over,
  });
  /** The `agent prompt` texts herdr delivered (the checkpoint asks). */
  const asks = (): string[] =>
    w.calls.filter((c) => c.cmd === "herdr" && c.argv[0] === "agent" && c.argv[1] === "prompt").map((c) => String(c.argv[3]));
  return { w, r, d, pane, lane, lines, opts, asks };
}

/** Every file under the home with its size, mtime and content: equal snapshots mean nothing was written. */
export function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(`${p} ${s.size} ${s.mtimeMs} ${readFileSync(p, "utf8")}`);
    }
  };
  walk(root);
  return out;
}
