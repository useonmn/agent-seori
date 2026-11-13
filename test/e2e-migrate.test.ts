// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { migrate } from "../src/migrate.ts";
import { readJournal } from "../src/migrate-journal.ts";
import { envExec } from "../src/runtime/hc/exec.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { Herdr } from "../src/runtime/herdr/client.ts";
import { defaultRuntimes } from "../src/runtime/index.ts";
import { Store, type Lane } from "../src/store.ts";
import { enabled, fixture, newHome, screen, seoriEnv, startCore, stopCore, terminal, until } from "./e2e-hc-setup.ts";
import { herdrRef, World } from "./fake.ts";

// `seori migrate` of a lane from herdr to real hc (herdr-core) on the isolated e2e core, only with SEORI_E2E_HC=1. The
// herdr side is the in-process fake (test/fake.ts); the replacement is a real hc terminal running the fake omp, which
// reports OSC 7501 and echoes what it reads, so the kickoff on the handoff brief is read back from its screen.

beforeAll(async () => {
  if (enabled) await startCore();
});

afterAll(async () => {
  if (!enabled) return;
  const stopped = await stopCore();
  expect(stopped.alive).toBe(false);
  expect(stopped.sockets).toEqual([]);
});

test.skipIf(!enabled)("a herdr lane migrates to a labelled hc terminal whose agent took the handoff kickoff", async () => {
  const home = newHome("migrate");
  const name = `mig${process.pid}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ name }));
  const env = { ...seoriEnv(home), SHELL: "/bin/bash" };
  const rt = new HcRuntime(envExec(env), { env, agentCommand: fixture });
  const w = new World();
  const base = w.deps();
  const d: Deps = { ...base, store: new Store(home), runtimes: defaultRuntimes(new Herdr(w.exec, "", join(home, "messages")), () => rt, "hc") };
  const old = herdrRef("w1:p3");
  w.addPane("w1:p3", "idle").screen = ["E2E-OLD-SCREEN"];
  writeFileSync(d.store.briefPath("k"), "E2E-MIGRATE-BRIEF\n\n## Lane rules (added by seori for lane `k`)\n\nrules\n");
  const lane: Lane = {
    key: "k", sessionRef: old, paneId: old.id, tabId: "w1:t3", brief: d.store.briefPath("k"), cwd: home,
    status: "working", createdAt: 1, lastActivityAt: w.clock, nudges: 0, log: [{ at: 1, kind: "start", text: "brief.md" }],
  };
  d.store.saveLane(lane);
  d.store.enqueue(old, { at: 1, from: "cli", text: "E2E-QUEUED" });

  const lines: string[] = [];
  // The brief is named after the run's start: the old pane never starts on the ask, so the wait moves the clock on.
  const at = w.clock;
  const code = await migrate(d, { lane: "k" }, { to: "hc", dryRun: false, waitMinutes: 1, resume: false, log: (l) => void lines.push(l) });
  expect(code).toBe(0);
  const address = /^MIGRATED k w1:p3 -> hc:(t[0-9a-z]+)$/.exec(lines.join("\n"))?.[1];
  expect(address).toBeDefined();

  const got = await terminal(address!);
  expect(got["state"]).toBe("live");
  expect(got["labels"]).toMatchObject({ "seori.group": name, "seori.lane": "k", "seori.role": "lane" });
  const brief = join(home, "briefs", `k.migrate-${at}.md`);
  expect(readFileSync(brief, "utf8")).toContain("E2E-OLD-SCREEN");
  await until("the kickoff on the handoff brief to reach the fake omp", async () =>
    (await screen(address!)).includes(`Read your brief at ${brief}`) ? true : undefined,
  );

  const after = d.store.lane("k")!;
  expect(after.sessionRef).toMatchObject({ runtime: "hc", id: address });
  expect(after.migratedFrom).toEqual([old]);
  expect(after.migration).toBeUndefined();
  expect(readJournal(home, "k")).toBeUndefined();
  expect(w.panes.has("w1:p3")).toBe(false);
  expect(d.store.queued({ runtime: "hc", id: address! }).map((m) => m.text)).toEqual(["E2E-QUEUED"]);
});
