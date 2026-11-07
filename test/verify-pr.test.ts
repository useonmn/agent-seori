import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type SeoriConfig } from "../src/config.ts";
import { parsePr } from "../src/harness.ts";
import { checkPr, isSourceFile, isTestFile, verifyPr, type PrCommit, type PrFile, type PrSnapshot } from "../src/verify-pr.ts";
import { World } from "./fake.ts";

const ME = { name: "Me", email: "me@example.com" };
const sha = (n: number): string => n.toString(16).padStart(40, "a");
const commit = (n: number, message: string, files: PrFile[], extra: Partial<PrCommit["commit"]> = {}, parents = 1): PrCommit => ({
  sha: sha(n),
  commit: { message, author: ME, committer: ME, ...extra },
  files,
  parents: Array.from({ length: parents }, (_, i) => ({ sha: sha(100 + i) })),
});
const mod = (filename: string): PrFile => ({ filename, status: "modified" });
const snap = (commits: PrCommit[], files: readonly PrFile[], body: string | null = null): PrSnapshot =>
  ({ repo: "o/r", number: 7, body, head: commits.at(-1)?.sha ?? sha(0), commits, files });

describe("checkPr", () => {
  test("PASS when identities match (any case) and a fix changes a test", () => {
    const c = commit(1, "fix(cli): crash", [mod("src/a.ts"), mod("test/a.test.ts")], { author: { name: "Me", email: "ME@Example.com" } });
    expect(checkPr(snap([c], c.files), ME)).toEqual({ ok: true, lines: [`PASS o/r#7 at ${sha(1)}`] });
  });

  test("wrong author or committer email fails, naming the commit", () => {
    const c = commit(1, "feat: x", [mod("src/a.ts")], { committer: { name: "Bot", email: "bot@x.dev" } });
    const r = checkPr(snap([c], c.files), ME);
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual([
      `FAIL o/r#7 at ${sha(1)}`,
      `- ${sha(1)}: wrong committer email bot@x.dev; expected me@example.com (or noreply@github.com for a merge commit)`,
    ]);
  });

  test("missing identity fails", () => {
    const c = commit(1, "feat: x", [], { author: null });
    expect(checkPr(snap([c], []), ME).lines).toContain(`- ${sha(1)}: missing author email; expected me@example.com`);
  });

  test("noreply@github.com passes only as committer of a merge commit", () => {
    const gh = { name: "GitHub", email: "noreply@github.com" };
    expect(checkPr(snap([commit(1, "Merge main", [], { committer: gh }, 2)], []), ME).ok).toBe(true);
    expect(checkPr(snap([commit(1, "feat: x", [], { committer: gh })], []), ME).ok).toBe(false);
    expect(checkPr(snap([commit(1, "Merge main", [], { author: gh }, 2)], []), ME).ok).toBe(false);
  });

  test("a repo with no identity skips the identity check, not a failure", () => {
    const c = commit(1, "feat: x", [mod("src/a.ts")], { author: { name: "X", email: "x@y" } });
    expect(checkPr(snap([c], c.files), undefined)).toEqual({
      ok: true,
      lines: [`PASS o/r#7 at ${sha(1)}`, "IDENTITY skipped (no repoIdentities entry for o/r)"],
    });
  });

  test("source fix without a test fails unless the body says No test", () => {
    const c = commit(1, "fix: off by one", [mod("src/a.ts")]);
    const failed = checkPr(snap([c], c.files), ME);
    expect(failed.ok).toBe(false);
    expect(failed.lines).toContain('- PR has source fix commits but no added/changed test; add a test or a nonempty "No test: <reason>" line to the PR body');
    expect(checkPr(snap([c], c.files, "Summary\nNo test:   \n"), ME).ok).toBe(false);
    const excused = checkPr(snap([c], c.files, "Summary\nNo test: config-only path\n"), ME);
    expect(excused.ok).toBe(true);
    expect(excused.lines).toContain("WARNING PR has source fix commits but no added/changed test; No test: config-only path");
  });

  test("a test added in another commit covers the fix across the PR, with a per-commit warning", () => {
    const fix = commit(1, "fix!: break", [mod("src/a.ts")]);
    const t = commit(2, "test: cover", [{ filename: "src/a.spec.ts", status: "added" }]);
    const r = checkPr(snap([fix, t], [mod("src/a.ts"), { filename: "src/a.spec.ts", status: "added" }]), ME);
    expect(r.ok).toBe(true);
    expect(r.lines).toContain(`WARNING ${sha(1)}: fix commit changes source without its own added/changed test; coverage is judged across the PR`);
  });

  test("non-fix commits, docs-only fixes and removed tests", () => {
    expect(checkPr(snap([commit(1, "feat: x", [mod("src/a.ts")])], [mod("src/a.ts")]), ME).ok).toBe(true);
    expect(checkPr(snap([commit(1, "fix: typo", [mod("docs/a.md"), mod("README.md")])], [mod("README.md")]), ME).ok).toBe(true);
    const removed = { filename: "test/a.test.ts", status: "removed" };
    expect(checkPr(snap([commit(1, "fix: x", [mod("src/a.ts"), removed])], [mod("src/a.ts"), removed]), ME).ok).toBe(false);
    // A rename away from source still counts as touching source.
    const renamed = { filename: "notes.txt", status: "renamed", previous_filename: "src/a.ts" };
    expect(checkPr(snap([commit(1, "fix: x", [renamed])], [renamed]), ME).ok).toBe(false);
  });

  test("no commits fails", () => {
    expect(checkPr(snap([], []), ME).lines).toContain("- PR has no commits to verify");
  });
});

