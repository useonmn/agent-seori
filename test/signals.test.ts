import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal, type Deps } from "../src/harness.ts";
import { spawnExec, type ExecResult } from "../src/runtime/exec.ts";
import { checkSignals, defaultSignalIo, installHold, installState, parseDone, splitDone, unpushedWork, type SignalIo } from "../src/signals.ts";
import type { Lane } from "../src/store.ts";
import { World } from "./fake.ts";

type Handler = (argv: readonly string[]) => ExecResult;

/** Deps whose gh, npm and git answers come from the handlers; a git checkout that is clean with no remote by default. */
function setup(handlers: { gh?: Handler; npm?: Handler; git?: Handler } = {}) {
  const w = new World();
  const calls: { cmd: string; argv: readonly string[] }[] = [];
  const base = w.deps();
  const cleanGit: Handler = (argv) => {
    const verb = argv[2];
    if (verb === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
    if (verb === "worktree") return { code: 0, stdout: `worktree ${argv[1]}\nHEAD abc\nbranch refs/heads/main\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const d: Deps = {
    ...base,
    exec: async (cmd, argv) => {
      calls.push({ cmd, argv });
      const h = cmd === "gh" ? handlers.gh : cmd === "npm" ? handlers.npm : cmd === "git" ? handlers.git ?? cleanGit : undefined;
      return h ? h(argv) : { code: 1, stdout: "", stderr: `no ${cmd}` };
    },
  };
  const cwd = join(d.store.root, "work");
  mkdirSync(cwd, { recursive: true });
  const lane = (done?: string): Lane => ({
    key: "fix-login", sessionRef: { runtime: "hc", id: "t2" }, paneId: "t2", tabId: "w1:t2", brief: "b", cwd, status: "ready",
    createdAt: 0, lastActivityAt: 0, nudges: 0, log: [], ...(done !== undefined ? { done } : {}),
  });
  return { d, calls, cwd, lane };
}

const io = (over: Partial<SignalIo> = {}): SignalIo & { ran: { argv: readonly string[]; cwd: string; timeoutMs: number }[]; got: string[] } => {
  const ran: { argv: readonly string[]; cwd: string; timeoutMs: number }[] = [];
  const got: string[] = [];
  return {
    ran, got,
    run: over.run ?? (async (argv, opts) => {
      ran.push({ argv, ...opts });
      return { code: 0, stdout: "ok", stderr: "" };
    }),
    get: over.get ?? (async (url) => {
      got.push(url);
      return { status: 200, body: "hello" };
    }),
  };
};

describe("parseDone", () => {
  test("reads every signal kind joined by ;, with an optional Done = prefix", () => {
    const sigs = parseDone(
      'Done = merged o/r#12; closed o/r#3; published pkg@1.2.3; command ["bun","test"] stdout~"pass; ok"; ' +
        'file out/x.json sha256=' + "A".repeat(64) + ' json:.a.0=true; url https://x.test/h status=204 body~"up"',
    );
    expect(sigs).toEqual([
      { kind: "merged", repo: "o/r", n: 12 },
      { kind: "closed", repo: "o/r", n: 3 },
      { kind: "published", pkg: "pkg", version: "1.2.3" },
      { kind: "command", argv: ["bun", "test"], stdout: /pass; ok/ },
      { kind: "file", path: "out/x.json", sha256: "a".repeat(64), json: { path: ["a", 0], value: true } },
      { kind: "url", url: "https://x.test/h", status: 204, body: /up/ },
    ]);
  });

  test("accepts PR and issue URLs' path form and a quoted file path", () => {
    expect(parseDone("merged o/r/pull/7; closed o/r/issues/8")).toEqual([
      { kind: "merged", repo: "o/r", n: 7 },
      { kind: "closed", repo: "o/r", n: 8 },
    ]);
    expect(parseDone('file "dir with space/a.txt"')).toEqual([{ kind: "file", path: "dir with space/a.txt" }]);
  });

  test("a no-op command parses (it proves nothing, but is not a syntax error)", () => {
    expect(parseDone('command ["true"]')).toEqual([{ kind: "command", argv: ["true"] }]);
  });

  test("refuses an empty line, unknown signals and bad options, naming each", () => {
    expect(() => parseDone("")).toThrow(Refusal);
    expect(() => parseDone("Done = ;")).toThrow("empty Done line");
    expect(() => parseDone("tests pass")).toThrow('bad Done line: tests pass -> unreadable signal');
    expect(() => parseDone("command bun test")).toThrow("JSON argv array");
    expect(() => parseDone('command [""]')).toThrow("nonempty array");
    expect(() => parseDone("file a sha256=abc")).toThrow("64 hex");
    expect(() => parseDone("file a json:.=1")).toThrow("field path");
    expect(() => parseDone("url ftp://x")).toThrow("http(s) URL");
    expect(() => parseDone("url https://x status=ok")).toThrow("integer");
    expect(() => parseDone('url https://x body~"("')).toThrow("invalid regex");
    expect(() => parseDone("url https://x colour=1")).toThrow("unknown option colour");
    expect(() => parseDone("merged o/r#1; nope")).toThrow(/^bad Done line: nope -> /);
  });

  test("splitDone keeps a ; inside quotes and brackets in its signal", () => {
    expect(splitDone('command ["a;b"] stdout~"x;y"; merged o/r#1')).toEqual(['command ["a;b"] stdout~"x;y"', "merged o/r#1"]);
  });
});

describe("checkSignals", () => {
  test("all signals live and a clean checkout: no failures; each read goes where it should", async () => {
    const { d, calls, cwd, lane } = setup({
      gh: (argv) => ({ code: 0, stdout: argv[0] === "pr" ? '{"state":"MERGED","mergeCommit":{"oid":"abc123"}}' : '{"state":"CLOSED"}', stderr: "" }),
      npm: () => ({ code: 0, stdout: '["1.2.3"]', stderr: "" }),
    });
    writeFileSync(join(cwd, "v.json"), '{"version":"1.2.3"}');
    const sha = new Bun.CryptoHasher("sha256").update('{"version":"1.2.3"}').digest("hex");
    const fake = io();
    const failures = await checkSignals(d, lane(
      `merged o/r#12; closed o/r#3; published pkg@1.2.3; command ["bun","test"] stdout~"ok"; file v.json sha256=${sha} json:.version="1.2.3"; url https://x.test/h`,
    ), fake);
    expect(failures).toEqual([]);
    expect(calls.filter((c) => c.cmd !== "git").map((c) => [c.cmd, ...c.argv].join(" "))).toEqual([
      "gh pr view 12 --repo o/r --json state,mergeCommit",
      "gh issue view 3 --repo o/r --json state",
      "npm view pkg@1.2.3 version --json",
    ]);
    expect(fake.ran).toEqual([{ argv: ["bun", "test"], cwd, timeoutMs: 120_000 }]);
    expect(fake.got).toEqual(["https://x.test/h"]);
  });

  test("older npm's bare-string version output counts", async () => {
    const { d, lane } = setup({ npm: () => ({ code: 0, stdout: '"1.2.3"\n', stderr: "" }) });
    expect(await checkSignals(d, lane("published pkg@1.2.3"), io())).toEqual([]);
  });

  test("each signal that does not read back live is one reason naming the signal", async () => {
    const { d, lane } = setup({
      gh: (argv) => (argv[0] === "pr" ? { code: 0, stdout: '{"state":"OPEN","mergeCommit":null}', stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 404\nmore" }),
      npm: () => ({ code: 1, stdout: "", stderr: "E404" }),
    });
    const fake = io({
      run: async (argv) => (argv[0] === "fail" ? { code: 2, stdout: "", stderr: "boom" } : { code: 0, stdout: "nope", stderr: "" }),
      get: async (url) => {
        if (url.includes("down")) throw new Error("connect refused");
        return { status: 500, body: "" };
      },
    });
    const failures = await checkSignals(d, lane(
      'merged o/r#1; closed o/r#2; published p@9; command ["fail"]; command ["ok"] stdout~"yes"; file missing.txt; url https://down.test; url https://x.test',
    ), fake);
    expect(failures).toEqual([
      "merged o/r#1 -> state OPEN",
      "closed o/r#2 -> gh: HTTP 404 more",
      "published p@9 -> registry has no p@9: E404",
      'command ["fail"] -> exit 2: boom',
      'command ["ok"] stdout~"yes" -> exit 0 but stdout does not match /yes/: nope',
      `file missing.txt -> missing: ${join(lane().cwd, "missing.txt")}`,
      "url https://down.test -> request failed: connect refused",
      "url https://x.test -> status 500, want 200",
    ]);
  });

  test("file field and hash mismatches are named", async () => {
    const { d, cwd, lane } = setup();
    writeFileSync(join(cwd, "v.json"), '{"a":{"b":2}}');
    writeFileSync(join(cwd, "t.txt"), "not json");
    const failures = await checkSignals(d, lane(`file v.json json:.a.b=3; file v.json json:.a.c=1; file t.txt json:.a=1; file t.txt sha256=${"0".repeat(64)}`), io());
    expect(failures).toEqual([
      "file v.json json:.a.b=3 -> .a.b is 2, want 3",
      "file v.json json:.a.c=1 -> no field .a.c",
      `file t.txt json:.a=1 -> not JSON: ${join(cwd, "t.txt")}`,
      expect.stringMatching(/^file t\.txt sha256=0+ -> sha256 [0-9a-f]{12}\.\.\. is not 000000000000\.\.\.$/),
    ]);
  });

  test("a lane seori gave a worktree reads its file and command signals there, not in its cwd", async () => {
    const { d, cwd, lane } = setup();
    const worktree = join(d.store.root, "wt");
    mkdirSync(worktree);
    writeFileSync(join(worktree, "out.txt"), "built");
    const run = io();
    expect(await checkSignals(d, { ...lane('file out.txt; command ["make"]'), worktree }, run)).toEqual([]);
    expect(run.ran.map((r) => r.cwd)).toEqual([worktree]);
    expect(await checkSignals(d, lane("file out.txt"), io())).toEqual([`file out.txt -> missing: ${join(cwd, "out.txt")}`]);
  });

  test("a stored Done line that no longer parses is a failure, never a pass", async () => {
    const { d, lane } = setup();
    expect(await checkSignals(d, lane("tests pass"), io())).toEqual([expect.stringMatching(/^tests pass -> unreadable signal/)]);
    expect(await checkSignals(d, lane(""), io())).toEqual(["empty Done line"]);
  });

  test("a lane with no Done line is only checked for unpushed work", async () => {
    const { d, calls, lane } = setup();
    expect(await checkSignals(d, lane(), io())).toEqual([]);
    expect(calls.every((c) => c.cmd === "git")).toBe(true);
  });

  test("the default command runner runs with no shell in the lane's cwd", async () => {
    const { d, cwd, lane } = setup();
    writeFileSync(join(cwd, "marker"), "");
    expect(await checkSignals(d, lane(`command ["bun","-e","require('fs').accessSync('marker'); console.log('marker')"] stdout~"^marker"`))).toEqual([]);
    expect(await checkSignals(d, lane(`command ["bun","-e","require('fs').accessSync('$HOME')"]`))).toEqual([expect.stringMatching(/^command \["bun",.*\] -> exit [1-9]/)]);
    expect(await checkSignals(d, lane('command ["no-such-binary-seori"]'))).toEqual([expect.stringMatching(/^command \["no-such-binary-seori"\] -> exit 127/)]);
  });

  test("the default command runner's timeout bounds the run, even when the child ignores SIGTERM or a grandchild holds the pipes", async () => {
    const { cwd } = setup();
    const ignoresTerm = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 6000)";
    const grandchild = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' }); setTimeout(() => {}, 6000)`;
    for (const argv of [[process.execPath, "-e", ignoresTerm], [process.execPath, "-e", grandchild]]) {
      const t0 = Date.now();
      const r = await defaultSignalIo.run(argv, { cwd, timeoutMs: 300 });
      expect(r.code).toBe(124);
      expect(r.stderr).toBe("timed out after 0.3 s");
      expect(Date.now() - t0).toBeLessThan(2_000);
    }
  });
});

