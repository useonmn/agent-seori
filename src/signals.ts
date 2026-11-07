import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Refusal, type Deps } from "./harness.ts";
import type { ExecResult } from "./herdr.ts";
import type { Lane } from "./store.ts";

// A lane's `Done =` line: signals seori reads back live before the lane may close, so a done claim is never taken on
// the lane's word. Signals are joined by `;` (a `;` inside quotes, brackets or braces belongs to its signal):
//   merged owner/repo#N            the PR is merged (state MERGED with a merge commit)
//   closed owner/repo#N            the issue is closed
//   published pkg@version          the npm registry has that version
//   command ["argv",...] [stdout~"regex"]   exits 0 (run with no shell in the lane's cwd, 2 min at most)
//   file <path> [sha256=<hex>] [json:.a.b=<json>]   exists (relative to the lane's cwd), with that hash / field value
//   url <http(s)url> [status=N] [body~"regex"]      a GET answers that status (default 200) within 15 s
// `command ["true"]` parses but proves nothing; a Done line should name the outcome itself (a merged PR, a file).

export type Signal =
  | { readonly kind: "merged" | "closed"; readonly repo: string; readonly n: number }
  | { readonly kind: "published"; readonly pkg: string; readonly version: string }
  | { readonly kind: "command"; readonly argv: readonly string[]; readonly stdout?: RegExp }
  | { readonly kind: "file"; readonly path: string; readonly sha256?: string; readonly json?: { readonly path: readonly (string | number)[]; readonly value: unknown } }
  | { readonly kind: "url"; readonly url: string; readonly status: number; readonly body?: RegExp };

export const COMMAND_TIMEOUT_MS = 120_000;
export const URL_TIMEOUT_MS = 15_000;

export const SIGNAL_GRAMMAR = [
  "merged <owner/repo>#N | closed <owner/repo>#N | published <pkg>@<version>",
  'command ["argv","as","json"] [stdout~"regex"]',
  "file <path> [sha256=<hex>] [json:.a.b=<json value>]",
  'url <http(s) url> [status=200] [body~"regex"]',
].join(" | ");

/** How a signal's command and URL are run. Tests replace both; gh, npm and git go through Deps.exec. */
export type SignalIo = {
  readonly run: (argv: readonly string[], opts: { cwd: string; timeoutMs: number }) => Promise<ExecResult>;
  readonly get: (url: string, timeoutMs: number) => Promise<{ status: number; body: string }>;
};

export const defaultSignalIo: SignalIo = {
  run: async (argv, { cwd, timeoutMs }) => {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      // Its own process group, so a timeout kills whatever it started too.
      proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
    } catch (e) {
      // A missing executable is a failed signal, not a crash of the close.
      return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
    const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const { promise: timedOut, resolve } = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    try {
      const r = await Promise.race([finished, timedOut]);
      if (r !== "timeout") return { code: r[2], stdout: r[0], stderr: r[1] };
      // A child that ignores SIGTERM, or a grandchild holding the pipes open, must not hold up the close.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      finished.catch(() => {});
      return { code: 124, stdout: "", stderr: `timed out after ${timeoutMs / 1000} s` };
    } finally {
      clearTimeout(timer);
    }
  },
  get: async (url, timeoutMs) => {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    return { status: res.status, body: await res.text() };
  },
};

class SyntaxProblem extends Error {}

/** Reads one JSON value (a string, array or object, else a bare token) starting at s[i]. */
function readJson(s: string, i: number): { value: unknown; end: number } {
  const open = s[i];
  let end = i;
  if (open === '"') {
    end++;
    while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
    end++;
  } else if (open === "[" || open === "{") {
    let depth = 0;
    for (; end < s.length; end++) {
      const c = s[end];
      if (c === '"') {
        end++;
        while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
      } else if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && --depth === 0) break;
    }
    end++;
  } else {
    while (end < s.length && !/\s/.test(s[end] ?? "")) end++;
  }
  const text = s.slice(i, end);
  try {
    return { value: JSON.parse(text), end };
  } catch {
    if (open === '"' || open === "[" || open === "{") throw new SyntaxProblem(`not valid JSON at ${text.slice(0, 40)}`);
    return { value: text, end };
  }
}

