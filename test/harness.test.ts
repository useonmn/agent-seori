import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { LEAD_EXTENSION, main } from "../src/cli.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { defaultSeoriCmd, done, paneEnv, dutyTick, mergeGate, ready, Refusal, report, review, reviewerAnswer, send, startLane } from "../src/harness.ts";
import { backlogAdd } from "../src/loop.ts";
import { deliverOrThrow } from "../src/runtime/index.ts";
import { refText } from "../src/refs.ts";
import { startAgain } from "../src/restart.ts";
import { Channel } from "../src/channel.ts";
import { ompJson, World, paneRef } from "./fake.ts";

/** The harness's delivery to one stored pane id, through its runtime. */
const deliverTo = (d: ReturnType<World["deps"]>, paneId: string, text: string): Promise<boolean> => {
  return deliverOrThrow(d.runtime, paneRef(paneId), text);
};

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", paneRef("t1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}

async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

describe("seori command for agents and loop panes", () => {
  test("carries the home and model when set, so loops and lanes drive the same omp model", () => {
    const cmd = defaultSeoriCmd("/h o", { SEORI_MODEL: "anthropic/claude-haiku-5-5" });
    expect(cmd).toStartWith("SEORI_HOME='/h o' SEORI_MODEL='anthropic/claude-haiku-5-5' bun ");
    expect(defaultSeoriCmd("/h", {})).toStartWith("SEORI_HOME='/h' bun ");
  });

  test("the pane environment carries the home and model", () => {
    expect(paneEnv("/h", { SEORI_MODEL: "m" })).toEqual({ SEORI_HOME: "/h", SEORI_MODEL: "m" });
    expect(paneEnv("/h", {})).toEqual({ SEORI_HOME: "/h" });
  });
});

