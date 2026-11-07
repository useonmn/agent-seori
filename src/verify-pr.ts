import { identityFor, type RepoIdentity, type SeoriConfig } from "./config.ts";
import type { Deps, PrRef } from "./harness.ts";

// verify-pr: reads a PR back from GitHub and checks the rules a merge relies on. Every commit's author and committer
// email must be the identity configured for the repo, and a PR whose `fix:` commits change source must change a test
// too, or say why not in a `No test: <reason>` body line. The PR is read before and after the commit walk; if its head,
// body or commit count moved in between, the result is a failure, never a verdict on a half-read PR.

export type CommitIdentity = { readonly name: string; readonly email: string };
export type PrFile = { readonly filename: string; readonly status: string; readonly previous_filename?: string };
export type PrCommit = {
  readonly sha: string;
  readonly commit: { readonly message: string; readonly author: CommitIdentity | null; readonly committer: CommitIdentity | null };
  readonly files: readonly PrFile[];
  readonly parents?: readonly { readonly sha: string }[];
};
/** Everything verify-pr judges, as read from the GitHub API. */
export type PrSnapshot = {
  readonly repo: string;
  readonly number: number;
  readonly body: string | null;
  readonly head: string;
  readonly commits: readonly PrCommit[];
  /** The PR's combined file list (the diff against its base). */
  readonly files: readonly PrFile[];
};

/** Each `gh api` call gets this long before verify-pr gives up on it. */
export const GH_TIMEOUT_MS = 120_000;

const NOREPLY = "noreply@github.com";
const SHA_RE = /^[a-f0-9]{40}$/i;
const PAGE = 100;
// GitHub returns at most 3000 files for a commit or a PR (30 pages of 100).
const MAX_FILE_PAGES = 30;

// Fixture, helper, fake and mock directories never hold counted tests; a file with one of those names counts only when
// it is named as a test (helpers.test.ts), not when it merely sits in a test directory (test/fakes.ts).
/** Whether a changed path counts as a test file. */
export const isTestFile = (path: string): boolean =>
  !/(?:^|\/)(?:fixtures?|__fixtures__|__snapshots__|helpers?|fakes?|mocks?)\//i.test(path)
  && (/(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$/i.test(path)
    || /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:go|py))$/i.test(path)
    || (/(?:^|\/)(?:tests?|__tests__)\//i.test(path) && /\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$/i.test(path)
      && !/(?:^|\/)(?:(?:setup|conftest|test-utils)[./]|(?:fixtures?|helpers?|fakes?|mocks?)\.[^/]*$)/i.test(path)));

/** Whether a changed path counts as source: code or styles, outside tests, docs and fixtures. */
export const isSourceFile = (path: string): boolean =>
  !isTestFile(path) && !/(?:^|\/)(?:docs?|fixtures?|__fixtures__|__snapshots__)\//i.test(path)
  && /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html|vue|svelte|py|go|rs|rb|sh|sql|c|cpp|h|java|kt|swift)$/i.test(path);

const changesTest = (file: PrFile): boolean =>
  ["added", "modified", "renamed", "copied", "changed"].includes(file.status) && isTestFile(file.filename);

/** verify-pr's verdict: `lines` is exactly what `seori verify-pr` prints, one entry per line. */
export type VerifyPrResult = { readonly ok: boolean; readonly lines: string[] };

/**
 * Judges a PR already read from GitHub. `identity` undefined: the repo has no `repoIdentities` entry, so commit
 * identities are not checked (a line says so) and only the test rule applies. Lines: the `PASS|FAIL <repo>#<n> at
 * <sha>` headline, then `- <failure>` lines, `IDENTITY skipped (...)` and `WARNING <note>` lines.
 */
export function checkPr(snapshot: PrSnapshot, identity: RepoIdentity | undefined): VerifyPrResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (snapshot.commits.length === 0) errors.push("PR has no commits to verify");
  let fixesSource = false;
  for (const c of snapshot.commits) {
    if (identity) {
      for (const role of ["author", "committer"] as const) {
        const actual = c.commit[role];
        const email = typeof actual?.email === "string" ? actual.email.trim() : "";
        if (!email) {
          errors.push(`${c.sha}: missing ${role} email; expected ${identity.email}`);
          continue;
        }
        const ok = email.toLowerCase() === NOREPLY
          // GitHub commits merge commits made in its UI as noreply; that is the only place noreply is accepted.
          ? role === "committer" && (c.parents?.length ?? 0) > 1
          : email.toLowerCase() === identity.email.toLowerCase();
        if (!ok) errors.push(`${c.sha}: wrong ${role} email ${email}; expected ${identity.email}${role === "committer" ? ` (or ${NOREPLY} for a merge commit)` : ""}`);
      }
    }
    const fixesThisSource = /^fix(?:\([^)]+\))?!?:/.test(c.commit.message)
      && c.files.some((f) => isSourceFile(f.filename) || (f.previous_filename !== undefined && isSourceFile(f.previous_filename)));
    if (fixesThisSource) {
      fixesSource = true;
      if (!c.files.some(changesTest)) warnings.push(`${c.sha}: fix commit changes source without its own added/changed test; coverage is judged across the PR`);
    }
  }
  if (fixesSource && !snapshot.files.some(changesTest)) {
    const message = "PR has source fix commits but no added/changed test";
    const reason = /^No test:[ \t]*(\S[^\r\n]*)$/m.exec(snapshot.body ?? "")?.[1]?.trim();
    if (reason) warnings.push(`${message}; No test: ${reason}`);
    else errors.push(`${message}; add a test or a nonempty "No test: <reason>" line to the PR body`);
  }
  const ok = errors.length === 0;
  return {
    ok,
    lines: [
      `${ok ? "PASS" : "FAIL"} ${snapshot.repo}#${snapshot.number} at ${snapshot.head}`,
      ...errors.map((e) => `- ${e}`),
      ...(identity ? [] : [`IDENTITY skipped (no repoIdentities entry for ${snapshot.repo})`]),
      ...warnings.map((w) => `WARNING ${w}`),
    ],
  };
}

