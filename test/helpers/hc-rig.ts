// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// The hc adapter over the fake `hc` binary: a temp dir holds the `hc` shim (first and only hc on PATH), the fake's
// state and the argv it recorded. No HC_* variable reaches it, so no real core can be addressed.
import { afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HcRuntime } from "../../src/runtime/hc/index.ts";
import type { CreateSpec, SessionRef } from "../../src/runtime/types.ts";
import type { FakeKnobs, FakeState, FakeTerminal } from "./fake-hc.ts";

export const T1: SessionRef = { runtime: "hc", id: "t1" };
const SCRIPT = resolve(import.meta.dir, "fake-hc.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function terminal(over: Partial<FakeTerminal> = {}): FakeTerminal {
  return {
    state: "live",
    pid: 900,
    title: "omo lane",
    cwd: "/w",
    status: { state: "idle", app: "omo" },
    turn: 3,
    foreground: { name: "omo", argv: ["omo"], pid: 4242 },
    labels: {},
    ...over,
  };
}

export function rig(initial: Record<string, FakeTerminal> = {}, env: Record<string, string> = {}, knobs: FakeKnobs = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seori-fakehc-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nexec '${process.execPath}' '${SCRIPT}' "$@"\n`);
  chmodSync(join(bin, "hc"), 0o755);
  const statePath = join(dir, "state.json");
  const state: FakeState = { terminals: initial, knobs, next: Object.keys(initial).length + 1, sent: [] };
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(join(dir, "calls.jsonl"), "");
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  const rt = new HcRuntime(undefined, {
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_HC_DIR: dir, ...env },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: (line) => void logs.push(line),
  });
  const read = (): FakeState => JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
  return {
    rt,
    sleeps,
    logs,
    /** Each recorded argv without the leading --json. */
    calls: (): string[][] =>
      readFileSync(join(dir, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const a = JSON.parse(l) as string[];
          return a[0] === "--json" ? a.slice(1) : a;
        }),
    rawCalls: (): string[][] =>
      readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]),
    sent: () => read().sent,
    terminals: () => read().terminals,
  };
}

export const lane: CreateSpec = {
  name: "Lane K",
  cwd: "/w",
  env: { A: "1", B: "it's a b" },
  role: "lane",
  container: "tab",
  group: "g1",
};
export const SH = { SHELL: "/bin/zsh" };
