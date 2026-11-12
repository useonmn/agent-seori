import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { LEAD_EXTENSION, main } from "../src/cli.ts";
import { agentName, defaultSeoriCmd, done, paneEnv, dutyTick, INTEGRATION_MISSING, mergeGate, ready, Refusal, report, review, reviewerAnswer, send, startLane } from "../src/harness.ts";
import { ompJson, World } from "./fake.ts";

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
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
  test("carries the herdr session and model when set, so loops and lanes drive the same herdr and omp model", () => {
    const cmd = defaultSeoriCmd("/h o", { SEORI_HERDR_SESSION: "iso", SEORI_MODEL: "anthropic/claude-haiku-5-5" });
    expect(cmd).toStartWith("SEORI_HOME='/h o' SEORI_HERDR_SESSION='iso' SEORI_MODEL='anthropic/claude-haiku-5-5' bun ");
    expect(defaultSeoriCmd("/h", {})).toStartWith("SEORI_HOME='/h' bun ");
  });

  test("the pane environment carries the home and the herdr session and model", () => {
    expect(paneEnv("/h", { SEORI_HERDR_SESSION: "iso", SEORI_MODEL: "m" })).toEqual({ SEORI_HOME: "/h", SEORI_HERDR_SESSION: "iso", SEORI_MODEL: "m" });
    expect(paneEnv("/h", {})).toEqual({ SEORI_HOME: "/h" });
  });
});

test("agent names are valid for herdr: uppercase pane ids stay unique, long keys are cut to 32 characters", () => {
  const valid = /^[a-z][a-z0-9_-]{0,31}$/;
  expect(agentName("lead", "w1:p2")).toBe("lead-w1p2");
  expect(agentName("smoke", "wC:p2")).toBe("smoke-w_cp2");
  expect(agentName("smoke", "wC:p2")).not.toBe(agentName("smoke", "wc:p2"));
  const long = agentName("a".repeat(41), "wAB:p12");
  expect(long).toMatch(valid);
  expect(long.endsWith("-w_a_bp12")).toBe(true);
});