/** The signals of a Done line (an optional leading `Done =` is dropped), split on `;` outside quotes and brackets. */
export function splitDone(line: string): string[] {
  const body = line.replace(/^\s*Done\s*=\s*/i, "");
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      i++;
      while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

type Opt = { key: string; op: "=" | "~"; value: unknown };

function readOptions(s: string, i: number): Opt[] {
  const opts: Opt[] = [];
  while (i < s.length) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (i >= s.length) break;
    const m = /^([a-z0-9_]+(?::[^=~\s]+)?)([=~])/i.exec(s.slice(i));
    if (!m?.[1] || !m[2]) throw new SyntaxProblem(`expected key=value or key~"regex" at ${s.slice(i, i + 30)}`);
    i += m[0].length;
    const r = readJson(s, i);
    opts.push({ key: m[1], op: m[2] as "=" | "~", value: r.value });
    i = r.end;
  }
  return opts;
}

function regex(o: Opt | undefined, what: string): RegExp | undefined {
  if (!o) return undefined;
  if (o.op !== "~" || typeof o.value !== "string") throw new SyntaxProblem(`${what} takes ~"regex"`);
  try {
    return new RegExp(o.value);
  } catch {
    throw new SyntaxProblem(`${what}: invalid regex ${o.value}`);
  }
}

function onlyKeys(opts: readonly Opt[], allowed: (k: string) => boolean, kind: string): void {
  const bad = opts.find((o) => !allowed(o.key));
  if (bad) throw new SyntaxProblem(`${kind}: unknown option ${bad.key}`);
}