describe("lanes", () => {
  test("start opens a terminal, types omp at its shell, then sends the /goal kickoff, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, {});
    const pane = w.panes.get(lane.paneId)!;
    const sends = w.calls.filter((c) => c.cmd === "hc" && c.argv[1] === "send").map((c) => c.argv.at(-1));
    expect(sends[0]).toBe("'omp'");
    expect(pane.started).toEqual({ args: [] });
    expect(pane.ran).toEqual([]);
    expect(pane.received).toEqual([
      `/goal Read your brief at ${lane.brief} and execute it. Your lane key is fix-login. ` +
        `The work is finished only when the brief's exit condition holds and you have sent seori ready.`,
    ]);
    expect(await Bun.file(lane.brief).text()).toContain("seori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in hc:${lane.paneId}`]);
    await expect(startLane(d, "fix-login", brief, {})).rejects.toThrow(Refusal);
  });

  test("a kickoff omp has not started on is reported on stderr; the lane stays open", async () => {
    const { w, d, brief } = setup();
    w.kickoffIgnored = true;
    const errors: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((s: string) => (errors.push(String(s)), true)) as typeof process.stderr.write;
    let lane;
    try {
      lane = await startLane(d, "fix-login", brief, {});
    } finally {
      process.stderr.write = write;
    }
    expect(errors).toEqual([`seori: lane fix-login: omp in hc:${lane.paneId} has not started on the kickoff; check that pane\n`]);
    expect(w.panes.has(lane.paneId)).toBe(true);
    expect(d.store.lane("fix-login")?.status).toBe("working");
  });

  test("start --model goes to that lane's omp only and is stored on it; other lanes keep SEORI_MODEL; empty is refused", async () => {
    const { w, d, brief } = setup();
    const dm = { ...d, model: "m1" };
    const args = ["start", "fix-login", "--brief", brief, "--force", "--model", "m-hard"];
    expect(await main(args, dm)).toBe(0);
    const hard = dm.store.lane("fix-login")!;
    expect(hard.model).toBe("m-hard");
    expect(w.panes.get(hard.paneId)!.started!.args).toEqual(["--model", "m-hard"]);
    const plain = await startLane(dm, "fix-other", brief, {});
    expect("model" in plain).toBe(false);
    expect(w.panes.get(plain.paneId)!.started!.args).toEqual(["--model", "m1"]);
    await expect(startLane(dm, "fix-empty", brief, { model: " " })).rejects.toThrow("--model needs a model name");
  });

  test("start --thread refuses a message from someone other than the owner: lane reports never go into their thread", async () => {
    const { d, brief } = setup();
    new Channel(d.store.root).appendInbound({ id: "slack:C1:5", kind: "messenger", source: "slack", chat: "C1", from: "U2", notOwner: true, at: 1, text: "please fix" });
    await expect(startLane(d, "fix-other", brief, { thread: "slack:C1:5" })).rejects.toThrow("--thread slack:C1:5 is not a stored message of the owner's alone");
    // An id never stored is refused too: its thread may be anyone's.
    await expect(startLane(d, "fix-other", brief, { thread: "slack:C1:9" })).rejects.toThrow("--thread slack:C1:9 is not a stored message of the owner's alone");
    expect(d.store.lane("fix-other")).toBeUndefined();
  });

  test("SEORI_MODEL goes to the lane's omp as --model", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane({ ...d, model: "anthropic/claude-x" }, "fix-login", brief, {});
    expect(w.panes.get(lane.paneId)!.started!.args).toEqual(["--model", "anthropic/claude-x"]);
  });

  test("a failed agent start or kickoff closes the pane and saves no lane", async () => {
    const { w, d, lead, brief } = setup();
    const before = new Set(w.panes.keys());
    w.startFails = true;
    await expect(startLane(d, "no-start", brief, {})).rejects.toThrow(/lane no-start did not start, pane hc:t\d+ closed: .*did not report a status/);
    w.startFails = false;
    w.promptFails.set(`t${w.next + 1}`, "connection reset");
    await expect(startLane(d, "no-kickoff", brief, {})).rejects.toThrow(/lane no-kickoff did not start, .*connection reset/);
    expect([...w.panes.keys()]).toEqual([...before]);
    expect(d.store.lane("no-start")).toBeUndefined();
    expect(d.store.lane("no-kickoff")).toBeUndefined();
    expect(w.calls.filter((c) => c.argv[1] === "kill")).toHaveLength(2);
    expect(lead.received).toEqual([]);
  });

  test("a brief passed as its own briefs/<key>.md copy keeps exactly one lane footer, even after a failed start and retry", async () => {
    const { w, d } = setup();
    const copy = d.store.briefPath("fix-login");
    writeFileSync(copy, "Fix the flaky login test.\n");
    w.startFails = true;
    await expect(startLane(d, "fix-login", copy, {})).rejects.toThrow(Refusal);
    w.startFails = false;
    const lane = await startLane(d, "fix-login", copy, {});
    expect(lane.brief).toBe(copy);
    const text = readFileSync(copy, "utf8");
    expect(text.split("## Lane rules (added by seori for lane ")).toHaveLength(2);
    expect(text).toStartWith("Fix the flaky login test.\n\n## Lane rules (added by seori for lane `fix-login`)");
  });

  test("a brief elsewhere stays unchanged at its source path", async () => {
    const { d, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, {});
    expect(readFileSync(brief, "utf8")).toBe("Fix the flaky login test.");
    expect(readFileSync(lane.brief, "utf8")).toStartWith("Fix the flaky login test.\n\n## Lane rules");
  });

  test("start --activity-path given twice stores both values on the lane", async () => {
    const { d, brief } = setup();
    const args = ["start", "fix-login", "--brief", brief, "--force", "--activity-path", "out", "--activity-path", "/data/run.log"];
    expect(await main(args, d)).toBe(0);
    expect(d.store.lane("fix-login")!.activityPaths).toEqual(["out", "/data/run.log"]);
  });

  test("config.json defaultCwd is where a lane and a backlog item start without --cwd; --cwd wins; ~/ is the home directory", async () => {
    const { w, d, brief } = setup();
    const config = join(d.store.root, "config.json");
    const work = join(d.store.root, "assistant");
    writeFileSync(config, JSON.stringify({ defaultCwd: work }));
    const lane = await startLane(d, "research", brief, {});
    expect(lane.cwd).toBe(work);
    const opens = w.calls.filter((c) => c.cmd === "hc" && c.argv.includes("--cwd"));
    expect(opens.map((c) => c.argv[c.argv.indexOf("--cwd") + 1])).toEqual([work]);
    expect(backlogAdd(d, "later", brief).cwd).toBe(work);
    expect((await startLane(d, "project", brief, { cwd: "/elsewhere" })).cwd).toBe("/elsewhere");

    writeFileSync(config, JSON.stringify({ defaultCwd: "~/assistant" }));
    expect(loadConfig(d.store.root).defaultCwd).toBe(join(homedir(), "assistant"));
    writeFileSync(config, JSON.stringify({ defaultCwd: "~" }));
    expect(loadConfig(d.store.root).defaultCwd).toBe(homedir());
    for (const bad of ["assistant", "", "~user/x", 7, null]) {
      writeFileSync(config, JSON.stringify({ defaultCwd: bad }));
      expect(() => loadConfig(d.store.root)).toThrow(ConfigError);
    }
  });

  test("up appends the lead's omp config to a PI_CONFIG_FILES already in the environment", async () => {
    const w = new World();
    const d = { ...w.deps(), platform: "darwin" }; // terminals, not systemd units
    w.heartbeat(d.store.root, 0);
    const prev = process.env["PI_CONFIG_FILES"];
    process.env["PI_CONFIG_FILES"] = "/etc/omp/a.yml";
    try {
      await captureLog(() => main(["up", "--cwd", d.store.root], d));
    } finally {
      if (prev === undefined) delete process.env["PI_CONFIG_FILES"];
      else process.env["PI_CONFIG_FILES"] = prev;
    }
    const create = w.calls.find((c) => c.argv[1] === "run" && c.argv.includes("seori.role=lead"))!.argv;
    const prompts = join(d.store.root, "prompts");
    expect(create.find((a) => a.startsWith("PI_CONFIG_FILES="))).toBe(`PI_CONFIG_FILES=/etc/omp/a.yml${delimiter}${join(prompts, "agent-omp.yml")}${delimiter}${join(prompts, "lead-omp.yml")}`);
    expect(readFileSync(join(prompts, "lead-omp.yml"), "utf8")).toBe("advisor:\n  enabled: true\n  syncBacklog: strict\n");
  });

  test("a lane's omp gets agent-omp.yml (no setup wizard) but not the lead's settings it inherits from the lead's shell", async () => {
    const { w, d, brief } = setup();
    const prompts = join(d.store.root, "prompts");
    const prev = process.env["PI_CONFIG_FILES"];
    process.env["PI_CONFIG_FILES"] = ["/etc/omp/a.yml", join(prompts, "agent-omp.yml"), join(prompts, "lead-omp.yml")].join(delimiter);
    try {
      await startLane(d, "fix-login", brief, {});
    } finally {
      if (prev === undefined) delete process.env["PI_CONFIG_FILES"];
      else process.env["PI_CONFIG_FILES"] = prev;
    }
    const run = w.calls.find((c) => c.argv[1] === "run" && c.argv.includes("seori.role=lane"))!.argv;
    expect(run.find((a) => a.startsWith("PI_CONFIG_FILES="))).toBe(`PI_CONFIG_FILES=/etc/omp/a.yml${delimiter}${join(prompts, "agent-omp.yml")}`);
    expect(readFileSync(join(prompts, "agent-omp.yml"), "utf8")).toStartWith("startup:\n  setupWizard: false\n");
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, {})).rejects.toThrow(`lane key "${key}" is reserved for the ${key} role`);
      expect(d.store.lane(key)).toBeUndefined();
      expect(existsSync(d.store.briefPath(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toEqual(paneRef("t1"));
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, {});
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    await done(d, "fix-login");
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });

  test("done on a lane that is already closed says so and where to see its final state, touching nothing", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "fix-login", brief, {});
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    await done(d, "fix-login");
    const before = JSON.stringify(d.store.lane("fix-login"));
    const calls = w.calls.length;
    const err = await done(d, "fix-login").then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("lane fix-login is already closed at ");
    expect(err?.message).toContain("(closed by lead)");
    expect(err?.message).toContain(`${d.seoriCmd} status`);
    expect(err?.message).not.toContain("not ready");
    expect(w.calls.length).toBe(calls);
    expect(JSON.stringify(d.store.lane("fix-login"))).toBe(before);
  });
});

