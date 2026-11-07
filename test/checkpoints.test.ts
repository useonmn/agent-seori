import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { Refusal } from "../src/harness.ts";
import { checkpointsPath, formatCheckpoints, formatCheckpointWrite, listCheckpoints, recordCheckpoint } from "../src/checkpoints.ts";

let root: string;
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const push = { step: "push", result: "pushed fix branch", evidence: ["https://github.com/o/r/pull/1"], remoteEffects: ["push:o/r@abc123"] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seori-checkpoints-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("checkpoints", () => {
  test("record writes one fsynced line outside lanes/ and list reads it back", () => {
    const w = recordCheckpoint(root, "fix-a", push, T0);
    expect(w).toEqual({ unchanged: false, checkpoint: { key: "fix-a", at: "2026-11-07T10:00:00.000Z", ...push } });
    expect(checkpointsPath(root, "fix-a")).toBe(join(root, "checkpoints", "fix-a.jsonl"));
    expect(listCheckpoints(root, "fix-a")).toEqual([w.checkpoint]);
    expect(existsSync(`${checkpointsPath(root, "fix-a")}.lock`)).toBe(false);
    expect(formatCheckpointWrite(w)).toBe("CHECKPOINT fix-a push recorded");
  });

  test("same step and data is a no-op; different data is refused", () => {
    const first = recordCheckpoint(root, "fix-a", push, T0);
    const again = recordCheckpoint(root, "fix-a", { ...push }, T0 + 60_000);
    expect(again).toEqual({ unchanged: true, checkpoint: first.checkpoint });
    expect(formatCheckpointWrite(again)).toBe("CHECKPOINT fix-a push unchanged (recorded 2026-11-07T10:00:00.000Z)");
    expect(readFileSync(checkpointsPath(root, "fix-a"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(() => recordCheckpoint(root, "fix-a", { ...push, result: "other" }, T0)).toThrow(/already recorded with different data/);
  });

  test("a remote-effect receipt is recorded once across steps", () => {
    recordCheckpoint(root, "fix-a", push, T0);
    expect(() => recordCheckpoint(root, "fix-a", { ...push, step: "push-again" }, T0)).toThrow(/remote effect push:o\/r@abc123 is already recorded by step push/);
    expect(() => recordCheckpoint(root, "fix-a", { ...push, step: "x", remoteEffects: ["r1", "r1"] }, T0)).toThrow(/listed twice/);
    // Another lane has its own journal.
    expect(recordCheckpoint(root, "fix-b", push, T0).unchanged).toBe(false);
  });

  test("input and key validation", () => {
    expect(() => recordCheckpoint(root, "Bad Key", push, T0)).toThrow(Refusal);
    expect(() => recordCheckpoint(root, "../x", push, T0)).toThrow(/invalid lane key/);
    expect(() => recordCheckpoint(root, "fix-a", { ...push, step: "" }, T0)).toThrow(/step must be one nonempty line/);
    expect(() => recordCheckpoint(root, "fix-a", { ...push, result: "a\nb" }, T0)).toThrow(/result/);
    expect(() => recordCheckpoint(root, "fix-a", { ...push, evidence: [] }, T0)).toThrow(/evidence/);
    expect(() => recordCheckpoint(root, "fix-a", { ...push, remoteEffects: [""] }, T0)).toThrow(/remote effect/);
    expect(existsSync(checkpointsPath(root, "fix-a"))).toBe(false);
  });

  test("a live writer's lock refuses; a dead writer's lock is taken over", () => {
    const path = checkpointsPath(root, "fix-a");
    mkdirSync(join(root, "checkpoints"), { recursive: true });
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), at: T0 }));
    expect(() => recordCheckpoint(root, "fix-a", push, T0)).toThrow(/locked by another writer/);
    expect(existsSync(path)).toBe(false);
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: dead, host: hostname(), at: T0 }));
    expect(recordCheckpoint(root, "fix-a", push, T0).unchanged).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a damaged journal line stops the read and the write, naming the line", () => {
    recordCheckpoint(root, "fix-a", push, T0);
    const path = checkpointsPath(root, "fix-a");
    appendFileSync(path, "{torn");
    expect(() => listCheckpoints(root, "fix-a")).toThrow(`${path}:2: not valid JSON`);
    expect(() => recordCheckpoint(root, "fix-a", { ...push, step: "merge", remoteEffects: [] }, T0)).toThrow(/:2: not valid JSON/);
    expect(existsSync(`${path}.lock`)).toBe(false);
    writeFileSync(path, `${JSON.stringify({ key: "fix-b", at: "2026-11-07T10:00:00.000Z", ...push })}\n`);
    expect(() => listCheckpoints(root, "fix-a")).toThrow(/recorded for lane "fix-b"/);
    const rec = JSON.stringify({ key: "fix-a", at: "2026-11-07T10:00:00.000Z", ...push });
    writeFileSync(path, `${rec}\n${rec}\n`);
    expect(() => listCheckpoints(root, "fix-a")).toThrow(/step push recorded twice/);
  });

  test("formatter", () => {
    expect(formatCheckpoints("fix-a", listCheckpoints(root, "fix-a"))).toEqual(["EMPTY fix-a"]);
    recordCheckpoint(root, "fix-a", push, T0);
    recordCheckpoint(root, "fix-a", { step: "tests", result: "bun test green", evidence: ["/tmp/t.log", "/tmp/u.log"], remoteEffects: [] }, T0 + 1000);
    expect(formatCheckpoints("fix-a", listCheckpoints(root, "fix-a"))).toEqual([
      "2026-11-07T10:00:00.000Z push: pushed fix branch",
      "  evidence: https://github.com/o/r/pull/1",
      "  remote effects: push:o/r@abc123",
      "2026-11-07T10:00:01.000Z tests: bun test green",
      "  evidence: /tmp/t.log /tmp/u.log",
    ]);
  });
});
