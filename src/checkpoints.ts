/**
 * Checkpoints: a lane's journal of completed steps, so a lane resumed after a crash or restart knows what is done and
 * never repeats a remote side effect (a push, merge or deploy). The journal is `$SEORI_HOME/checkpoints/<key>.jsonl`
 * (outside `lanes/`, whose `<key>.json` files are the lane records). Each step is recorded once: recording the same
 * step again with the same data is a no-op, with different data it is refused, and a remote-effect receipt already
 * recorded under another step is refused. Writes hold a lock file and are fsynced before they are acknowledged.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { Refusal } from "./harness.ts";
import { KEY_RE, lockFile } from "./store.ts";

export type CheckpointInput = {
  /** Unique step id within the lane. */
  readonly step: string;
  readonly result: string;
  /** Paths or URLs showing the step's result; at least one. */
  readonly evidence: readonly string[];
  /** Receipts of completed remote side effects (push, merge, deploy, ...); each names one effect, so it is recorded once. */
  readonly remoteEffects: readonly string[];
};
export type Checkpoint = CheckpointInput & { readonly key: string; /** ISO time it was recorded. */ readonly at: string };
export type CheckpointWrite = { readonly checkpoint: Checkpoint; /** True when the same step and data were already recorded. */ readonly unchanged: boolean };

const line = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);
const lines = (v: unknown): v is string[] => Array.isArray(v) && v.every(line);

/** The first rule an input breaks, or undefined. */
const problemOf = (input: CheckpointInput): string | undefined => {
  if (!line(input.step)) return "step must be one nonempty line";
  if (!line(input.result)) return "result must be one nonempty line";
  if (!lines(input.evidence) || input.evidence.length === 0) return "evidence must be one or more nonempty lines";
  if (!lines(input.remoteEffects)) return "each remote effect must be one nonempty line";
  const repeated = input.remoteEffects.find((r, i) => input.remoteEffects.indexOf(r) !== i);
  if (repeated !== undefined) return `remote effect ${repeated} is listed twice`;
  return undefined;
};

// Field order fixed, so two inputs with the same data compare equal as text.
const payload = (v: CheckpointInput): string =>
  JSON.stringify({ step: v.step, result: v.result, evidence: v.evidence, remoteEffects: v.remoteEffects });

/** Journal path of a lane; refuses a key that is not a lane key, so no key can name a path outside the directory. */
export function checkpointsPath(root: string, key: string): string {
  if (!KEY_RE.test(key)) throw new Refusal(`invalid lane key ${JSON.stringify(key)}: must match ${KEY_RE}`);
  return join(root, "checkpoints", `${key}.jsonl`);
}

/**
 * The lane's recorded checkpoints in order. A damaged line (bad JSON, missing field, wrong key, duplicate step) throws
 * naming it: a journal that cannot be fully read must stop the resume, not silently drop a step and repeat its effect.
 */
export function listCheckpoints(root: string, key: string): Checkpoint[] {
  const path = checkpointsPath(root, key);
  if (!existsSync(path)) return [];
  const steps = new Set<string>();
  const out: Checkpoint[] = [];
  for (const [index, text] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!text.trim()) continue;
    const fail = (why: string): never => {
      throw new Error(`${path}:${index + 1}: ${why}; fix or remove the line before resuming`);
    };
    let value: Checkpoint;
    try {
      value = JSON.parse(text) as Checkpoint;
    } catch {
      return fail("not valid JSON");
    }
    if (typeof value !== "object" || value === null) fail("not a checkpoint record");
    const problem = problemOf(value);
    if (problem) fail(problem);
    if (value.key !== key) fail(`recorded for lane ${JSON.stringify(value.key)}`);
    if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) fail("invalid time");
    if (steps.has(value.step)) fail(`step ${value.step} recorded twice`);
    steps.add(value.step);
    out.push(value);
  }
  return out;
}

/**
 * Records a completed step under the lane's journal lock. Same step and data again: returns it with unchanged=true and
 * writes nothing. Same step with different data, or a remote-effect receipt already recorded by another step: refused.
 * The record is fsynced (and the directory too when the journal is new) before returning. A lock held by a live
 * writer throws; a lock left by a dead writer is taken over (store.ts lockFile).
 */
export function recordCheckpoint(root: string, key: string, input: CheckpointInput, now: number): CheckpointWrite {
  const path = checkpointsPath(root, key);
  const problem = problemOf(input);
  if (problem) throw new Refusal(`checkpoint: ${problem}`);
  mkdirSync(dirname(path), { recursive: true });
  // The step check runs under the lock, so two writers cannot both record a step or both replay a remote effect.
  const release = lockFile(`${path}.lock`, now);
  if (!release) throw new Error(`checkpoint journal of ${key} is locked by another writer; retry`);
  try {
    const recorded = listCheckpoints(root, key);
    const previous = recorded.find((c) => c.step === input.step);
    if (previous) {
      if (payload(previous) !== payload(input)) throw new Refusal(`checkpoint step ${input.step} is already recorded with different data`);
      return { checkpoint: previous, unchanged: true };
    }
    for (const c of recorded) {
      const repeated = input.remoteEffects.find((r) => c.remoteEffects.includes(r));
      if (repeated !== undefined) throw new Refusal(`remote effect ${repeated} is already recorded by step ${c.step}`);
    }
    const checkpoint: Checkpoint = { key, at: new Date(now).toISOString(), ...(JSON.parse(payload(input)) as CheckpointInput) };
    const created = !existsSync(path);
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(checkpoint)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A new journal's directory entry must be durable too, or a crash could lose an acknowledged first checkpoint.
    if (created) {
      const dir = openSync(dirname(path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
    return { checkpoint, unchanged: false };
  } finally {
    release();
  }
}

/** The line `checkpoint` prints: `CHECKPOINT <key> <step> recorded` or `... unchanged (recorded <at>)`. */
export const formatCheckpointWrite = (w: CheckpointWrite): string =>
  `CHECKPOINT ${w.checkpoint.key} ${w.checkpoint.step} ${w.unchanged ? `unchanged (recorded ${w.checkpoint.at})` : "recorded"}`;

/**
 * The lines `checkpoints` prints: per step `<at> <step>: <result>` with indented evidence and remote-effect lines;
 * `EMPTY <key>` when nothing is recorded.
 */
export function formatCheckpoints(key: string, checkpoints: readonly Checkpoint[]): string[] {
  if (checkpoints.length === 0) return [`EMPTY ${key}`];
  return checkpoints.flatMap((c) => [
    `${c.at} ${c.step}: ${c.result}`,
    `  evidence: ${c.evidence.join(" ")}`,
    ...(c.remoteEffects.length ? [`  remote effects: ${c.remoteEffects.join(" ")}`] : []),
  ]);
}