describe("pane messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, {});
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "hc:t1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT a-lane] tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("a blocked lead gets nothing typed: the message queues without an hc send", async () => {
    const { w, d, lead } = setup();
    lead.status = "blocked";
    expect(await send(d, "lead", "note", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(w.calls.filter((c) => c.argv[1] === "send")).toEqual([]);
  });

  test("an open lane in goal mode takes messages while working, through hc send --if working", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "a-lane", brief, {});
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    pane.received.length = 0;
    w.calls.length = 0;
    expect(await send(d, "a-lane", "rebase on main first", "lead")).toBe("DELIVERED");
    expect(pane.received).toEqual(["rebase on main first"]);
    expect(w.calls).toContainEqual({ cmd: "hc", argv: ["--json", "send", lane.paneId, "--if", "working", "--", "rebase on main first"] });
    expect(d.store.queued(lane.sessionRef)).toEqual([]);
  });

  test("a working lead still queues, and a blocked lane gets nothing typed", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "a-lane", brief, {});
    lead.status = "working";
    lead.received.length = 0;
    expect(await send(d, "lead", "note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "blocked";
    pane.received.length = 0;
    w.calls.length = 0;
    expect(await send(d, "a-lane", "note", "lead")).toBe("QUEUED");
    expect(pane.received).toEqual([]);
    expect(w.calls.filter((c) => c.argv[1] === "send")).toEqual([]);
  });

  test("a pane that is now a plain shell gets nothing typed and the message is reported not delivered", async () => {
    const { w, d } = setup();
    const shell = w.addPane("t7", "shell");
    await expect(deliverTo(d, "t7", "rm -rf nothing")).resolves.toBe(false);
    expect(shell.received).toEqual([]);
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});

