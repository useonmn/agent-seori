import { describe, expect, test } from "bun:test";
import { Herdr, HerdrError, interactiveShellInFront, shq, type Exec, type ExecResult } from "../src/herdr.ts";
import { shPath } from "../src/platform.ts";

// A recorder in place of the herdr binary: every argv is kept, and each reply is chosen per call.
function recorder(reply: (argv: readonly string[]) => ExecResult = () => ok({})) {
  const calls: (readonly string[])[] = [];
  const exec: Exec = async (cmd, argv) => {
    expect(cmd).toBe("herdr");
    calls.push(argv);
    return reply(argv);
  };
  return { calls, exec };
}
const ok = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const fail = (stderr: string, stdout = ""): ExecResult => ({ code: 1, stdout, stderr });
const pane = { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" };

describe("herdr argv", () => {
  test("a named session goes in front of every call; no session adds nothing", async () => {
    const named = recorder(() => ok({}));
    const h = new Herdr(named.exec, "iso");
    await h.run("w1:p1", "omp");
    await h.close("w1:p1");
    expect(named.calls).toEqual([
      ["--session", "iso", "pane", "run", "w1:p1", "omp"],
      ["--session", "iso", "pane", "close", "w1:p1"],
    ]);
    const plain = recorder();
    await new Herdr(plain.exec, "").close("w1:p1");
    expect(plain.calls).toEqual([["pane", "close", "w1:p1"]]);
  });

  test("agent start names the agent, kind omp, the pane and the timeout; omp args follow --", async () => {
    const r = recorder(() => ok({ agent: { name: "lane-w1p2", agent: "omp", agent_status: "idle" } }));
    const h = new Herdr(r.exec, "");
    await h.agentStart("lane-w1p2", "w1:p2", ["--append-system-prompt", "/p/lead.md"]);
    await h.agentStart("other-w1p3", "w1:p3", [], 5000);
    expect(r.calls).toEqual([
      ["agent", "start", "lane-w1p2", "--kind", "omp", "--pane", "w1:p2", "--timeout", "60000", "--", "--append-system-prompt", "/p/lead.md"],
      ["agent", "start", "other-w1p3", "--kind", "omp", "--pane", "w1:p3", "--timeout", "5000", "--"],
    ]);
    const busy = new Herdr(recorder(() => fail('{"error":{"code":"agent_pane_busy"}}')).exec, "");
    await expect(busy.agentStart("x-w1p2", "w1:p2", [])).rejects.toThrow("agent_pane_busy");
  });

  test("ompIntegration: true only for an omp line that is installed", async () => {
    const integration = (stdout: string) => new Herdr(recorder(() => ({ code: 0, stdout, stderr: "" })).exec, "iso").ompIntegration();
    expect(await integration("pi: not installed (/h/.pi/a.ts)\nomp: current (v10) (/h/.omp/agent/extensions/herdr-omp-agent-state.ts)\n")).toBe(true);
    expect(await integration("pi: current (v3) (/h/.pi/a.ts)\nomp: not installed (/h/.omp/agent/extensions/herdr-omp-agent-state.ts)\n")).toBe(false);
    expect(await integration("pi: current (v3) (/h/.pi/a.ts)\n")).toBe(false);
    const r = recorder(() => ({ code: 0, stdout: "omp: outdated (v9) (/h/x.ts)\n", stderr: "" }));
    expect(await new Herdr(r.exec, "iso").ompIntegration()).toBe(true);
    expect(r.calls).toEqual([["integration", "status"]]);
  });

  test("workspace, tab and split never take focus, and pass workspace and env as flags", async () => {
    const r = recorder((argv) => ok(argv[1] === "split" ? { pane } : { root_pane: pane }));
    const h = new Herdr(r.exec, "");
    expect(await h.createWorkspace("seori", "/w")).toEqual({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" });
    await h.createWorkspace("lead", "/w", { SEORI_HOME: "/h", SEORI_CMD: "bun '/s/cli.ts'" });
    await h.createTab("fix-login", "/w", "w3", { SEORI_LANE: "fix-login", NOTE: "a b" });
    await h.createTab("other", "/w");
    await h.split("w1:p1", "/w", { SEORI_ROLE: "duty" });
    expect(r.calls).toEqual([
      ["workspace", "create", "--label", "seori", "--cwd", "/w", "--no-focus"],
      ["workspace", "create", "--label", "lead", "--cwd", "/w", "--no-focus", "--env", "SEORI_HOME=/h", "--env", "SEORI_CMD=bun '/s/cli.ts'"],
      ["tab", "create", "--label", "fix-login", "--cwd", "/w", "--no-focus", "--workspace", "w3", "--env", "SEORI_LANE=fix-login", "--env", "NOTE=a b"],
      ["tab", "create", "--label", "other", "--cwd", "/w", "--no-focus"],
      ["pane", "split", "w1:p1", "--direction", "down", "--ratio", "0.3", "--cwd", "/w", "--no-focus", "--env", "SEORI_ROLE=duty"],
    ]);
  });

  test("a message is one argv element, delivered verbatim: quotes, $(...) and newlines are never expanded", async () => {
    const r = recorder((argv) => ok(argv[1] === "process-info" ? { process_info: { foreground_processes: [{ name: "omp", argv: ["omp"] }] } } : {}));
    const h = new Herdr(r.exec, "");
    const text = `it's "done" $(rm -rf ~) \`id\`\nline two`;
    expect(await h.deliver("w1:p1", text)).toBe(true);
    expect(r.calls).toEqual([["pane", "get", "w1:p1"], ["pane", "process-info", "--pane", "w1:p1"], ["agent", "prompt", "w1:p1", text]]);
  });
});

describe("herdr replies", () => {
  test("a create that returns no pane id throws instead of handing back an empty pane", async () => {
    const h = new Herdr(recorder(() => ok({ root_pane: { tab_id: "w1:t2" } })).exec, "");
    await expect(h.createTab("x", "/w")).rejects.toThrow("herdr did not return a pane id");
  });

  test("a failed call throws HerdrError with herdr's own reason, from stderr or else stdout", async () => {
    const onStdout = new Herdr(recorder(() => fail("", '{"error":{"code":"pane_not_found"}}\n')).exec, "iso");
    const e = await onStdout.close("w1:p7").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HerdrError);
    expect((e as HerdrError).message).toBe('herdr --session iso pane close w1:p7 failed (1): {"error":{"code":"pane_not_found"}}');
    const onStderr = new Herdr(recorder(() => fail("socket closed", "partial")).exec, "");
    await expect(onStderr.close("w1:p7")).rejects.toThrow("failed (1): socket closed");
  });

  test("a successful call whose output is not JSON reads as an empty result", async () => {
    const h = new Herdr(recorder(() => ({ code: 0, stdout: "ok\n", stderr: "" })).exec, "");
    await expect(h.run("w1:p1", "omp")).resolves.toBeUndefined();
  });

  test("status: pane_not_found is gone, but a herdr server that is down is an error, never a lost pane", async () => {
    const status = (reply: ExecResult) => new Herdr(recorder(() => reply).exec, "").status("w1:p1");
    expect(await status(fail('{"error":{"code":"pane_not_found","message":"pane w1:p1 not found"}}'))).toBe("gone");
    expect(await status(ok({}))).toBe("gone");
    await expect(status(fail('{"error":{"code":"server_not_running","message":"no herdr server is running"}}'))).rejects.toThrow(
      "server_not_running",
    );
  });

  test("status: no agent is a shell; herdr's four states pass through and anything else is unknown", async () => {
    const status = (p: Record<string, unknown>) => new Herdr(recorder(() => ok({ pane: p })).exec, "").status("w1:p1");
    expect(await status({ agent: null, agent_status: "idle" })).toBe("shell");
    for (const s of ["idle", "working", "blocked", "done"] as const) expect(await status({ agent: "omp", agent_status: s })).toBe(s);
    expect(await status({ agent: "omp", agent_status: "compacting" })).toBe("unknown");
    expect(await status({ agent: "omp" })).toBe("unknown");
  });
});

describe("shq", () => {
  test("a quoted word reaches a real shell unchanged, single quotes and $ included", async () => {
    for (const s of ["plain", "two words", "it's", "''", "$HOME `id` $(echo x)", "back\\slash", "new\nline", ""]) {
      const proc = Bun.spawn([shPath(), "-c", `printf %s ${shq(s)}`], { stdout: "pipe" });
      expect(await new Response(proc.stdout).text()).toBe(s);
    }
  });
});

describe("interactiveShellInFront (#66: a suspended agent leaves its shell in front)", () => {
  const front = (...procs: { name?: string; argv?: string[] }[]) => interactiveShellInFront({ foreground_processes: procs });
  test.each([
    ["login shell", [{ name: "-bash", argv: ["-bash"] }], true],
    ["interactive zsh by path, upper case", [{ name: "/bin/ZSH", argv: ["/bin/zsh", "-i"] }], true],
    ["bash -C (noclobber) is still interactive", [{ name: "bash", argv: ["bash", "-C"] }], true],
    ["busybox sh applet", [{ name: "busybox", argv: ["busybox", "sh"] }], true],
    ["shell entry without argv", [{ name: "fish" }], true],
    ["agent with a sh -c child", [{ name: "omp", argv: ["omp"] }, { name: "sh", argv: ["sh", "-c", "sleep 1"] }], false],
    ["shell running a script is held, the safe side", [{ name: "bash", argv: ["bash", "tool.sh"] }], true],
    ["interactive bash with --rcfile FILE", [{ name: "bash", argv: ["bash", "--rcfile", "/tmp/rc"] }], true],
    ["interactive zsh with -o OPT", [{ name: "zsh", argv: ["zsh", "-o", "vi"] }], true],
    ["login shell running a command: -lc", [{ name: "bash", argv: ["bash", "-lc", "make"] }], false],
    ["bash -f (noglob) is still interactive", [{ name: "bash", argv: ["bash", "-f"] }], true],
    ["bash --init-file F", [{ name: "bash", argv: ["bash", "--init-file", "/tmp/rc"] }], true],
    ["fish -C cmd (init command, still interactive)", [{ name: "fish", argv: ["fish", "-C", "set x 1"] }], true],
    ["bash -ic cmd runs a command", [{ name: "bash", argv: ["bash", "-ic", "make"] }], false],
    ["exec'd agent", [{ name: "bun", argv: ["bun", "omp.js"] }], false],
  ] as const)("%s", (_, procs, want) => {
    expect(front(...(procs as unknown as { name?: string; argv?: string[] }[]))).toBe(want);
  });
  test("an empty or missing process list is doubt", () => {
    expect(interactiveShellInFront({ foreground_processes: [] })).toBe(true);
    expect(interactiveShellInFront({})).toBe(true);
    expect(interactiveShellInFront(undefined)).toBe(true);
  });
});

describe("pane read, send-keys and the agent session path", () => {
  test("read asks for recent-unwrapped lines in the session and returns herdr's raw text", async () => {
    const r = recorder(() => ({ code: 0, stdout: " Goal mode paused.\n", stderr: "" }));
    expect(await new Herdr(r.exec, "iso").read("w1:p2", 200)).toBe(" Goal mode paused.\n");
    expect(r.calls).toEqual([["--session", "iso", "pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "200"]]);
    const failing = recorder(() => fail("pane_not_found"));
    expect(await new Herdr(failing.exec, "").read("w1:p2", 5).catch((e: unknown) => e)).toBeInstanceOf(HerdrError);
  });

  test("sendKeys passes herdr's key names", async () => {
    const r = recorder();
    await new Herdr(r.exec, "").sendKeys("w1:p2", "esc");
    expect(r.calls).toEqual([["pane", "send-keys", "w1:p2", "esc"]]);
  });

  test("agentSessionPath: agent_session of kind path, else undefined; a gone pane is undefined", async () => {
    const session = { agent: "omp", kind: "path", source: "herdr:omp", value: "/h/.omp/agent/sessions/x.jsonl" };
    const get = (agent_session: unknown) => recorder(() => ok({ pane: { pane_id: "w1:p2", agent: "omp", agent_status: "idle", agent_session } }));
    expect(await new Herdr(get(session).exec, "").agentSessionPath("w1:p2")).toBe("/h/.omp/agent/sessions/x.jsonl");
    expect(await new Herdr(get({ ...session, kind: "id" }).exec, "").agentSessionPath("w1:p2")).toBeUndefined();
    expect(await new Herdr(get(null).exec, "").agentSessionPath("w1:p2")).toBeUndefined();
    expect(await new Herdr(get({ ...session, value: "" }).exec, "").agentSessionPath("w1:p2")).toBeUndefined();
    expect(await new Herdr(recorder(() => fail("pane_not_found w1:p2")).exec, "").agentSessionPath("w1:p2")).toBeUndefined();
    expect(await new Herdr(recorder(() => fail("boom")).exec, "").agentSessionPath("w1:p2").catch((e: unknown) => e)).toBeInstanceOf(HerdrError);
  });
});
