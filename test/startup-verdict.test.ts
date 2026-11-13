// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { ready, type Deps } from "../src/harness.ts";
import { FIRST_CHECK_MS } from "../src/startup-verdict.ts";
import { World } from "./fake.ts";

// `seori start` classifies the new lane before it returns, the way upstream's launch does: the first check 20 s after
// the kickoff, then every 10 s up to startupWaitSeconds. Everything runs on the fake world's clock.

function setup(config?: Record<string, unknown>) {
  const w = new World();
  const d = w.deps();
  w.addPane("w1:p1", "idle");
  d.store.setRole("lead", { runtime: "herdr", id: "w1:p1" });
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  if (config) writeFileSync(join(d.store.root, "config.json"), JSON.stringify(config));
  // the pane `seori start` opens next
  const id = `w1:p${w.next + 1}`;
  return { w, d, brief, id };
}

async function start(d: Deps, brief: string): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  try {
    const code = await main(["start", "fix-login", "--brief", brief, "--workspace", "w1", "--force"], d);
    return { code, out };
  } finally {
    console.log = log;
  }
}

/** After the kickoff reached the pane, the agent reports `before` until `at` ms after it, then `after`. */
function statusAfterKickoff(w: World, id: string, at: number, before: "unknown" | "idle", after: "working" | "idle"): () => number | undefined {
  w.kickoffDead = true; // no working report of its own: the hook below decides every status
  let kicked: number | undefined;
  w.getHook.set(id, () => {
    const pane = w.panes.get(id)!;
    if (!pane.kicked) return;
    kicked ??= w.clock;
    pane.status = w.clock - kicked >= at ? after : before;
  });
  return () => kicked;
}