describe("duty loop", () => {
  test("nudges a silent lane at 10 and 20 minutes, escalates at 40, and ignores WAITING lanes", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, {});
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    const at = async (min: number) => { w.clock = lane.createdAt + min * 60_000; return dutyTick(d); };
    expect(await at(5)).toEqual([]);
    expect(await at(10)).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("No report from you for 10 minutes");
    expect(await at(15)).toEqual([]);
    expect(await at(20)).toContainEqual({ lane: "quiet", action: "nudge-2" });
    expect(await at(40)).toContainEqual({ lane: "quiet", action: "escalated" });
    expect(lead.received.at(-1)).toContain("[ESCALATE quiet] no report for 40 min after 2 nudges");
    expect(await at(90)).toEqual([]);

    const waiting = await startLane(d, "blocked-on-ci", brief, {});
    w.panes.get(waiting.paneId)!.status = "idle";
    await report(d, "blocked-on-ci", "WAITING: CI", "waiting");
    w.clock += 60 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "blocked-on-ci")).toEqual([]);
  });

  test("a failing inbox flush on one pane does not stop the loop for the other panes", async () => {
    const { w, d, lead } = setup();
    const broken = w.addPane("t9", "idle");
    w.promptFails.set("t9", "hc exploded");
    d.store.enqueue(paneRef("t9"), { at: w.clock, from: "cli", text: "to broken" });
    d.store.enqueue(paneRef("t1"), { at: w.clock, from: "cli", text: "to lead" });
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "hc:t9", action: "delivery-ambiguous", detail: expect.stringContaining("hc exploded") });
    expect(events).toContainEqual({ pane: "hc:t1", action: "flushed" });
    // Inbox panes come in directory order, which differs between file systems: the notice and "to lead" arrive as two
    // deliveries or as one batch. What matters is that both reach the lead, the notice exactly once.
    const toLead = lead.received.join("\n");
    expect(toLead).toContain("to lead");
    expect(toLead.split("[DELIVERY-AMBIGUOUS hc:t9]")).toHaveLength(2);
    expect(broken.received).toEqual([]);
  });

  test("a failing lane-phase delivery is recorded as lane-failed and does not stop the other lanes", async () => {
    const { w, d, brief } = setup();
    const lost = await startLane(d, "lost-lane", brief, {});
    const stuck = await startLane(d, "stuck-lane", brief, {});
    const fine = await startLane(d, "fine-lane", brief, {});
    w.panes.delete(lost.paneId);
    w.panes.get(stuck.paneId)!.status = "idle";
    w.panes.get(fine.paneId)!.status = "idle";
    w.promptFails.set("t1", "lead exploded");
    w.promptFails.set(stuck.paneId, "stuck exploded");
    w.clock = fine.createdAt + 10 * 60_000;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "lost-lane", action: "lane-failed", detail: expect.stringContaining("lead exploded") });
    expect(events).toContainEqual({ lane: "stuck-lane", action: "lane-failed", detail: expect.stringContaining("stuck exploded") });
    expect(events).toContainEqual({ lane: "fine-lane", action: "nudge-1" });
    expect(w.panes.get(fine.paneId)!.received.at(-1)).toContain("No report from you for 10 minutes");
  });

  test("the delivery-ambiguous detail is hc's first output line, never the queued message", async () => {
    const { w, d } = setup();
    w.addPane("t9", "idle");
    w.promptFails.set("t9", "hc exploded\nsecond line");
    d.store.enqueue(paneRef("t9"), { at: w.clock, from: "cli", text: "SECRET queued message" });
    const events = await dutyTick(d);
    expect(events).toEqual([{ pane: "hc:t9", action: "delivery-ambiguous", detail: "hc --json send t9 --if idle -- <text> failed (1): hc exploded" }]);
  });

  test("the duty loop prints a delivery-ambiguous line with the reason", async () => {
    const { w, d } = setup();
    w.addPane("t9", "idle");
    w.promptFails.set("t9", "hc exploded");
    d.store.enqueue(paneRef("t9"), { at: w.clock, from: "cli", text: "to broken" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "--once"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("DUTY hc:t9 delivery-ambiguous: ");
    expect(lines[0]).toContain("hc exploded");
  });

  test("kill switch: a stopped duty loop flushes, nudges and escalates nothing; resume delivers what was held", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, {});
    w.panes.get(lane.paneId)!.status = "idle";
    lead.status = "working";
    expect(await send(d, "lead", "held note", "cli")).toBe("QUEUED");
    lead.status = "idle";
    lead.received.length = 0;
    w.clock = lane.createdAt + 40 * 60_000;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "stop", "--text", "maintenance"], d)).toBe(0);
      expect(await main(["duty", "--once"], d)).toBe(0);
      expect(await main(["duty", "status"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual(["DUTY STOPPED", "DUTY stopped: maintenance", "stopped: maintenance"]);
    expect(lead.received).toEqual([]);
    expect(d.store.lane("quiet")!.nudges).toBe(0);
    expect(d.store.stop()).toBeUndefined();

    await main(["duty", "resume"], d);
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "hc:t1", action: "flushed" });
    expect(events).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(lead.received).toEqual(["held note"]);
  });

  test("a lane hc reports working is still nudged when silent, through hc send; a report resets the ladder", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, {});
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    w.calls.length = 0;
    w.clock = lane.createdAt + 5 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("busy")!.lastActivityAt).toBe(lane.createdAt);
    w.clock = lane.createdAt + 10 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("No report from you for 10 minutes");
    expect(w.calls.some((c) => c.cmd === "hc" && c.argv[1] === "send" && c.argv[2] === lane.paneId)).toBe(true);

    await report(d, "busy", "tests green locally");
    expect(d.store.lane("busy")!.nudges).toBe(0);
    const reportedAt = w.clock;
    w.clock = reportedAt + 9 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    w.clock = reportedAt + 10 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "nudge-1" });
    w.clock = reportedAt + 20 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "nudge-2" });
    w.clock = reportedAt + 40 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "escalated" });
    expect(lead.received.at(-1)).toContain("[ESCALATE busy] no report for 40 min after 2 nudges");
  });

  test("a lane whose pane is blocked, or that reported WAITING while working, is not nudged", async () => {
    const { w, d, brief } = setup();
    const blocked = await startLane(d, "dialog", brief, {});
    const waiting = await startLane(d, "on-ci", brief, {});
    w.panes.get(blocked.paneId)!.status = "blocked";
    w.panes.get(waiting.paneId)!.status = "working";
    await report(d, "on-ci", "WAITING: CI", "waiting");
    w.calls.length = 0;
    w.clock += 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("dialog")!.nudges).toBe(0);
    expect(d.store.lane("on-ci")!.nudges).toBe(0);
    expect(w.calls.filter((c) => c.argv[1] === "send" && (c.argv[2] === blocked.paneId || c.argv[2] === waiting.paneId))).toEqual([]);
  });

  test("a report from a paused lane is forwarded but never ends the pause", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "held", brief, {});
    const lane = d.store.lane("held")!;
    d.store.saveLane({ ...lane, status: "paused", pausedFrom: "working" });
    await report(d, "held", "WAITING: ci", "waiting");
    expect(d.store.lane("held")).toMatchObject({ status: "paused", pausedFrom: "working" });
    expect(lead.received.at(-1)).toContain("[REPORT held WAITING] WAITING: ci");
  });

  test("a vanished pane is reported LOST", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, {});
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(lead.received.at(-1)).toContain("[LOST busy]");
  });

  test("a waiting lane whose pane is gone (a restart closed it) is LOST with what it waited on and the command that resumes it", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, {});
    await report(d, "busy", "waiting on CI", "waiting");
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(d.store.lane("busy")!.status).toBe("lost");
    const told = lead.received.at(-1)!;
    expect(told).toStartWith(`[LOST busy] pane ${refText(lane.sessionRef)} closed while the lane was waiting`);
    expect(told).toContain("the watches it armed end once it is lost");
    expect(told).toEndWith(`to resume it: ${startAgain(d.store.lane("busy")!, d.seoriCmd)}`);
  });

  /** Runs `during` on disk while dutyTick awaits the lane pane's status read, as a pause or close from another process would. */
  const duringStatusRead = (d: ReturnType<World["deps"]>, paneId: string, during: () => void): void => {
    const rt = d.runtime;
    const probe = rt.probe.bind(rt);
    rt.probe = async (ref) => {
      const read = await probe(ref);
      if (ref.id === paneId) during();
      return read;
    };
  };


  test("a lane paused while dutyTick reads its pane keeps the pause and is not nudged", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "busy", brief, {});
    w.panes.get(lane.paneId)!.status = "idle";
    w.clock = lane.createdAt + 10 * 60_000;
    duringStatusRead(d, lane.paneId, () => {
      const cur = d.store.lane("busy")!;
      if (cur.status === "working") d.store.saveLane({ ...cur, status: "paused", pausedFrom: "working" });
    });
    const events = await dutyTick(d);
    expect(events.filter((e) => e.lane === "busy")).toEqual([]);
    expect(d.store.lane("busy")).toMatchObject({ status: "paused", pausedFrom: "working", nudges: 0 });
  });

  test("a lane closed while dutyTick reads its gone pane stays done, not lost", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, {});
    w.panes.delete(lane.paneId);
    duringStatusRead(d, lane.paneId, () => {
      const cur = d.store.lane("busy")!;
      if (cur.status === "working") d.store.saveLane({ ...cur, status: "done" });
    });
    expect((await dutyTick(d)).filter((e) => e.lane === "busy")).toEqual([]);
    expect(d.store.lane("busy")!.status).toBe("done");
    expect(lead.received.some((m) => m.includes("[LOST busy]"))).toBe(false);
  });
});

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[], opts: { fixWithoutTest?: boolean } = {}) {
    // A one-commit PR at `head` for verify-pr: a feature commit, or a fix with no test and no "No test:" line.
    const files = [{ filename: "src/a.ts", status: "modified" }];
    const commit = {
      sha: head, parents: [{ sha: "b".repeat(40) }], files,
      commit: { message: opts.fixWithoutTest ? "fix: a" : "feat: a", author: { name: "me", email: "me@x" }, committer: { name: "me", email: "me@x" } },
    };
    const api: Record<string, unknown> = {
      "repos/o/r/pulls/7": { body: "", head: { sha: head }, commits: 1 },
      "repos/o/r/pulls/7/commits?per_page=100&page=1": [{ sha: head }],
      [`repos/o/r/commits/${head}?per_page=100&page=1`]: commit,
      "repos/o/r/pulls/7/files?per_page=100&page=1": files,
    };
    w.gh = (argv) => {
      if (argv[0] === "api") {
        const v = api[String(argv[3])];
        return v === undefined ? { code: 1, stdout: "HTTP 404" } : { code: 0, stdout: JSON.stringify(v) };
      }
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: ompJson("HIGH src/a.ts:3 ...\nVERDICT: BLOCK") });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: ompJson("no findings\nVERDICT: CLEAR", { provider: "openai", model: "gpt-x" }) });
    await review(d, "o/r#7", "gpt");
    expect(d.store.receipt("o/r#7", head)).toMatchObject({ verdict: "CLEAR", model: "openai/gpt-x", summary: "no findings\nVERDICT: CLEAR" });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [{ name: "test", bucket: "pass" }], { fixWithoutTest: true });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("verify-pr failed");
    gh(w, [{ name: "test", bucket: "pass" }, { name: "docs", bucket: "skipping" }]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
  });

  test("a PR head that gh cannot read refuses as a Refusal, naming the cause; review never starts the reviewer", async () => {
    const { w, d } = setup();
    w.gh = () => ({ code: 1, stdout: "gh: not logged in" });
    const merge = await mergeGate(d, "o/r#7").then(() => undefined, (e: unknown) => e);
    expect(merge).toBeInstanceOf(Refusal);
    expect((merge as Error).message).toMatch(/^MERGE_REFUSED /);
    expect((merge as Error).message).toContain("not logged in");
    const rev = await review(d, "o/r#7").then(() => undefined, (e: unknown) => e);
    expect(rev).toBeInstanceOf(Refusal);
    expect((rev as Error).message).toContain("not logged in");
    expect(w.calls.some((c) => c.cmd === "omp")).toBe(false);
  });

  test("the reviewer runs isolated in JSON mode; the model flag defaults to SEORI_MODEL", async () => {
    const { w, d } = setup();
    gh(w, []);
    await review({ ...d, model: "anthropic/claude-x" }, "o/r#7");
    const argv = w.calls.find((c) => c.cmd === "omp")!.argv;
    expect(argv.slice(0, -1)).toEqual([
      "-p", "--no-session", "--mode", "json", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files",
      "--approval-mode", "yolo", "--model", "anthropic/claude-x",
    ]);
    expect(argv.at(-1)).toContain("o/r#7");
  });

  test("a VERDICT outside the final answer does not count; no VERDICT writes no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: ompJson("looks fine I guess") });
    await expect(review(d, "o/r#8")).rejects.toThrow("no VERDICT");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR\n" });
    await expect(review(d, "o/r#8")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("a reviewer with no VERDICT line leaves its last 200 stdout lines in a private file named in the error", async () => {
    const { w, d } = setup();
    gh(w, []);
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    w.reviewer = () => ({ code: 0, stdout: lines.join("\n") });
    const err = await review(d, "o/r#9").then(() => undefined, (e: Error) => e);
    const path = /reviewer output saved to (\S+)$/.exec(err?.message ?? "")?.[1];
    expect(path).toBeDefined();
    expect(path!.startsWith(join(d.store.root, "receipts"))).toBe(true);
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(readFileSync(path!, "utf8").split("\n")).toEqual(lines.slice(-200));
    expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  });

  test("seori duty refuses an --interval that is not a number of seconds >= 0.001", async () => {
    const { d } = setup();
    for (const bad of ["0", "-5", "abc", "0.0001", "Infinity"]) {
      await expect(main(["duty", "--once", "--interval", bad], d)).rejects.toThrow("--interval must be a number of seconds");
    }
    expect(await main(["duty", "--once", "--interval", "0.001"], d)).toBe(0);
  });

  test("send, report and ready refuse an empty message; a value flag given last is refused; --help prints the usage", async () => {
    const { d } = setup();
    await expect(main(["send", "hc:t1", "--text", ""], d)).rejects.toThrow("the message is empty");
    await expect(main(["send", "hc:t1", "--text", "  "], d)).rejects.toThrow("the message is empty");
    await expect(main(["report", "fix-x", "--text", ""], d)).rejects.toThrow("the message is empty");
    await expect(main(["ready", "fix-x", "--text", ""], d)).rejects.toThrow("the message is empty");
    await expect(main(["send", "hc:t1", "--text"], d)).rejects.toThrow("--text needs a value");
    let code = -1;
    const out = await captureLog(async () => { code = await main(["send", "--help"], d); });
    expect(code).toBe(0);
    expect(out).toContain("seori duty");
  });

  test("a reviewer cut off by its deadline or the cost cap writes no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 1, stdout: ompJson("VERDICT: CLEAR", { stopReason: "aborted" }) });
    await expect(review(d, "o/r#8")).rejects.toThrow("reviewer stopped before finishing (deadline)");
    w.reviewer = () => ({ code: 3, stdout: "", stderr: "Cost cap reached: $0.50\n" });
    await expect(review(d, "o/r#8")).rejects.toThrow("reviewer hit the cost cap: Cost cap reached: $0.50");
    w.reviewer = () => ({ code: 1, stdout: "", stderr: 'Model "x" not found' });
    await expect(review(d, "o/r#8")).rejects.toThrow('reviewer exited 1: Model "x" not found');
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("reviewerAnswer: last agent_end's last assistant text, else the last assistant message_end", () => {
    const end = (text: string) => JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] });
    const msg = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text }], model: "m" } });
    expect(reviewerAnswer([end("first"), "Working...", end("second")].join("\n"))).toEqual({ text: "second", stopReason: "stop" });
    expect(reviewerAnswer([msg("partial"), msg("later")].join("\n"))).toEqual({ text: "later", model: "m" });
    expect(reviewerAnswer("plain text\n")).toBeUndefined();
  });
});