describe("unpushedWork", () => {
  const git = (over: Record<string, ExecResult>, worktrees?: string): Handler => (argv) => {
    const verb = String(argv[2]);
    if (verb === "worktree") return { code: 0, stdout: worktrees ?? `worktree ${argv[1]}\nbranch refs/heads/main\n`, stderr: "" };
    return over[verb] ?? (verb === "rev-parse" ? { code: 0, stdout: "true\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
  };

  test("uncommitted tracked changes in the cwd block the close", async () => {
    const { d, cwd, lane } = setup({ git: git({ status: { code: 0, stdout: " M a.ts\n", stderr: "" } }) });
    expect(await unpushedWork(d, lane())).toEqual([`uncommitted tracked changes in ${cwd}`]);
  });

  test("commits on no remote block the close when the repo has a remote", async () => {
    const { d, calls, cwd, lane } = setup({ git: git({ remote: { code: 0, stdout: "origin\n", stderr: "" }, "rev-list": { code: 0, stdout: "2\n", stderr: "" } }) });
    expect(await unpushedWork(d, lane())).toEqual([`2 commit(s) on no remote in ${cwd}`]);
    expect(calls.at(-1)!.argv).toEqual(["-C", cwd, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
  });

  test("a local-only repo (no remote) is checked for uncommitted changes only", async () => {
    const { d, calls, lane } = setup({ git: git({ "rev-list": { code: 0, stdout: "5\n", stderr: "" } }) });
    expect(await unpushedWork(d, lane())).toEqual([]);
    expect(calls.some((c) => c.argv[2] === "rev-list")).toBe(false);
  });

  test("a cwd that is not a git checkout has nothing to push", async () => {
    const { d, lane } = setup({ git: git({ "rev-parse": { code: 128, stdout: "", stderr: "not a git repository" } }) });
    expect(await unpushedWork(d, lane())).toEqual([]);
  });

  test("unreadable git state blocks the close", async () => {
    const { d, cwd, lane } = setup({ git: git({ status: { code: 1, stdout: "", stderr: "x" } }) });
    expect(await unpushedWork(d, lane())).toEqual([`unpushed work in ${cwd} (git state unreadable)`]);
  });

  test("a lane with worktrees of its own is checked there, not in the human's checkout", async () => {
    const w = setup();
    const wt = join(w.d.store.root, "wt-fix-login");
    mkdirSync(wt);
    const list = `worktree ${w.cwd}\nbranch refs/heads/main\n\nworktree ${wt}\nbranch refs/heads/fix-login-retry\n\nworktree /gone/fix-login\nbranch refs/heads/other\n\nworktree /x/other\nbranch refs/heads/unrelated\n`;
    const { d, lane } = setup({
      git: (argv) => {
        const verb = String(argv[2]);
        if (verb === "worktree") return { code: 0, stdout: list, stderr: "" };
        if (verb === "status") return { code: 0, stdout: argv[1] === wt ? " M x\n" : " M human\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const l = { ...lane(), cwd: w.cwd };
    expect(await unpushedWork(d, l)).toEqual([`uncommitted tracked changes in ${wt}`, "unpushed work in /gone/fix-login (worktree missing)"]);
  });

  test("a detached-HEAD worktree named after the lane is the lane's", async () => {
    const w = setup();
    const wt = join(w.d.store.root, "fix-login");
    mkdirSync(wt);
    const list = `worktree ${w.cwd}\nHEAD a\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD b\ndetached\n`;
    const { d, lane } = setup({
      git: (argv) => {
        const verb = String(argv[2]);
        if (verb === "worktree") return { code: 0, stdout: list, stderr: "" };
        if (verb === "status") return { code: 0, stdout: argv[1] === wt ? " M src/a.ts\n" : "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(await unpushedWork(d, { ...lane(), cwd: w.cwd })).toEqual([`uncommitted tracked changes in ${wt}`]);
  });

  test("another open lane's <key>-... worktree is not this lane's", async () => {
    const w = setup();
    const wt = join(w.d.store.root, "fix-login-v2");
    mkdirSync(wt);
    const list = `worktree ${w.cwd}\nHEAD a\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD b\nbranch refs/heads/fix-login-v2-retry\n`;
    const { d, lane } = setup({
      git: (argv) => {
        const verb = String(argv[2]);
        if (verb === "worktree") return { code: 0, stdout: list, stderr: "" };
        if (verb === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
        if (verb === "status") return { code: 0, stdout: argv[1] === w.cwd ? " M src/a.ts\n" : "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const mine = { ...lane(), cwd: w.cwd };
    d.store.saveLane({ ...mine, key: "fix-login-v2", sessionRef: { runtime: "hc", id: "t3" }, paneId: "t3", tabId: "w1:t3", status: "working" });
    expect(await unpushedWork(d, mine)).toEqual([`uncommitted tracked changes in ${w.cwd}`]);
    // Once that lane is done, a fix-login-v2 worktree is fix-login's again.
    d.store.saveLane({ ...mine, key: "fix-login-v2", sessionRef: { runtime: "hc", id: "t3" }, paneId: "t3", tabId: "w1:t3", status: "done" });
    expect(await unpushedWork(d, mine)).toEqual([]);
  });

  // The developer's own git config (signing, hooks) must not decide whether a commit here works.
  const realGit = async (dir: string, ...argv: string[]): Promise<string> => {
    const r = await spawnExec("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...argv]);
    if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };

  /** A real install checkout at $SEORI_HOME/src with one tracked file, and the worktree seori start gives lane fix-login. */
  async function installed() {
    const base = new World().deps();
    const installDir = join(base.store.root, "src");
    mkdirSync(installDir);
    await realGit(installDir, "init", "-q", "-b", "main");
    writeFileSync(join(installDir, "a.ts"), "1");
    await realGit(installDir, "add", "a.ts");
    await realGit(installDir, "commit", "-q", "-m", "first");
    const worktree = join(base.store.root, "work", "fix-login");
    await realGit(installDir, "worktree", "add", "-q", "-b", "fix-login", worktree);
    const d: Deps = { ...base, installDir, exec: spawnExec };
    const lane = (key: string, cwd: string, wt?: string): Lane => ({
      key, sessionRef: { runtime: "hc", id: "t2" }, paneId: "t2", tabId: "", brief: "b", cwd, ...(wt !== undefined ? { worktree: wt } : {}),
      status: "ready", createdAt: 0, lastActivityAt: 0, nudges: 0, log: [],
    });
    return { d, installDir, worktree, lane };
  }

  test("a lane started in the install checkout is held while that checkout has uncommitted tracked changes, whatever worktree it owns", async () => {
    const { d, installDir, worktree, lane } = await installed();
    const mine = lane("fix-login", installDir, worktree);
    expect(await installHold(d, mine)).toBeUndefined();
    writeFileSync(join(installDir, "untracked.ts"), "x");
    expect(await installHold(d, mine)).toBeUndefined();
    writeFileSync(join(installDir, "a.ts"), "edited by absolute path");
    expect(await installHold(d, mine)).toBe(`uncommitted tracked changes in the install checkout ${installDir}, which this lane was started in: a.ts`);
    // The hold is not the lane's own work: its close check is clean.
    expect(await unpushedWork(d, mine)).toEqual([]);
    expect(await checkSignals(d, { ...mine, done: "file a.ts" }, io())).toEqual([]);
    // Renamed and quoted paths are named as they are.
    await realGit(installDir, "mv", "a.ts", "b c.ts");
    expect(await installHold(d, mine)).toBe(`uncommitted tracked changes in the install checkout ${installDir}, which this lane was started in: b c.ts`);
    // A lane started elsewhere is not held by the install checkout.
    expect(await installHold(d, lane("docs", d.store.root))).toBeUndefined();
    // A lane opened in the install checkout itself (before seori gave such lanes a worktree): with a Done line its close
    // check reads the checkout as its own work, so it is told once; without one nothing else reads it, so it is held.
    const notes = lane("notes", installDir);
    expect(await unpushedWork(d, notes)).toEqual([`uncommitted tracked changes in ${installDir}`]);
    expect(await installHold(d, { ...notes, done: "file b c.ts" })).toBeUndefined();
    expect(await installHold(d, notes)).toBe(`uncommitted tracked changes in the install checkout ${installDir}, which this lane was started in: b c.ts`);
  });

  test("an install checkout git cannot read is unreadable, never clean; a folder that is no repository of its own is not a checkout", async () => {
    const { d, installDir } = await installed();
    const plain = join(d.store.root, "plain");
    mkdirSync(plain);
    expect(await installState({ ...d, installDir: plain })).toEqual({ kind: "not-a-checkout" });
    // Inside another repository (a dotfiles repo at ~), whose changes are not seori's.
    const nested = join(installDir, "sub");
    mkdirSync(nested);
    writeFileSync(join(installDir, "a.ts"), "dirty");
    expect(await installState({ ...d, installDir: nested })).toEqual({ kind: "not-a-checkout" });
    const broken = join(d.store.root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/seori-test\n");
    expect(await installState({ ...d, installDir: broken })).toEqual({ kind: "unreadable", why: expect.stringMatching(/\S/) });
    // git's English decides "no repository", whatever language the owner runs it in.
    const locales: (string | undefined)[] = [];
    const read = await installState({ ...d, exec: (cmd, argv, o) => (locales.push(o?.env?.LC_ALL), d.exec(cmd, argv, o)) });
    expect(read).toEqual({ kind: "dirty", files: ["a.ts"] });
    expect(locales).toEqual(["C", "C"]);
  });

  test("the worktree seori recorded stays the lane's once git no longer lists it, instead of falling back to the cwd", async () => {
    const { d, installDir, worktree, lane } = await installed();
    rmSync(worktree, { recursive: true });
    await realGit(installDir, "worktree", "prune");
    expect(await unpushedWork(d, lane("fix-login", installDir, worktree))).toEqual([`unpushed work in ${worktree} (worktree missing)`]);
  });

  test("a cwd reached through a symlink is still the human's checkout, never one of the lane's worktrees", async () => {
    const { d, lane } = await installed();
    const human = join(d.store.root, "fix-login-home");
    mkdirSync(human);
    await realGit(human, "init", "-q", "-b", "main");
    writeFileSync(join(human, "h.ts"), "1");
    await realGit(human, "add", "h.ts");
    await realGit(human, "commit", "-q", "-m", "first");
    const wt = join(d.store.root, "wt-fix-login");
    await realGit(human, "worktree", "add", "-q", "-b", "fix-login", wt);
    writeFileSync(join(human, "h.ts"), "the human's own edit");
    const link = join(d.store.root, "link");
    symlinkSync(human, link);
    expect(await unpushedWork(d, lane("fix-login", link))).toEqual([]);
    writeFileSync(join(wt, "h.ts"), "lane edit");
    expect(await unpushedWork(d, lane("fix-login", link))).toEqual([`uncommitted tracked changes in ${realpathSync(wt)}`]);
  });
});