describe("seori start: startup verdict", () => {
  test("a 429 on the screen after the kickoff is STARTUP_ERROR, exit 3; the lane record and pane are kept", async () => {
    const { w, d, brief, id } = setup();
    w.getHook.set(id, () => {
      w.panes.get(id)!.screen = ["omp", "Error: 429 Too Many Requests", "> "];
    });
    const rt = d.runtimes.default;
    const read = rt.read.bind(rt);
    const asked: unknown[] = [];
    rt.read = (ref, lines, opts) => (asked.push(opts), read(ref, lines, opts));
    const { code, out } = await start(d, brief);
    expect(asked).toEqual([{ unwrapped: true }]);
    expect(out[0]).toStartWith(`STARTED fix-login pane=${id} brief=`);
    expect(out[1]).toBe(`STARTUP_ERROR fix-login ${id}: 429 Too Many Requests`);
    expect(code).toBe(3);
    expect(d.store.lane("fix-login")?.status).toBe("working");
    expect(w.panes.has(id)).toBe(true);
    // the screen is read unwrapped (herdr: recent-unwrapped)
    const reads = w.calls.filter((c) => c.argv[0] === "pane" && c.argv[1] === "read" && c.argv[2] === id);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.argv.join(" ").includes("--source recent-unwrapped"))).toBe(true);
  });

  test("a clean screen with omp working on the kickoff is STARTUP_OK at the first check, 20 s after the kickoff", async () => {
    const { w, d, brief, id } = setup();
    let kickedAt: number | undefined;
    w.getHook.set(id, () => void (w.panes.get(id)!.kicked && (kickedAt ??= w.clock)));
    const { code, out } = await start(d, brief);
    expect(out[1]).toBe(`STARTUP_OK fix-login ${id}`);
    expect(code).toBe(0);
    expect(w.clock - kickedAt!).toBe(20_000);
  });

  test("status unreported until 60 s, then working: STARTUP_OK with startupWaitSeconds 180", async () => {
    const { w, d, brief, id } = setup({ startupWaitSeconds: 180 });
    statusAfterKickoff(w, id, 60_000, "unknown", "working");
    const { code, out } = await start(d, brief);
    expect(out[1]).toBe(`STARTUP_OK fix-login ${id}`);
    expect(code).toBe(0);
  });

  test("the same lane with startupWaitSeconds 30 is STARTUP_UNCONFIRMED, exit 3, record kept", async () => {
    const { w, d, brief, id } = setup({ startupWaitSeconds: 30 });
    statusAfterKickoff(w, id, 60_000, "unknown", "working");
    const { code, out } = await start(d, brief);
    expect(out[1]).toStartWith(`STARTUP_UNCONFIRMED fix-login ${id}: no ready agent status (unknown) after `);
    expect(code).toBe(3);
    expect(d.store.lane("fix-login")?.status).toBe("working");
  });

  test("omp idle and never working on the kickoff, even after the Enter, is STARTUP_UNCONFIRMED", async () => {
    const { w, d, brief, id } = setup({ startupWaitSeconds: 60 });
    w.kickoffDead = true;
    const { code, out } = await start(d, brief);
    expect(out[1]).toStartWith(`STARTUP_UNCONFIRMED fix-login ${id}: omp has not started on the kickoff after `);
    expect(code).toBe(3);
    expect(w.calls.filter((c) => c.argv[1] === "send-keys")).toHaveLength(1);
  });

  test("a lane that sends READY during the wait is STARTUP_DONE, exit 0", async () => {
    const { w, d, brief, id } = setup();
    statusAfterKickoff(w, id, 10 * 60_000, "unknown", "working");
    const sleep = d.sleep;
    let readied = false;
    const deps: Deps = {
      ...d,
      sleep: async (ms) => {
        await sleep(ms);
        if (!readied && d.store.lane("fix-login")) {
          readied = true;
          await ready(d, "fix-login", "fixed", ["file:/x/out.txt"]);
        }
      },
    };
    const { code, out } = await start(deps, brief);
    expect(readied).toBe(true);
    expect(out[1]).toBe("STARTUP_DONE fix-login");
    expect(code).toBe(0);
  });

  test("a failure that shows while omp sits idle is STARTUP_ERROR; while it works, a quoted phrase is not", async () => {
    const late = setup();
    statusAfterKickoff(late.w, late.id, 70_000, "unknown", "idle"); // after the first check, which sees a clean screen
    const pane = () => late.w.panes.get(late.id)!;
    const hook = late.w.getHook.get(late.id)!;
    late.w.getHook.set(late.id, (n) => {
      hook(n);
      if (pane().kicked && pane().status === "idle") pane().screen = ["No API key found for provider anthropic", "> "];
    });
    const failed = await start(late.d, late.brief);
    expect(failed.out[1]).toBe(`STARTUP_ERROR fix-login ${late.id}: No API key`);
    expect(failed.code).toBe(3);

    // The screen read just before the status read that says working shows a quoted phrase: omp's own output, no failure.
    const busy = setup();
    const kicked = statusAfterKickoff(busy.w, busy.id, 60_000, "unknown", "working");
    const hook2 = busy.w.getHook.get(busy.id)!;
    busy.w.getHook.set(busy.id, (n) => {
      hook2(n);
      if (busy.w.clock - (kicked() ?? busy.w.clock) >= 50_000) busy.w.panes.get(busy.id)!.screen = ["grep: Rate limit reached in logs/app.log", "> "];
    });
    const ok = await start(busy.d, busy.brief);
    expect(ok.out[1]).toBe(`STARTUP_OK fix-login ${busy.id}`);
    expect(ok.code).toBe(0);
  });

  test("STARTED is printed as soon as the lane is open, before the first startup check", async () => {
    const { w, d, brief, id } = setup();
    let kickedAt: number | undefined;
    w.getHook.set(id, () => void (w.panes.get(id)!.kicked && (kickedAt ??= w.clock)));
    const at: { line: string; clock: number }[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void at.push({ line: args.join(" "), clock: w.clock });
    try {
      await main(["start", "fix-login", "--brief", brief, "--workspace", "w1", "--force"], d);
    } finally {
      console.log = log;
    }
    const started = at.find((l) => l.line.startsWith("STARTED fix-login"))!;
    const verdict = at.find((l) => l.line.startsWith("STARTUP_"))!;
    expect(started.clock - kickedAt!).toBeLessThan(FIRST_CHECK_MS);
    expect(verdict.clock).toBeGreaterThan(started.clock);
  });

  test("a verdict that throws is STARTUP_UNCONFIRMED, exit 3, after STARTED", async () => {
    const { w, d, brief, id } = setup();
    // the verdict's own wait fails: once the kickoff is in, the next sleep throws
    const sleep = d.sleep;
    const deps: Deps = {
      ...d,
      sleep: async (ms) => {
        if (w.panes.get(id)?.kicked) throw new Error("clock broke");
        await sleep(ms);
      },
    };
    const { code, out } = await start(deps, brief);
    expect(out[0]).toStartWith("STARTED fix-login");
    expect(out[1]).toStartWith(`STARTUP_UNCONFIRMED fix-login ${id}: verdict failed: clock broke`);
    expect(code).toBe(3);
  });

  test("a pane already working at the first check ignores failure text on its screen: STARTUP_OK", async () => {
    const { w, d, brief, id } = setup();
    statusAfterKickoff(w, id, 30_000, "unknown", "idle");
    const hook = w.getHook.get(id)!;
    w.getHook.set(id, (n) => {
      hook(n);
      const pane = w.panes.get(id)!;
      if (pane.kicked) {
        pane.screen = ["$ bun test", "error: Cannot find module './login' from 'test/login.test.ts'", "> "];
        if (pane.status !== "idle") pane.status = "working";
      }
    });
    const { code, out } = await start(d, brief);
    expect(out[1]).toBe(`STARTUP_OK fix-login ${id}`);
    expect(code).toBe(0);
  });

  test("an agent behind a dialog (blocked) is STARTUP_UNCONFIRMED at once", async () => {
    const { w, d, brief, id } = setup();
    statusAfterKickoff(w, id, 0, "unknown", "working");
    const hook = w.getHook.get(id)!;
    w.getHook.set(id, (n) => {
      hook(n);
      if (w.panes.get(id)!.kicked) w.panes.get(id)!.status = "blocked";
    });
    const { code, out } = await start(d, brief);
    expect(out[1]).toStartWith(`STARTUP_UNCONFIRMED fix-login ${id}: no ready agent status (blocked)`);
    expect(code).toBe(3);
  });
});

describe("config startupWaitSeconds", () => {
  test("defaults to 180; takes a nonnegative number; refuses anything else", () => {
    const { d } = setup();
    expect(loadConfig(d.store.root).startupWaitSeconds).toBe(180);
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ startupWaitSeconds: 45 }));
    expect(loadConfig(d.store.root).startupWaitSeconds).toBe(45);
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ startupWaitSeconds: -1 }));
    expect(() => loadConfig(d.store.root)).toThrow(ConfigError);
  });
});