function parseSignal(s: string): Signal {
  const gh = /^(merged|closed)\s+([\w.-]+\/[\w.-]+)(?:#|\/(?:pull|issues)\/)(\d+)$/i.exec(s);
  if (gh?.[1] && gh[2] && gh[3]) return { kind: gh[1].toLowerCase() as "merged" | "closed", repo: gh[2], n: Number(gh[3]) };
  const pub = /^published\s+(\S+)@(\S+)$/i.exec(s);
  if (pub?.[1] && pub[2]) return { kind: "published", pkg: pub[1], version: pub[2] };
  const head = /^(command|file|url)\s+/i.exec(s);
  if (!head?.[1]) throw new SyntaxProblem(`unreadable signal; use one of: ${SIGNAL_GRAMMAR}`);
  const kind = head[1].toLowerCase();
  const at = head[0].length;
  if (kind === "command") {
    if (s[at] !== "[") throw new SyntaxProblem('command takes a JSON argv array, e.g. command ["bun","test"]');
    const { value, end } = readJson(s, at);
    if (!Array.isArray(value) || !value.length || !value.every((a) => typeof a === "string" && a.length > 0)) {
      throw new SyntaxProblem("command argv must be a nonempty array of nonempty strings");
    }
    const opts = readOptions(s, end);
    onlyKeys(opts, (k) => k === "stdout", "command");
    const stdout = regex(opts.find((o) => o.key === "stdout"), "stdout");
    return { kind: "command", argv: value as string[], ...(stdout ? { stdout } : {}) };
  }
  if (kind === "file") {
    const bare = /^\S+/.exec(s.slice(at))?.[0] ?? "";
    const tok = s[at] === '"' ? readJson(s, at) : { value: bare, end: at + bare.length };
    if (typeof tok.value !== "string" || !tok.value) throw new SyntaxProblem("file needs a path");
    const opts = readOptions(s, tok.end);
    onlyKeys(opts, (k) => k === "sha256" || k.startsWith("json:"), "file");
    const sha = opts.find((o) => o.key === "sha256");
    if (sha && (sha.op !== "=" || typeof sha.value !== "string" || !/^[0-9a-f]{64}$/i.test(sha.value))) {
      throw new SyntaxProblem("sha256= takes 64 hex characters");
    }
    const js = opts.find((o) => o.key.startsWith("json:"));
    if (js && js.op !== "=") throw new SyntaxProblem("json:<path> takes =<json value>");
    const path = js ? js.key.slice(5).replace(/^\./, "").split(".").filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
    if (js && !path.length) throw new SyntaxProblem("json: needs a field path like json:.version");
    return {
      kind: "file", path: tok.value,
      ...(sha ? { sha256: String(sha.value).toLowerCase() } : {}),
      ...(js ? { json: { path, value: js.value } } : {}),
    };
  }
  const url = /^\S+/.exec(s.slice(at))?.[0] ?? "";
  if (!/^https?:\/\/\S+$/i.test(url)) throw new SyntaxProblem("url needs an http(s) URL");
  const opts = readOptions(s, at + url.length);
  onlyKeys(opts, (k) => k === "status" || k === "body", "url");
  const st = opts.find((o) => o.key === "status");
  if (st && (st.op !== "=" || !Number.isInteger(st.value))) throw new SyntaxProblem("status= takes an integer");
  const body = regex(opts.find((o) => o.key === "body"), "body");
  return { kind: "url", url, status: st ? Number(st.value) : 200, ...(body ? { body } : {}) };
}

/** Parses a Done line. Refuses an empty line and any signal outside the grammar, naming the signal and the problem. */
export function parseDone(line: string): Signal[] {
  const parts = splitDone(line);
  if (!parts.length) throw new Refusal(`empty Done line; use signals joined by ";": ${SIGNAL_GRAMMAR}`);
  const problems: string[] = [];
  const signals: Signal[] = [];
  for (const p of parts) {
    try {
      signals.push(parseSignal(p));
    } catch (e) {
      if (!(e instanceof SyntaxProblem)) throw e;
      problems.push(`${p} -> ${e.message}`);
    }
  }
  if (problems.length) throw new Refusal(`bad Done line: ${problems.join("; ")}`);
  return signals;
}

const short = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 120)}...` : one;
};

const resolvePath = (p: string, cwd: string): string => {
  const home = homedir();
  const expanded = p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : join(cwd, expanded);
};

function dig(v: unknown, path: readonly (string | number)[]): { found: boolean; value: unknown } {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object" || !(k in (cur as object))) return { found: false, value: undefined };
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return { found: true, value: cur };
}

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Why the signal does not read back live, or undefined when it does. */
async function signalFailure(d: Deps, sig: Signal, cwd: string, io: SignalIo): Promise<string | undefined> {
  switch (sig.kind) {
    case "merged": {
      const r = await d.exec("gh", ["pr", "view", String(sig.n), "--repo", sig.repo, "--json", "state,mergeCommit"]);
      if (r.code !== 0) return `gh: ${short(r.stderr || r.stdout) || `exit ${r.code}`}`;
      const j = parsedJson(r.stdout) as { state?: string; mergeCommit?: { oid?: string } | null } | undefined;
      if (j?.state === "MERGED" && j.mergeCommit?.oid) return undefined;
      return `state ${j?.state ?? "unknown"}${j?.state === "MERGED" ? " without a merge commit" : ""}`;
    }
    case "closed": {
      const r = await d.exec("gh", ["issue", "view", String(sig.n), "--repo", sig.repo, "--json", "state"]);
      if (r.code !== 0) return `gh: ${short(r.stderr || r.stdout) || `exit ${r.code}`}`;
      const state = (parsedJson(r.stdout) as { state?: string } | undefined)?.state;
      return state === "CLOSED" ? undefined : `state ${state ?? "unknown"}`;
    }
    case "published": {
      const r = await d.exec("npm", ["view", `${sig.pkg}@${sig.version}`, "version", "--json"]);
      // Newer npm prints `version --json` as an array, older npm as a bare string; nothing at all when no version matches.
      const versions = r.code === 0 ? [parsedJson(r.stdout)].flat() : [];
      return versions.includes(sig.version) ? undefined : `registry has no ${sig.pkg}@${sig.version}${r.code !== 0 ? `: ${short(r.stderr || r.stdout)}` : ""}`;
    }
    case "command": {
      const r = await io.run(sig.argv, { cwd, timeoutMs: COMMAND_TIMEOUT_MS });
      if (r.code !== 0) return `exit ${r.code}: ${short(r.stderr || r.stdout) || "no output"}`;
      if (sig.stdout && !sig.stdout.test(r.stdout)) return `exit 0 but stdout does not match ${sig.stdout}: ${short(r.stdout) || "(empty)"}`;
      return undefined;
    }
    case "file": {
      const path = resolvePath(sig.path, cwd);
      if (!existsSync(path)) return `missing: ${path}`;
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (e) {
        return `unreadable: ${path} (${short(e instanceof Error ? e.message : String(e))})`;
      }
      if (sig.sha256) {
        const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        if (got !== sig.sha256) return `sha256 ${got.slice(0, 12)}... is not ${sig.sha256.slice(0, 12)}...`;
      }
      if (sig.json) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          return `not JSON: ${path}`;
        }
        const field = `.${sig.json.path.join(".")}`;
        const hit = dig(parsed, sig.json.path);
        if (!hit.found) return `no field ${field}`;
        const want = JSON.stringify(sig.json.value);
        if (JSON.stringify(hit.value) !== want) return `${field} is ${short(JSON.stringify(hit.value))}, want ${want}`;
      }
      return undefined;
    }
    case "url": {
      let res: { status: number; body: string };
      try {
        res = await io.get(sig.url, URL_TIMEOUT_MS);
      } catch (e) {
        return `request failed: ${short(e instanceof Error ? e.message : String(e))}`;
      }
      if (res.status !== sig.status) return `status ${res.status}, want ${sig.status}`;
      if (sig.body && !sig.body.test(res.body)) return `status ${res.status} but body does not match ${sig.body}`;
      return undefined;
    }
  }
}

const git = (d: Deps, dir: string, ...argv: string[]): Promise<ExecResult> => d.exec("git", ["-C", dir, ...argv]);

/**
 * The lane's own git worktrees: those listed by `git worktree list` from its cwd whose branch or directory is named
 * after the lane key (`<key>` or `<key>-...`), a detached one by its directory alone. A name that is another open
 * lane's (`<key>-v2` or `<key>-v2-...` while lane `<key>-v2` is open) is that lane's. The main checkout is never one.
 */
export async function laneWorktrees(d: Deps, lane: Lane): Promise<string[]> {
  const r = await git(d, lane.cwd, "worktree", "list", "--porcelain");
  if (r.code !== 0) return [];
  const named = (name: string, key: string): boolean => name === key || name.startsWith(`${key}-`);
  const others = d.store.lanes()
    .filter((l) => l.key !== lane.key && l.status !== "done" && l.status !== "lost" && named(l.key, lane.key))
    .map((l) => l.key);
  const ours = (name: string): boolean => named(name, lane.key) && !others.some((o) => named(name, o));
  const found: string[] = [];
  let path = "";
  let branch = "";
  const endRecord = (): void => {
    if (path && path !== lane.cwd && !found.includes(path) && (ours(branch) || ours(path.split("/").pop() ?? ""))) found.push(path);
    path = "";
    branch = "";
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      endRecord();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) branch = line.split("/").pop() ?? "";
    else if (line === "") endRecord();
  }
  endRecord();
  return found;
}

/**
 * Tracked work that would be lost by closing: uncommitted changes to tracked files, or commits on no remote. A lane
 * with worktrees of its own is checked there (its cwd is then the human's checkout, which must not block it); else
 * its cwd, when that is a git checkout. A repository with no remote at all (local-only work) has nowhere to push, so
 * only its uncommitted changes count.
 */
export async function unpushedWork(d: Deps, lane: Lane): Promise<string[]> {
  const owned = await laneWorktrees(d, lane);
  const roots = owned.length ? owned : [lane.cwd];
  const reasons: string[] = [];
  for (const dir of roots) {
    if (!existsSync(dir)) {
      if (owned.length) reasons.push(`unpushed work in ${dir} (worktree missing)`);
      continue;
    }
    if (!owned.length) {
      const inside = await git(d, dir, "rev-parse", "--is-inside-work-tree");
      if (inside.code !== 0 || inside.stdout.trim() !== "true") continue;
    }
    const dirty = await git(d, dir, "status", "--porcelain", "--untracked-files=no");
    const remotes = await git(d, dir, "remote");
    if (dirty.code !== 0 || remotes.code !== 0) {
      reasons.push(`unpushed work in ${dir} (git state unreadable)`);
      continue;
    }
    if (dirty.stdout.trim()) {
      reasons.push(`uncommitted tracked changes in ${dir}`);
      continue;
    }
    if (!remotes.stdout.trim()) continue;
    const ahead = await git(d, dir, "rev-list", "--count", "HEAD", "--not", "--remotes");
    if (ahead.code !== 0) reasons.push(`unpushed work in ${dir} (git state unreadable)`);
    else if (Number(ahead.stdout.trim()) > 0) reasons.push(`${ahead.stdout.trim()} commit(s) on no remote in ${dir}`);
  }
  return reasons;
}

/**
 * Why the lane may not close (empty: it may): every signal of its Done line read back live (each failure as
 * `<signal> -> <why>`), then tracked work in its cwd or worktrees that is uncommitted or on no remote. A lane with
 * no Done line has only the second check. A Done line that no longer parses is one failure, never a pass.
 */
export async function checkSignals(d: Deps, lane: Lane, io: SignalIo = defaultSignalIo): Promise<string[]> {
  const failures: string[] = [];
  if (lane.done !== undefined) {
    const parts = splitDone(lane.done);
    if (!parts.length) failures.push("empty Done line");
    const results = await Promise.all(parts.map(async (p) => {
      let sig: Signal;
      try {
        sig = parseSignal(p);
      } catch (e) {
        return `${p} -> ${e instanceof Error ? e.message : String(e)}`;
      }
      try {
        const why = await signalFailure(d, sig, lane.cwd, io);
        return why === undefined ? undefined : `${p} -> ${why}`;
      } catch (e) {
        return `${p} -> ${short(e instanceof Error ? e.message : String(e))}`;
      }
    }));
    for (const r of results) if (r !== undefined) failures.push(r);
  }
  failures.push(...(await unpushedWork(d, lane)));
  return failures;
}
