import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentConfigError, agentCommand, ompProfile, selectAgent, TEST_AGENT_CMD_SWITCH, unsupportedAgent, unsupportedAgentCmd,
} from "../src/agent/profile.ts";
import { loadConfig } from "../src/config.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "seori-agent-"));

describe("agent: omp only", () => {
  test("omp is the default, and SEORI_AGENT or config.json may name it", () => {
    const home = tmp();
    expect(selectAgent(home, {})).toEqual({ profile: ompProfile, source: "default" });
    expect(selectAgent(home, { SEORI_AGENT: "omp" })).toEqual({ profile: ompProfile, source: "env" });
    writeFileSync(join(home, "config.json"), JSON.stringify({ agent: "omp", runtime: "hc", name: "x" }));
    expect(selectAgent(home, {})).toEqual({ profile: ompProfile, source: "config" });
    expect(selectAgent(home, { SEORI_AGENT: "" }).source).toBe("config");
    // the rest of seori reads the same config.json: agent and runtime are known keys there
    expect(loadConfig(home).name).toBe("x");
    expect(ompProfile.command).toBe("omp");
  });

  test("any other agent is refused with one line naming it", () => {
    const home = tmp();
    expect(() => selectAgent(home, { SEORI_AGENT: "claude" })).toThrow(AgentConfigError);
    expect(() => selectAgent(home, { SEORI_AGENT: "claude" })).toThrow('seori: agent "claude" is not supported; seori runs omp only');
    writeFileSync(join(home, "config.json"), JSON.stringify({ agent: "codex" }));
    expect(() => selectAgent(home, {})).toThrow('seori: agent "codex" is not supported; seori runs omp only');
    writeFileSync(join(home, "config.json"), JSON.stringify({ agent: 3 }));
    expect(() => selectAgent(home, {})).toThrow(unsupportedAgent(3));
    expect(unsupportedAgent(3)).toBe('seori: agent "3" is not supported; seori runs omp only');
    writeFileSync(join(home, "config.json"), "{");
    expect(() => selectAgent(home, {})).toThrow(/not valid JSON/);
  });

  test("the CLI refuses another agent before running any command: one stderr line, exit 2", async () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    // never address a real hc core or herdr session from here
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HC_") && !k.startsWith("HERDR_")));
    const run = async (home: string, extra: Record<string, string>) => {
      const p = Bun.spawn(["bun", cli, "lessons"], { env: { ...base, SEORI_HOME: home, ...extra }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code, out, err };
    };
    const fromEnv = await run(tmp(), { SEORI_AGENT: "omo" });
    expect(fromEnv).toEqual({ code: 2, out: "", err: 'seori: agent "omo" is not supported; seori runs omp only\n' });
    const home = tmp();
    writeFileSync(join(home, "config.json"), JSON.stringify({ agent: "claude" }));
    const fromConfig = await run(home, {});
    expect(fromConfig).toEqual({ code: 2, out: "", err: 'seori: agent "claude" is not supported; seori runs omp only\n' });
    const fromCmd = await run(tmp(), { SEORI_AGENT_CMD: "/usr/bin/claude" });
    expect(fromCmd).toEqual({ code: 2, out: "", err: 'seori: SEORI_AGENT_CMD "/usr/bin/claude" is not omp; seori runs omp only\n' });
    // the test switch in config.json is not the test switch: config.json never turns it on
    const switchInConfig = tmp();
    writeFileSync(join(switchInConfig, "config.json"), JSON.stringify({ [TEST_AGENT_CMD_SWITCH]: "1" }));
    expect(await run(switchInConfig, { SEORI_AGENT_CMD: "claude" })).toEqual({ code: 2, out: "", err: `${unsupportedAgentCmd("claude")}\n` });
  });

  test("SEORI_AGENT_CMD: an omp command is used, anything else is refused", () => {
    expect(agentCommand(ompProfile, {})).toBe("omp");
    expect(agentCommand(ompProfile, { SEORI_AGENT_CMD: "" })).toBe("omp");
    expect(agentCommand(ompProfile, { SEORI_AGENT_CMD: "omp" })).toBe("omp");
    expect(agentCommand(ompProfile, { SEORI_AGENT_CMD: "/opt/omp/bin/omp" })).toBe("/opt/omp/bin/omp");
    for (const cmd of ["claude", "/usr/bin/codex", "/opt/omp/bin/omp-wrapper", "omp ", "/x/omp/claude"]) {
      expect(() => agentCommand(ompProfile, { SEORI_AGENT_CMD: cmd })).toThrow(AgentConfigError);
      expect(() => agentCommand(ompProfile, { SEORI_AGENT_CMD: cmd })).toThrow(unsupportedAgentCmd(cmd));
    }
    expect(unsupportedAgentCmd("claude")).toBe('seori: SEORI_AGENT_CMD "claude" is not omp; seori runs omp only');
  });

  test("SEORI_AGENT_CMD: the test-only switch admits another command (the fake-omp fixture), only when it is exactly 1", () => {
    const fixture = "/repo/test/fixtures/fake-omp.ts";
    expect(agentCommand(ompProfile, { SEORI_AGENT_CMD: fixture, [TEST_AGENT_CMD_SWITCH]: "1" })).toBe(fixture);
    for (const value of ["", "0", "true", "yes"]) {
      expect(() => agentCommand(ompProfile, { SEORI_AGENT_CMD: fixture, [TEST_AGENT_CMD_SWITCH]: value })).toThrow(AgentConfigError);
    }
    // the switch alone changes nothing
    expect(agentCommand(ompProfile, { [TEST_AGENT_CMD_SWITCH]: "1" })).toBe("omp");
  });
});