describe("test and source file rules", () => {
  test.each([
    ["src/a.test.ts", true], ["a/b.spec.jsx", true], ["pkg/test_x.py", true], ["x_test.go", true], ["test/cli.ts", true],
    ["__tests__/a.js", true], ["test/fake.ts", false], ["test/helpers/a.ts", false], ["test/setup.ts", false],
    ["fixtures/a.test.ts", false], ["test/fixtures.ts", false], ["src/helpers.test.ts", true], ["test/data.json", false],
  ])("isTestFile(%s) = %p", (path, want) => expect(isTestFile(path)).toBe(want));

  test.each([
    ["src/a.ts", true], ["web/a.css", true], ["x.sql", true], ["docs/a.ts", false], ["src/a.test.ts", false],
    ["README.md", false], ["package.json", false], ["fixtures/a.ts", false],
  ])("isSourceFile(%s) = %p", (path, want) => expect(isSourceFile(path)).toBe(want));
});

type Api = Record<string, unknown>;

function world(api: Api | ((endpoint: string, n: number) => unknown)): { w: World; endpoints: string[] } {
  const w = new World();
  const endpoints: string[] = [];
  const counts = new Map<string, number>();
  w.gh = (argv) => {
    expect(argv.slice(0, 3)).toEqual(["api", "--method", "GET"]);
    const endpoint = String(argv[3]);
    endpoints.push(endpoint);
    const n = (counts.get(endpoint) ?? 0) + 1;
    counts.set(endpoint, n);
    const value = typeof api === "function" ? api(endpoint, n) : api[endpoint];
    return value === undefined ? { code: 1, stdout: "HTTP 404" } : { code: 0, stdout: JSON.stringify(value) };
  };
  return { w, endpoints };
}

const config = (identities: Record<string, { name: string; email: string }> = { "o/r": ME }): SeoriConfig => ({ ...DEFAULT_CONFIG, repoIdentities: identities });
const pr = parsePr("O/R#7");
const ghCommit = (c: PrCommit) => ({ sha: c.sha, commit: c.commit, files: c.files, parents: c.parents });

function goodApi(body: string | null = "No test: n/a"): Api {
  const c1 = commit(1, "fix: a", [mod("src/a.ts"), mod("test/a.test.ts")]);
  const c2 = commit(2, "chore: b", [mod("README.md")]);
  return {
    "repos/O/R/pulls/7": { body, head: { sha: sha(2) }, commits: 2 },
    "repos/O/R/pulls/7/commits?per_page=100&page=1": [{ sha: sha(1) }, { sha: sha(2) }],
    [`repos/O/R/commits/${sha(1)}?per_page=100&page=1`]: ghCommit(c1),
    [`repos/O/R/commits/${sha(2)}?per_page=100&page=1`]: ghCommit(c2),
    "repos/O/R/pulls/7/files?per_page=100&page=1": [mod("src/a.ts"), mod("test/a.test.ts"), mod("README.md")],
  };
}