describe("lanes", () => {
  test("start opens a tab, starts omp with herdr agent start, then sends the /goal kickoff, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    const herdrCalls = w.calls.filter((c) => c.cmd === "herdr" && c.argv[0] === "agent").map((c) => c.argv.slice(0, 3));
    expect(herdrCalls.slice(0, 2)).toEqual([["agent", "start", `fix-login-${lane.paneId.replace(":", "")}`], ["agent", "prompt", lane.paneId]]);
    expect(w.calls.find((c) => c.argv[1] === "start")!.argv).toEqual(["agent", "start", pane.started!.name, "--kind", "omp", "--pane", lane.paneId, "--timeout", "60000", "--"]);
    expect(pane.ran).toEqual([]);
    expect(pane.received).toEqual([
      `/goal Read your brief at ${lane.brief} and execute it. Your lane key is fix-login. ` +
        `The work is finished only when the brief's exit condition holds and you have sent seori ready.`,
    ]);
    expect(await Bun.file(lane.brief).text()).toContain("seori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
    await expect(startLane(d, "fix-login", brief, { workspace: "w1" })).rejects.toThrow(Refusal);
  });

  test("the kickoff waits until omp's integration reports the session (omp loaded), at most 30 s", async () => {
    const { w, d, brief } = setup();
    w.sessionLate = true;
    const id = `w1:p${w.next + 1}`;
    w.getHook.set(id, (n) => { if (n === 3) w.panes.get(id)!.session = "/h/.omp/agent/sessions/x.jsonl"; });
    const t0 = w.clock;
    await startLane(d, "fix-login", brief, { workspace: "w1" });
    const order = w.calls.filter((c) => (c.argv[0] === "pane" && c.argv[1] === "get") || (c.argv[0] === "agent" && c.argv[1] === "prompt")).map((c) => c.argv[1]);
    // three reads until the session shows, then deliver's own read of the status right before the prompt
    expect(order.slice(0, 5)).toEqual(["get", "get", "get", "get", "prompt"]);
    expect(w.clock - t0).toBe(1000);

    const late = setup();
    late.w.sessionLate = true;
    const t1 = late.w.clock;
    const lane = await startLane(late.d, "fix-login", late.brief, { workspace: "w1" });
    expect(late.w.clock - t1).toBe(30_000);
    expect(late.w.panes.get(lane.paneId)!.received).toHaveLength(1);
  });

  test("a kickoff whose Enter was lost gets one Enter, never typed again; the lane starts", async () => {
    const { w, d, lead, brief } = setup();
    w.kickoffLost = true;
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    expect(pane.received).toHaveLength(1);
    expect(pane.kickoffLost).toBe(false);
    expect(w.calls.filter((c) => c.argv[1] === "send-keys").map((c) => c.argv.slice(2))).toEqual([[lane.paneId, "enter"]]);
    expect(d.store.lane("fix-login")?.status).toBe("working");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
  });

  test("a kickoff omp still has not started after the Enter is reported on stderr; the lane stays open", async () => {
    const { w, d, brief } = setup();
    w.kickoffDead = true;
    const errors: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((s: string) => (errors.push(String(s)), true)) as typeof process.stderr.write;
    let lane;
    try {
      lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    } finally {
      process.stderr.write = write;
    }
    expect(errors).toEqual([`seori: lane fix-login: omp in ${lane.paneId} has not started on the kickoff; check that pane\n`]);
    expect(w.calls.filter((c) => c.argv[1] === "send-keys")).toHaveLength(1);
    expect(w.panes.has(lane.paneId)).toBe(true);
    expect(d.store.lane("fix-login")?.status).toBe("working");
  });

  test("SEORI_MODEL goes to the lane's omp as --model", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane({ ...d, model: "anthropic/claude-x" }, "fix-login", brief, { workspace: "w1" });
    expect(w.panes.get(lane.paneId)!.started!.args).toEqual(["--model", "anthropic/claude-x"]);
  });

  test("a failed agent start or kickoff closes the pane and saves no lane", async () => {
    const { w, d, lead, brief } = setup();
    w.startFails = '{"error":{"code":"agent_start_timeout"}}';
    await expect(startLane(d, "no-start", brief, { workspace: "w1" })).rejects.toThrow(/lane no-start did not start, pane w1:p\d+ closed: .*agent_start_timeout/);
    w.startFails = undefined;
    const before = new Set(w.panes.keys());
    w.promptFails.set(`w1:p${w.next + 1}`, '{"error":{"code":"agent_blocked"}}');
    await expect(startLane(d, "no-kickoff", brief, { workspace: "w1" })).rejects.toThrow(/lane no-kickoff did not start, .*agent_blocked/);
    expect([...w.panes.keys()]).toEqual([...before]);
    expect(d.store.lane("no-start")).toBeUndefined();
    expect(d.store.lane("no-kickoff")).toBeUndefined();
    expect(w.calls.filter((c) => c.argv[1] === "close")).toHaveLength(2);
    expect(lead.received).toEqual([]);
  });

  test("a brief passed as its own briefs/<key>.md copy keeps exactly one lane footer, even after a failed start and retry", async () => {
    const { w, d } = setup();
    const copy = d.store.briefPath("fix-login");
    writeFileSync(copy, "Fix the flaky login test.\n");
    w.startFails = '{"error":{"code":"agent_start_timeout"}}';
    await expect(startLane(d, "fix-login", copy, { workspace: "w1" })).rejects.toThrow(Refusal);
    w.startFails = undefined;
    const lane = await startLane(d, "fix-login", copy, { workspace: "w1" });
    expect(lane.brief).toBe(copy);
    const text = readFileSync(copy, "utf8");
    expect(text.split("## Lane rules (added by seori for lane ")).toHaveLength(2);
    expect(text).toStartWith("Fix the flaky login test.\n\n## Lane rules (added by seori for lane `fix-login`)");
  });

  test("a brief elsewhere stays unchanged at its source path", async () => {
    const { d, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    expect(readFileSync(brief, "utf8")).toBe("Fix the flaky login test.");
    expect(readFileSync(lane.brief, "utf8")).toStartWith("Fix the flaky login test.\n\n## Lane rules");
  });

  test("start and up refuse without herdr's omp integration, before opening anything", async () => {
    const { w, d, brief } = setup();
    w.ompIntegration = false;
    await expect(main(["start", "fix-login", "--brief", brief, "--workspace", "w1"], d)).rejects.toThrow(INTEGRATION_MISSING);
    await expect(main(["up", "--cwd", d.store.root], d)).rejects.toThrow(INTEGRATION_MISSING);
    expect(w.calls.map((c) => c.argv.slice(0, 2).join(" "))).toEqual(["integration status", "integration status"]);
    expect(d.store.lane("fix-login")).toBeUndefined();
  });

  test("up starts the lead (with the channel extension) and duty omp with herdr agent start; loops and daemon use pane run", async () => {
    const w = new World();
    const d = { ...w.deps(), model: "m1" };
    w.heartbeat(d.store.root, 0); // the daemon's first heartbeat, which up waits for before it starts the duty loop
    const prev = process.env["SEORI_HERDR_SESSION"];
    const prevConfig = process.env["PI_CONFIG_FILES"];
    process.env["SEORI_HERDR_SESSION"] = "iso";
    delete process.env["PI_CONFIG_FILES"];
    let out: string;
    try {
      out = await captureLog(() => main(["up", "--cwd", d.store.root], d));
    } finally {
      if (prev === undefined) delete process.env["SEORI_HERDR_SESSION"];
      else process.env["SEORI_HERDR_SESSION"] = prev;
      if (prevConfig === undefined) delete process.env["PI_CONFIG_FILES"];
      else process.env["PI_CONFIG_FILES"] = prevConfig;
    }
    const { lead, duty } = d.store.roles();
    const prompts = join(d.store.root, "prompts");
    expect(w.panes.get(lead!)!.started).toEqual({
      name: `lead-${lead!.replace(":", "")}`,
      args: ["-e", LEAD_EXTENSION, "--append-system-prompt", join(prompts, "lead.md"), "--model", "m1"],
    });
    expect(existsSync(LEAD_EXTENSION)).toBe(true);
    // Only the lead loads the extension: duty here, lanes and the reviewer elsewhere never pass -e.
    expect(w.panes.get(duty!)!.started).toEqual({ name: `duty-${duty!.replace(":", "")}`, args: ["--append-system-prompt", join(prompts, "duty.md"), "--model", "m1"] });
    // herdr agent start has no --env: the extension's environment is set on the lead's workspace shell.
    const create = w.calls.find((c) => c.argv[0] === "workspace" && c.argv[1] === "create")!.argv;
    // Only the lead's omp gets lead-omp.yml: advisor.syncBacklog strict, so the agent-end review ends before agent_end.
    // The lead and duty both get agent-omp.yml: no setup wizard in an agent pane.
    const leadConfig = join(prompts, "lead-omp.yml");
    const agentConfig = join(prompts, "agent-omp.yml");
    expect(create.slice(-8)).toEqual([
      "--env", `SEORI_HOME=${d.store.root}`, "--env", "SEORI_CMD=seori", "--env", "SEORI_HERDR_SESSION=iso", "--env", `PI_CONFIG_FILES=${agentConfig}${delimiter}${leadConfig}`,
    ]);
    expect(readFileSync(leadConfig, "utf8")).toBe("advisor:\n  syncBacklog: strict\n");
    // A home other than ~/.seori keeps its agents' omp memory in itself.
    expect(readFileSync(agentConfig, "utf8")).toBe(
      `startup:\n  setupWizard: false\nmnemopi:\n  dbPath: ${JSON.stringify(join(d.store.root, "omp", "memories", "mnemopi.db"))}\n`,
    );
    const dutyTab = w.calls.find((c) => c.argv[0] === "tab" && c.argv[1] === "create")!.argv;
    expect(dutyTab.at(-1)).toBe(`PI_CONFIG_FILES=${agentConfig}`);
    const others = w.calls.filter((c) => c.argv !== create && c.argv !== dutyTab);
    expect(others.some((c) => c.argv.some((arg) => arg.startsWith("PI_CONFIG_FILES=")))).toBe(false);
    // The daemon starts first, so the duty loop's first tick finds its heartbeat instead of reporting an outage.
    expect(w.calls.filter((c) => c.argv[0] === "pane" && c.argv[1] === "run").map((c) => [c.argv[2], c.argv[3]])).toEqual([
      ["w1:p6", "seori daemon-loop"],
      ["w1:p4", "seori duty --interval 60"],
      ["w1:p5", "seori loop"],
    ]);
    expect(out).toBe(`UP lead=${lead} duty=${duty} loop=w1:p4 hourly=w1:p5 daemon=w1:p6 home=${d.store.root} name=seori`);
    expect(create.slice(0, 3)).toEqual(["workspace", "create", "--label"]);
    expect(create[3]).toBe("seori");
    // Every pane gets seori's environment from herdr, so its commands need no shell env prefix.
    const splits = w.calls.filter((c) => (c.argv[0] === "tab" && c.argv[1] === "create") || (c.argv[0] === "pane" && c.argv[1] === "split"));
    expect(splits).toHaveLength(4);
    for (const c of splits) expect(c.argv).toEqual(expect.arrayContaining([`SEORI_HOME=${d.store.root}`, "SEORI_HERDR_SESSION=iso"]));
  });

  test("up appends the lead's omp config to a PI_CONFIG_FILES already in the environment", async () => {
    const w = new World();
    const d = w.deps();
    w.heartbeat(d.store.root, 0);
    const prev = process.env["PI_CONFIG_FILES"];
    process.env["PI_CONFIG_FILES"] = "/etc/omp/a.yml";
    try {
      await captureLog(() => main(["up", "--cwd", d.store.root], d));
    } finally {
      if (prev === undefined) delete process.env["PI_CONFIG_FILES"];
      else process.env["PI_CONFIG_FILES"] = prev;
    }
    const create = w.calls.find((c) => c.argv[0] === "workspace" && c.argv[1] === "create")!.argv;
    const prompts = join(d.store.root, "prompts");
    expect(create.at(-1)).toBe(`PI_CONFIG_FILES=/etc/omp/a.yml${delimiter}${join(prompts, "agent-omp.yml")}${delimiter}${join(prompts, "lead-omp.yml")}`);
  });

  test("a lane's omp gets agent-omp.yml (no setup wizard) but not the lead's settings it inherits from the lead's shell", async () => {
    const { w, d, brief } = setup();
    const prompts = join(d.store.root, "prompts");
    const prev = process.env["PI_CONFIG_FILES"];
    process.env["PI_CONFIG_FILES"] = ["/etc/omp/a.yml", join(prompts, "agent-omp.yml"), join(prompts, "lead-omp.yml")].join(delimiter);
    try {
      await startLane(d, "fix-login", brief, { workspace: "w1" });
    } finally {
      if (prev === undefined) delete process.env["PI_CONFIG_FILES"];
      else process.env["PI_CONFIG_FILES"] = prev;
    }
    const tab = w.calls.find((c) => c.argv[0] === "tab" && c.argv[1] === "create")!.argv;
    expect(tab.at(-1)).toBe(`PI_CONFIG_FILES=/etc/omp/a.yml${delimiter}${join(prompts, "agent-omp.yml")}`);
    expect(readFileSync(join(prompts, "agent-omp.yml"), "utf8")).toStartWith("startup:\n  setupWizard: false\n");
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, { workspace: "w1" })).rejects.toThrow(`lane key "${key}" is reserved for the ${key} role`);
      expect(d.store.lane(key)).toBeUndefined();
      expect(existsSync(d.store.briefPath(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toBe("w1:p1");
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
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
    await startLane(d, "fix-login", brief, { workspace: "w1" });
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
    await startLane(d, "a-lane", brief, { workspace: "w1" });
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT a-lane] tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("a blocked lead gets nothing typed: the message queues without agent prompt or send-text", async () => {
    const { w, d, lead } = setup();
    lead.status = "blocked";
    expect(await send(d, "lead", "note", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(w.calls.filter((c) => c.argv[0] === "agent" && c.argv[1] === "prompt")).toEqual([]);
    expect(w.calls.filter((c) => c.argv[1] === "send-text")).toEqual([]);
  });

  test("an open lane in goal mode takes messages while working, through agent prompt", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "a-lane", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    pane.received.length = 0;
    w.calls.length = 0;
    expect(await send(d, "a-lane", "rebase on main first", "lead")).toBe("DELIVERED");
    expect(pane.received).toEqual(["rebase on main first"]);
    expect(w.calls).toContainEqual({ cmd: "herdr", argv: ["agent", "prompt", lane.paneId, "rebase on main first"] });
    expect(d.store.queued(lane.paneId)).toEqual([]);
  });

  test("a working lead still queues, and a blocked lane gets nothing typed", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "a-lane", brief, { workspace: "w1" });
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
    expect(w.calls.filter((c) => c.argv[1] === "prompt" || c.argv[1] === "send-text")).toEqual([]);
  });

  test("an omp pane that herdr refuses `agent prompt` for (agent_not_ready) still gets the text typed in", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    expect(await send(d, "lead", "hello\n\nlead", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello / lead"]);
    expect(w.calls).toContainEqual({ cmd: "herdr", argv: ["pane", "send-keys", "w1:p1", "enter"] });
  });

  test("a failing Enter is retried without typing the text again; after 3 failures it is thrown", async () => {
    const { w, d, lead } = setup();
    const enters = () => w.calls.filter((c) => c.argv[1] === "send-keys").length;
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    w.keyFails = 2;
    await d.herdr.deliver("w1:p1", "once");
    expect(lead.received).toEqual(["once"]);
    expect(enters()).toBe(3);
    w.keyFails = 5;
    await expect(d.herdr.deliver("w1:p1", "twice")).rejects.toThrow("key press failed");
    expect(lead.received).toEqual(["once", "twice"]);
    expect(enters()).toBe(6);
  });

  test("another `agent prompt` failure for a message that merely mentions agent_not_ready is still thrown", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", "herdr exploded");
    await expect(d.herdr.deliver("w1:p1", "a lane quoted agent_not_ready here")).rejects.toThrow("herdr exploded");
    expect(lead.received).toEqual([]);
  });

  test("the typed fallback trims leading and trailing newlines instead of leaving a dangling ' / '", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    await d.herdr.deliver("w1:p1", "\n\nhello\nworld\n\n");
    expect(lead.received).toEqual(["hello / world"]);
  });

  test("agent_not_ready on a pane that is now a plain shell types nothing and reports not delivered", async () => {
    const { w, d } = setup();
    const shell = w.addPane("w1:p7", "shell");
    w.promptFails.set("w1:p7", '{"error":{"code":"agent_not_ready"}}');
    await expect(d.herdr.deliver("w1:p7", "rm -rf nothing")).resolves.toBe(false);
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
    const lane = await startLane(d, "quiet", brief, { workspace: "w1" });
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

    const waiting = await startLane(d, "blocked-on-ci", brief, { workspace: "w1" });
    w.panes.get(waiting.paneId)!.status = "idle";
    await report(d, "blocked-on-ci", "WAITING: CI", "waiting");
    w.clock += 60 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "blocked-on-ci")).toEqual([]);
  });

  test("a failing inbox flush on one pane does not stop the loop for the other panes", async () => {
    const { w, d, lead } = setup();
    const broken = w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "to broken" });
    d.store.enqueue("w1:p1", { at: w.clock, from: "cli", text: "to lead" });
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p9", action: "delivery-ambiguous", detail: expect.stringContaining("herdr exploded") });
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    // Inbox panes come in directory order, which differs between file systems: the notice and "to lead" arrive as two
    // deliveries or as one batch. What matters is that both reach the lead, the notice exactly once.
    const toLead = lead.received.join("\n");
    expect(toLead).toContain("to lead");
    expect(toLead.split("[DELIVERY-AMBIGUOUS w1:p9]")).toHaveLength(2);
    expect(broken.received).toEqual([]);
  });

  test("a failing lane-phase delivery is recorded as lane-failed and does not stop the other lanes", async () => {
    const { w, d, brief } = setup();
    const lost = await startLane(d, "lost-lane", brief, { workspace: "w1" });
    const stuck = await startLane(d, "stuck-lane", brief, { workspace: "w1" });
    const fine = await startLane(d, "fine-lane", brief, { workspace: "w1" });
    w.panes.delete(lost.paneId);
    w.panes.get(stuck.paneId)!.status = "idle";
    w.panes.get(fine.paneId)!.status = "idle";
    w.promptFails.set("w1:p1", "lead exploded");
    w.promptFails.set(stuck.paneId, "stuck exploded");
    w.clock = fine.createdAt + 10 * 60_000;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "lost-lane", action: "lane-failed", detail: expect.stringContaining("lead exploded") });
    expect(events).toContainEqual({ lane: "stuck-lane", action: "lane-failed", detail: expect.stringContaining("stuck exploded") });
    expect(events).toContainEqual({ lane: "fine-lane", action: "nudge-1" });
    expect(w.panes.get(fine.paneId)!.received.at(-1)).toContain("No report from you for 10 minutes");
  });

  test("a LOST notice whose Enter failed once still reaches the lead on the next tick, exactly once", async () => {
    const { w, d, lead, brief } = setup();
    const gone = await startLane(d, "gone-lane", brief, { workspace: "w1" });
    lead.received.length = 0;
    w.panes.delete(gone.paneId);
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    w.keyFails = 3;
    expect(await dutyTick(d)).toContainEqual({ lane: "gone-lane", action: "lane-failed", detail: expect.stringContaining("key press failed") });
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
  });

  test("the delivery-ambiguous detail is herdr's first output line, never the queued message", async () => {
    const { w, d } = setup();
    w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded\nsecond line");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "SECRET queued message" });
    const events = await dutyTick(d);
    expect(events).toEqual([{ pane: "w1:p9", action: "delivery-ambiguous", detail: "herdr exploded" }]);
  });

  test("the duty loop prints a delivery-ambiguous line with the reason", async () => {
    const { w, d } = setup();
    w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "to broken" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "--once"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("DUTY w1:p9 delivery-ambiguous: ");
    expect(lines[0]).toContain("herdr exploded");
  });

  test("kill switch: a stopped duty loop flushes, nudges and escalates nothing; resume delivers what was held", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, { workspace: "w1" });
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
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(events).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(lead.received).toEqual(["held note"]);
  });

  test("a lane herdr reports working is still nudged when silent, through agent prompt; a report resets the ladder", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    w.calls.length = 0;
    w.clock = lane.createdAt + 5 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("busy")!.lastActivityAt).toBe(lane.createdAt);
    w.clock = lane.createdAt + 10 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("No report from you for 10 minutes");
    expect(w.calls.some((c) => c.cmd === "herdr" && c.argv[0] === "agent" && c.argv[1] === "prompt" && c.argv[2] === lane.paneId)).toBe(true);

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
    const blocked = await startLane(d, "dialog", brief, { workspace: "w1" });
    const waiting = await startLane(d, "on-ci", brief, { workspace: "w1" });
    w.panes.get(blocked.paneId)!.status = "blocked";
    w.panes.get(waiting.paneId)!.status = "working";
    await report(d, "on-ci", "WAITING: CI", "waiting");
    w.calls.length = 0;
    w.clock += 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("dialog")!.nudges).toBe(0);
    expect(d.store.lane("on-ci")!.nudges).toBe(0);
    expect(w.calls.filter((c) => c.argv[1] === "prompt" && (c.argv[2] === blocked.paneId || c.argv[2] === waiting.paneId))).toEqual([]);
  });

  test("a report from a paused lane is forwarded but never ends the pause", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "held", brief, { workspace: "w1" });
    const lane = d.store.lane("held")!;
    d.store.saveLane({ ...lane, status: "paused", pausedFrom: "working" });
    await report(d, "held", "WAITING: ci", "waiting");
    expect(d.store.lane("held")).toMatchObject({ status: "paused", pausedFrom: "working" });
    expect(lead.received.at(-1)).toContain("[REPORT held WAITING] WAITING: ci");
  });

  test("a vanished pane is reported LOST", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, { workspace: "w1" });
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(lead.received.at(-1)).toContain("[LOST busy]");
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