type PrMeta = { body: string | null; head: string; commits: number };

function prMeta(value: unknown): PrMeta {
  const p = value as { body?: unknown; head?: { sha?: unknown }; commits?: unknown } | null;
  if (!p || typeof p !== "object" || (p.body !== null && typeof p.body !== "string") || typeof p.head?.sha !== "string" || !SHA_RE.test(p.head.sha)
    || typeof p.commits !== "number" || !Number.isSafeInteger(p.commits) || p.commits < 1) throw new Error("incomplete PR metadata");
  return { body: (p.body ?? null) as string | null, head: p.head.sha, commits: p.commits };
}

const isFile = (f: unknown): f is PrFile => {
  const x = f as { filename?: unknown; status?: unknown; previous_filename?: unknown } | null;
  return !!x && typeof x.filename === "string" && typeof x.status === "string" && (x.previous_filename === undefined || typeof x.previous_filename === "string");
};

/**
 * Reads `pr` through `gh api` (each call bounded by `timeoutMs`) and judges it with `checkPr` against the identity
 * configured for its repo. `ok` false and a single `- <reason>` line when GitHub could not be read completely or the PR
 * changed during the read; the caller prints `lines` and exits 0 on PASS, 2 on FAIL.
 */
export async function verifyPr(d: Deps, pr: PrRef, config: SeoriConfig, timeoutMs: number = GH_TIMEOUT_MS): Promise<VerifyPrResult> {
  const api = async (endpoint: string): Promise<unknown> => {
    const argv = ["api", "--method", "GET", endpoint];
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => timeout.reject(new Error(`gh api ${endpoint}: no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    try {
      const r = await Promise.race([d.exec("gh", argv), timeout.promise]);
      if (r.code !== 0) throw new Error(`gh api ${endpoint}: exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
      try {
        return JSON.parse(r.stdout);
      } catch {
        throw new Error(`gh api ${endpoint}: invalid JSON`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const root = `repos/${pr.repo}/pulls/${pr.number}`;
    const before = prMeta(await api(root));
    const listed: { sha: string }[] = [];
    for (let page = 1; ; page++) {
      const rows = await api(`${root}/commits?per_page=${PAGE}&page=${page}`);
      if (!Array.isArray(rows) || !rows.every((c) => c && typeof c.sha === "string" && SHA_RE.test(c.sha))) throw new Error("incomplete PR commit list");
      listed.push(...(rows as { sha: string }[]));
      // More commits than the PR reports fails the count check below instead of paging forever.
      if (rows.length < PAGE || listed.length > before.commits) break;
    }
    if (listed.length !== before.commits || new Set(listed.map((c) => c.sha)).size !== listed.length) {
      throw new Error(`incomplete PR commit list: received ${listed.length}, expected ${before.commits}`);
    }
    if (listed.at(-1)?.sha !== before.head) throw new Error("PR commit list does not end at the current head");

    const commits: PrCommit[] = [];
    for (const { sha } of listed) {
      const files: PrFile[] = [];
      let commit: PrCommit | undefined;
      for (let page = 1; ; page++) {
        const c = await api(`repos/${pr.repo}/commits/${sha}?per_page=${PAGE}&page=${page}`) as PrCommit | null;
        if (!c || c.sha !== sha || typeof c.commit?.message !== "string" || !("author" in c.commit) || !("committer" in c.commit)
          || !Array.isArray(c.files) || !c.files.every(isFile)) throw new Error(`incomplete commit data for ${sha}`);
        commit = c;
        files.push(...c.files);
        if (c.files.length < PAGE) break;
        if (page >= MAX_FILE_PAGES) throw new Error(`${sha}: cannot verify beyond GitHub's 3000-file commit limit`);
      }
      commits.push({ ...commit, files });
    }

    const files: PrFile[] = [];
    for (let page = 1; ; page++) {
      const rows = await api(`${root}/files?per_page=${PAGE}&page=${page}`);
      if (!Array.isArray(rows) || !rows.every(isFile)) throw new Error("incomplete PR file list");
      files.push(...rows);
      if (rows.length < PAGE) break;
      if (page >= MAX_FILE_PAGES) throw new Error("cannot verify beyond GitHub's 3000-file PR limit");
    }

    const after = prMeta(await api(root));
    if (before.head !== after.head || before.body !== after.body || before.commits !== after.commits) {
      throw new Error(`PR changed during verification; run: seori verify-pr ${pr.id}`);
    }
    return checkPr({ repo: pr.repo, number: pr.number, body: before.body, head: before.head, commits, files }, identityFor(config, pr.repo));
  } catch (e) {
    return { ok: false, lines: [`FAIL ${pr.id}`, `- ${e instanceof Error ? e.message : String(e)}`] };
  }
}