describe("verifyPr", () => {
  test("reads the PR twice, every commit and the file list, and matches the identity key without case", async () => {
    const { w, endpoints } = world(goodApi());
    expect(await verifyPr(w.deps(), pr, config())).toEqual({ ok: true, lines: [`PASS O/R#7 at ${sha(2)}`] });
    expect(endpoints).toEqual([
      "repos/O/R/pulls/7",
      "repos/O/R/pulls/7/commits?per_page=100&page=1",
      `repos/O/R/commits/${sha(1)}?per_page=100&page=1`,
      `repos/O/R/commits/${sha(2)}?per_page=100&page=1`,
      "repos/O/R/pulls/7/files?per_page=100&page=1",
      "repos/O/R/pulls/7",
    ]);
  });

  test("no configured identity: skipped line, still PASS", async () => {
    const { w } = world(goodApi());
    const r = await verifyPr(w.deps(), pr, config({}));
    expect(r).toEqual({ ok: true, lines: [`PASS O/R#7 at ${sha(2)}`, "IDENTITY skipped (no repoIdentities entry for O/R)"] });
  });

  test("a PR that changes between the two reads fails", async () => {
    const api = goodApi();
    const { w } = world((endpoint, n) =>
      endpoint === "repos/O/R/pulls/7" && n === 2 ? { body: "edited", head: { sha: sha(2) }, commits: 2 } : api[endpoint]);
    expect(await verifyPr(w.deps(), pr, config())).toEqual({
      ok: false,
      lines: ["FAIL O/R#7", "- PR changed during verification; run: seori verify-pr O/R#7"],
    });
  });

  test("a commit list that does not match the reported count or head fails", async () => {
    const short = { ...goodApi(), "repos/O/R/pulls/7/commits?per_page=100&page=1": [{ sha: sha(2) }] };
    expect((await verifyPr(world(short).w.deps(), pr, config())).lines).toEqual(["FAIL O/R#7", "- incomplete PR commit list: received 1, expected 2"]);
    const order = { ...goodApi(), "repos/O/R/pulls/7/commits?per_page=100&page=1": [{ sha: sha(2) }, { sha: sha(1) }] };
    expect((await verifyPr(world(order).w.deps(), pr, config())).lines).toEqual(["FAIL O/R#7", "- PR commit list does not end at the current head"]);
  });

  test("gh failures and bad JSON are FAIL lines, never a throw", async () => {
    const { w } = world({});
    expect(await verifyPr(w.deps(), pr, config())).toEqual({ ok: false, lines: ["FAIL O/R#7", "- gh api repos/O/R/pulls/7: exit 1: HTTP 404"] });
    const w2 = new World();
    w2.gh = () => ({ code: 0, stdout: "<html>" });
    expect((await verifyPr(w2.deps(), pr, config())).lines).toEqual(["FAIL O/R#7", "- gh api repos/O/R/pulls/7: invalid JSON"]);
    const bad = { ...goodApi(), "repos/O/R/pulls/7": { body: null, head: { sha: "abc" }, commits: 2 } };
    expect((await verifyPr(world(bad).w.deps(), pr, config())).lines).toEqual(["FAIL O/R#7", "- incomplete PR metadata"]);
  });

  test("commit and file pages are followed past 100 entries", async () => {
    const many = Array.from({ length: 100 }, (_, i) => mod(`src/f${i}.ts`));
    const c1 = commit(1, "fix: a", many);
    const api: Api = {
      "repos/O/R/pulls/7": { body: null, head: { sha: sha(1) }, commits: 1 },
      "repos/O/R/pulls/7/commits?per_page=100&page=1": [{ sha: sha(1) }],
      [`repos/O/R/commits/${sha(1)}?per_page=100&page=1`]: ghCommit(c1),
      [`repos/O/R/commits/${sha(1)}?per_page=100&page=2`]: { ...ghCommit(c1), files: [mod("test/x.test.ts")] },
      "repos/O/R/pulls/7/files?per_page=100&page=1": many,
      "repos/O/R/pulls/7/files?per_page=100&page=2": [mod("test/x.test.ts")],
    };
    const r = await verifyPr(world(api).w.deps(), pr, config());
    expect(r).toEqual({ ok: true, lines: [`PASS O/R#7 at ${sha(1)}`] });
  });

  test("an unanswered gh call times out as a FAIL line", async () => {
    const w = new World();
    const d = { ...w.deps(), exec: () => new Promise<never>(() => {}) };
    expect(await verifyPr(d, pr, config(), 20)).toEqual({ ok: false, lines: ["FAIL O/R#7", "- gh api repos/O/R/pulls/7: no answer within 0.02 s"] });
  });
});
