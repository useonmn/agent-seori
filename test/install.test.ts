import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COPY_MARK, installSkill, SEORI_SRC, uninstall } from "../src/install.ts";

const dir = () => mkdtempSync(join(tmpdir(), "seori-install-"));
const skill = (skills: string) => join(skills, "seori-mode");

describe("installSkill (I7: a symlink to the checkout)", () => {
  test("links the checkout's skill; a reinstall replaces the link and the skill reads the checkout's current file", () => {
    const skills = dir();
    expect(installSkill(SEORI_SRC, skills).ok).toBe(true);
    expect(lstatSync(skill(skills)).isSymbolicLink()).toBe(true);
    expect(realpathSync(skill(skills))).toBe(realpathSync(join(SEORI_SRC, "skills", "seori-mode")));
    expect(installSkill(SEORI_SRC, skills).ok).toBe(true);
    expect(readFileSync(join(skill(skills), "SKILL.md"), "utf8")).toBe(readFileSync(join(SEORI_SRC, "skills", "seori-mode", "SKILL.md"), "utf8"));
  });

  test("an old seori copy (a copy made where no link could be) is refreshed into a link; the owner's own directory is left alone", () => {
    const skills = dir();
    mkdirSync(skill(skills));
    writeFileSync(join(skill(skills), "SKILL.md"), "old");
    writeFileSync(join(skill(skills), COPY_MARK), "x");
    expect(installSkill(SEORI_SRC, skills).ok).toBe(true);
    expect(lstatSync(skill(skills)).isSymbolicLink()).toBe(true);

    const other = dir();
    mkdirSync(skill(other));
    writeFileSync(join(skill(other), "SKILL.md"), "mine");
    const r = installSkill(SEORI_SRC, other);
    expect(r).toEqual({ ok: false, note: `NOT linked: ${skill(other)} exists and is not a link (move it away and install again)` });
    expect(readFileSync(join(skill(other), "SKILL.md"), "utf8")).toBe("mine");
  });

  test("a checkout without the skill is refused", () => {
    expect(installSkill(dir(), dir()).ok).toBe(false);
  });
});

describe("uninstall (I6)", () => {
  const unlink = async () => "unlinked";

  test("removes the skill link and the command, keeps $SEORI_HOME unless --purge", async () => {
    const skills = dir();
    const home = dir();
    installSkill(SEORI_SRC, skills);
    const out = await uninstall({ skillsDir: skills, home, purge: false, unlink });
    expect(existsSync(skill(skills))).toBe(false);
    expect(existsSync(join(SEORI_SRC, "skills", "seori-mode", "SKILL.md"))).toBe(true);
    expect(out[1]).toBe("unlinked");
    expect(out[2]).toContain(`kept ${home}`);
    expect(existsSync(home)).toBe(true);
    await uninstall({ skillsDir: skills, home, purge: true, unlink });
    expect(existsSync(home)).toBe(false);
  });

  test("a directory that is not a link or a seori copy is never deleted", async () => {
    const skills = dir();
    mkdirSync(skill(skills));
    writeFileSync(join(skill(skills), "SKILL.md"), "mine");
    const out = await uninstall({ skillsDir: skills, home: dir(), purge: false, unlink });
    expect(out[0]).toBe(`left ${skill(skills)}: not a link or a seori copy`);
    expect(readFileSync(join(skill(skills), "SKILL.md"), "utf8")).toBe("mine");
  });
});

describe("install.sh and a checkout you develop in", () => {
  const INSTALL = join(import.meta.dir, "..", "install.sh");
  // The fixture's git must not inherit this host's config: a developer with `commit.gpgsign = true`, a signing key that
  // wants a pinentry, or a `core.hooksPath` full of enforced hooks would fail every commit here and red the whole block.

  /**
   * The same directory, whichever form the path is written in. install.sh resolves what it can with `cd … pwd -P`, and
   * the two sides of an assertion can still differ: on macOS /var is a symlink to /private/var (and TMPDIR lives under
   * it), while a hand-built expected path keeps the form it was built from. Resolve the longest existing prefix on each
   * side and compare that plus the remainder, which also works for directories that do not exist yet.
   */
  const samePath = (a: string | undefined, b: string) => {
    const norm = (p: string) => {
      const parts = p.split("/").filter(Boolean);
      for (let n = parts.length; n > 0; n--) {
        const head = "/" + parts.slice(0, n).join("/");
        if (existsSync(head)) return realpathSync(head) + "/" + parts.slice(n).join("/");
      }
      return p;
    };
    // A field that was never printed is a real failure, reported as such instead of throwing out of the assertion.
    expect(a).toBeDefined();
    return norm(a!) === norm(b);
  };

  /**
   * The value a shell would see for one printed word. `printf %q` escapes metacharacters (`dev\$\(touch\ …`) and spaces,
   * so a path can only be compared after a shell has read it back; the word is `printf %q` output, so reading it runs
   * nothing.
   */
  const shellWord = (word: string) =>
    Bun.spawnSync(["bash", "-c", `set -- ${word}; printf '%s' "$1"`], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
  /** One escaped word as `printf %q` prints it: escaped characters and anything but whitespace or a backslash. */
  const WORD = String.raw`((?:\\.|[^\s\\])*)`;
  /** `NAME=value` out of a printed remedy, read back through the shell; undefined when the remedy does not carry NAME. */
  const remedyField = (line: string, name: string) => {
    const word = line.match(new RegExp(String.raw`(?:^|\s)${name}=` + WORD))?.[1];
    return word === undefined ? undefined : shellWord(word);
  };
  /** The script a remedy runs: the word after `bash` that ends the line, read back the same way. */
  const remedyScript = (line: string) => {
    const word = line.match(new RegExp(String.raw`(?:^|\s)bash ` + WORD + "$"))?.[1];
    return word === undefined ? undefined : shellWord(word);
  };
  /** The pasteable command install.sh printed after `label` on a remedy line of its own. */
  const remedyCommand = (err: string, label: string) => {
    const line = err.split("\n").find((l) => l.includes(label));
    expect(line).toBeDefined();
    return line!.slice(line!.indexOf(label) + label.length).trim();
  };

  const gitEnv = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  };
  /**
   * This process's environment with none of the host's seori or git state: every SEORI_* (so `SEORI_NO_PULL=1 bun test`
   * cannot change what a case exercises) and every GIT_* (a GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE exported by a hook
   * or `git rebase -x` would point the fixture's git, and install.sh's, at the host repository), then the fixture's own
   * git identity and config isolation, then `extra`.
   */
  function hostEnv(extra: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("SEORI_") || k.startsWith("GIT_")) delete env[k];
    return Object.assign(env, gitEnv, extra);
  }
  /** hostEnv with HOME, BUN_INSTALL and the XDG directories under `root` (install() says why each one matters). */
  const tempEnv = (root: string, extra: Record<string, string> = {}) =>
    hostEnv({
      HOME: join(root, "home"),
      BUN_INSTALL: join(root, "bun"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      ...extra,
    });
  /** A run that goes through `bun install` and `bun link` can outlast bun test's 5 s default on a cold runner. */
  const FULL_INSTALL_MS = 60_000;

  /**
   * A PATH with stub commands in front: each prints `out` (kept in a file beside it, so no text is re-read as shell) and
   * exits with `code`. Exit 127 with no output is what a missing command looks like to install.sh.
   */
  function stubPath(root: string, stubs: Record<string, { out?: string; code: number }>) {
    const bin = mkdtempSync(join(root, "stubs-"));
    for (const [name, { out, code }] of Object.entries(stubs)) {
      if (out !== undefined) writeFileSync(join(bin, `${name}.out`), out);
      writeFileSync(join(bin, name), `#!/bin/sh\n${out === undefined ? "" : 'cat "$0.out"\n'}exit ${code}\n`, { mode: 0o755 });
    }
    return `${bin}:${process.env.PATH ?? ""}`;
  }

  // A local origin and a clone of it, so `@{u}` exists and no network is needed. `bun` is real (install.sh only checks
  // that it is on PATH before the update block); nothing here reaches `bun link`, because every run stops at the update
  // decision or at the "not a seori checkout" check that follows it.
  function checkout() {
    const root = dir();
    const upstream = join(root, "upstream");
    const dev = join(root, "dev");
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: hostEnv(), stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    Bun.spawnSync(["git", "init", "--quiet", upstream], { env: hostEnv() });
    writeFileSync(join(upstream, "tracked.txt"), "one\n");
    git(upstream, "add", "tracked.txt");
    git(upstream, "commit", "--quiet", "-m", "one");
    git(upstream, "branch", "-M", "main");
    Bun.spawnSync(["git", "clone", "--quiet", upstream, dev], { env: hostEnv() });
    return { root, upstream, dev, git };
  }

  /**
   * A checkout that passes install.sh's "is this a seori checkout" check, so a run reaches `bun link`. It is a local
   * origin and a clone of it carrying this repository's package.json with every dependency set dropped (a full install
   * must stay network-free, so a new `dependencies` entry must not start downloading in CI), the seori-mode skill
   * directory and the package's bin target. Nothing but a temp tree is written.
   */
  function seoriCheckout() {
    const c = checkout();
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    delete pkg.dependencies;
    delete pkg.devDependencies;
    delete pkg.optionalDependencies;
    delete pkg.peerDependencies;
    mkdirSync(join(c.upstream, "skills", "seori-mode"), { recursive: true });
    mkdirSync(join(c.upstream, "src"), { recursive: true });
    writeFileSync(join(c.upstream, "package.json"), JSON.stringify(pkg, null, 2));
    // `bun link` writes the bin only when its target exists.
    writeFileSync(join(c.upstream, "src", "cli.ts"), "#!/usr/bin/env bun\n", { mode: 0o755 });
    writeFileSync(join(c.upstream, "skills", "seori-mode", "SKILL.md"), "skill\n");
    c.git(c.upstream, "add", "-A");
    c.git(c.upstream, "commit", "--quiet", "-m", "a seori checkout");
    c.git(c.dev, "pull", "--quiet", "--ff-only");
    return c;
  }


  /**
   * Runs install.sh against `dev` with every directory bun, seori and install.sh read moved inside the temp root: HOME,
   * BUN_INSTALL, the XDG directories, SEORI_HOME, SEORI_SRC and SKILLS_DIR. BUN_INSTALL matters as much as HOME, because
   * `bun link` picks its global directory from BUN_INSTALL first and only then from bun's install root under HOME; the
   * XDG variables are neutralised for the same reason (`bun install`'s cache, `seori up`'s unit directory). A run that
   * lets any of them through writes the machine's own files — the global `seori` link among them.
   */
  function install(dev: string, root: string, extra: Record<string, string> = {}) {
    // hostEnv drops every SEORI_* and GIT_* of this shell and isolates the script's own git calls (fetch, merge,
    // status) the way the fixture's are; then the temp defaults and `extra` are applied.
    const env = tempEnv(root, { SEORI_HOME: join(root, "state"), SEORI_SRC: dev, SKILLS_DIR: join(root, "skills"), ...extra });
    const r = Bun.spawnSync(["bash", INSTALL], { env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }
  /** A clone with an edit to tracked.txt while upstream commits a change to it: the case install.sh refuses. */
  function refusedCheckout(seori = false) {
    const c = seori ? seoriCheckout() : checkout();
    writeFileSync(join(c.dev, "tracked.txt"), "edited\n");
    writeFileSync(join(c.upstream, "tracked.txt"), "two\n");
    c.git(c.upstream, "commit", "--quiet", "-am", "two");
    return c;
  }

  test("local edits with an update waiting: it refuses before pulling, names the checkout, offers the three ways out", () => {
    const { root, upstream, dev, git } = checkout();
    writeFileSync(join(dev, "tracked.txt"), "edited\n");
    // Upstream moves on, so a fast-forward would succeed: the refusal must come from the local work meeting an update.
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");

    const r = install(dev, root);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${realpathSync(dev)} has local work and upstream has commits it does not, so install.sh did not pull:`);
    expect(r.err).toContain("M tracked.txt");
    // The remedies reproduce this very install: they carry the resolved SEORI_SRC (without it, pasting the printed line
    // installs a *different* tree — the default checkout — and repoints the machine-wide `seori` at it), the homes that
    // differ from the defaults, and the script's own path so they run from anywhere. Each field is compared after
    // resolving both sides: on macOS /var is a symlink to /private/var, so a hand-built expected string mixes forms.
    const remedy = remedyCommand(r.err, "install this checkout as it is:");
    // Each field is read back the way a shell would, so an escaped path (a space, a `$`) compares as the path it names.
    expect(samePath(remedyField(remedy, "SEORI_SRC"), dev)).toBe(true);
    expect(samePath(remedyField(remedy, "SEORI_HOME"), join(root, "state"))).toBe(true);
    expect(samePath(remedyField(remedy, "SKILLS_DIR"), join(root, "skills"))).toBe(true);
    expect(samePath(remedyScript(remedy), INSTALL)).toBe(true);
    expect(remedy.startsWith("SEORI_NO_PULL=1 ")).toBe(true);
    expect(r.err).toContain("pull --rebase --autostash");
    expect(readFileSync(join(dev, "tracked.txt"), "utf8")).toBe("edited\n");
  });

  // The login home decides whether a remedy carries HOME. It is read from the account database: getent first (Linux),
  // then dscl (macOS, which has no getent and keeps login accounts out of /etc/passwd). Stubs stand in for both, so the
  // case is the same on every host. Where the stub's answer equals HOME, nothing is carried; on a Linux host a wrong
  // parse would fall through to awk over the real /etc/passwd and carry HOME, which is what fails the "not carried" rows.
  test("the login home comes from getent, else from dscl in either layout; HOME is carried only when it differs", () => {
    const { root, dev } = refusedCheckout();
    const home = join(root, "login home"); // a space: dscl prints such a value on the line after the key
    mkdirSync(home);
    const missing = { code: 127 };
    const cases = [
      { getent: { out: "u:x:1:1::/elsewhere:/bin/sh\n", code: 0 }, dscl: missing, carried: true },
      { getent: { out: `u:x:1:1::${home}:/bin/sh\n`, code: 0 }, dscl: missing, carried: false },
      { getent: missing, dscl: { out: "NFSHomeDirectory: /elsewhere\n", code: 0 }, carried: true },
      { getent: missing, dscl: { out: "NFSHomeDirectory:\n /else where\n", code: 0 }, carried: true },
      { getent: missing, dscl: { out: `NFSHomeDirectory:\n ${home}\n`, code: 0 }, carried: false },
    ];
    for (const { getent, dscl, carried } of cases) {
      const r = install(dev, root, { HOME: home, PATH: stubPath(root, { getent, dscl }) });
      expect(r.code).toBe(1);
      const remedy = remedyCommand(r.err, "install this checkout as it is:");
      expect(carried ? samePath(remedyField(remedy, "HOME"), home) : remedyField(remedy, "HOME") === undefined).toBe(true);
      expect(samePath(remedyField(remedy, "SEORI_SRC"), dev)).toBe(true);
    }
  });

  // The real Directory Services lookup, where there is one: the temp HOME differs from the runner's login home.
  test.skipIf(process.platform !== "darwin")("on macOS the login home comes from the real dscl, so a temp HOME is carried", () => {
    const { root, dev } = refusedCheckout();
    const r = install(dev, root);
    expect(r.code).toBe(1);
    expect(samePath(remedyField(remedyCommand(r.err, "install this checkout as it is:"), "HOME"), join(root, "home"))).toBe(true);
  });

  // The login-home lookup is optional: with getent, dscl and awk all failing as a missing command does (macOS has no
  // getent; a minimal system may have none of them), the run must not die under `set -euo pipefail`. It skips only the
  // HOME-differs check and still refuses with the other remedies intact.
  test("no way to read the login home: the refusal still runs, its remedy just leaves HOME out", () => {
    const { root, dev } = refusedCheckout();
    const missing = { code: 127 };
    const r = install(dev, root, { PATH: stubPath(root, { getent: missing, dscl: missing, awk: missing }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${realpathSync(dev)} has local work and upstream has commits it does not, so install.sh did not pull:`);
    const remedy = remedyCommand(r.err, "install this checkout as it is:");
    expect(remedyField(remedy, "HOME")).toBeUndefined();
    expect(samePath(remedyField(remedy, "SEORI_SRC"), dev)).toBe(true);
    expect(samePath(remedyField(remedy, "BUN_INSTALL"), join(root, "bun"))).toBe(true);
  });

  // The ordering guarantee, pinned. A merge-first install.sh fast-forwards cleanly here — the edit is in a file upstream
  // does not touch, so nothing conflicts — and the run would report success while the tree moved under the edit. That is
  // the exact behaviour this PR exists to stop, and this test is what keeps a refactor from reintroducing it.
  test("an edit upstream does not touch still stops the pull: the checkout does not fast-forward under it", () => {
    const { root, upstream, dev, git } = checkout();
    writeFileSync(join(dev, "mine.txt"), "a local file upstream never sees\n");
    git(dev, "add", "mine.txt");
    writeFileSync(join(dev, "tracked.txt"), "one\n"); // untouched relative to upstream: no conflict is possible
    // Upstream moves a different file forward.
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");
    const headBefore = git(dev, "rev-parse", "HEAD");
    const upstreamHead = git(upstream, "rev-parse", "HEAD");
    expect(headBefore).not.toBe(upstreamHead);

    const r = install(dev, root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("has local work");
    // And the checkout is exactly where it was: the pull never ran.
    expect(git(dev, "rev-parse", "HEAD")).toBe(headBefore);
    expect(readFileSync(join(dev, "mine.txt"), "utf8")).toBe("a local file upstream never sees\n");
    expect(git(dev, "status", "--porcelain", "--untracked-files=no")).toContain("A  mine.txt");
  });

  test("local edits and nothing upstream to take: the reinstall still runs, touching no file", () => {
    const { root, dev, git } = checkout();
    writeFileSync(join(dev, "tracked.txt"), "edited\n");
    const head = git(dev, "rev-parse", "HEAD");

    const r = install(dev, root);
    expect(r.err).not.toContain("has local work");
    // Past the update block and stopped by the checkout check: the run got through the update decision.
    expect(r.err).toContain("is not a seori checkout");
    expect(git(dev, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(dev, "tracked.txt"), "utf8")).toBe("edited\n");
  });

  test("unpushed commits are named next to the waiting update, and the checkout is not pulled under them", () => {
    const { root, upstream, dev, git } = checkout();
    writeFileSync(join(dev, "mine.txt"), "x\n");
    git(dev, "add", "mine.txt");
    git(dev, "commit", "--quiet", "-m", "a commit only here");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");
    const head = git(dev, "rev-parse", "HEAD");

    const r = install(dev, root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Commits upstream does not have:");
    expect(r.err).toContain("a commit only here");
    expect(git(dev, "rev-parse", "HEAD")).toBe(head);
  });

  test("a branch with no upstream adds no git noise of its own: only git's message from the merge explains it", () => {
    const { root, upstream, dev, git } = checkout();
    // A local-only branch, which is what a scratch clone looks like: `@{u}` does not resolve.
    git(dev, "checkout", "--quiet", "-b", "scratch");
    writeFileSync(join(dev, "tracked.txt"), "edited\n");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");

    const r = install(dev, root);
    expect(r.code).toBe(1);
    // With no upstream there is nothing to wait for, so the refusal block stays out of it and the merge fails on git's own
    // line. The fallback names that cause — a missing upstream, not local work, which stashing would not fix.
    expect(r.err).not.toContain("has commits it does not");
    expect(r.err).toContain("Could not update");
    expect(r.err).toContain("its branch has no upstream to merge from");
    expect(r.err).not.toContain("it has local work (listed below)");
    expect(readFileSync(join(dev, "tracked.txt"), "utf8")).toBe("edited\n");
    // Each remedy stands on its own line, so pasting one takes the command and nothing glued to it.
    expect(remedyCommand(r.err, "set one:")).toEndWith("branch --set-upstream-to=origin/main");
    expect(samePath(remedyScript(remedyCommand(r.err, "install this checkout as it is:")), INSTALL)).toBe(true);
  });

  // A detached HEAD has no branch to give an upstream, so `branch --set-upstream-to` would fail as printed: the advice is
  // to switch to main (and update) or to install the checkout as it is.
  test("a detached HEAD: the advice switches to main or installs as it is, and never sets an upstream", () => {
    const { root, upstream, dev, git } = checkout();
    git(dev, "checkout", "--quiet", "--detach");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");

    const r = install(dev, root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("HEAD is detached, so there is no branch to update");
    expect(r.err).not.toContain("--set-upstream-to");
    const toMain = remedyCommand(r.err, "switch to main and update it:");
    expect(toMain).toStartWith("git -C ");
    expect(samePath(remedyScript(toMain), INSTALL)).toBe(true);
    expect(samePath(remedyScript(remedyCommand(r.err, "install this checkout as it is:")), INSTALL)).toBe(true);
  });

  // A rebase that stops on a conflict also detaches HEAD, so it must be named as the conflict it is: `switch main` fails
  // mid-rebase, and the way out is to finish or abort the rebase.
  test("a rebase stopped on a conflict: named as unresolved conflicts, with the rebase's own way out, not as a detached HEAD", () => {
    const { root, upstream, dev, git } = checkout();
    writeFileSync(join(dev, "tracked.txt"), "mine\n");
    git(dev, "commit", "--quiet", "-am", "mine");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");
    expect(Bun.spawnSync(["git", "-C", dev, "pull", "--quiet", "--rebase"], { env: hostEnv(), stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(0);
    expect(git(dev, "ls-files", "--unmerged")).not.toBe("");

    const r = install(dev, root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("it has unresolved conflicts (listed below), so nothing was merged or installed");
    expect(r.err).toContain("`git rebase --continue`");
    expect(r.err).toContain("`git rebase --abort`");
    expect(r.err).not.toContain("HEAD is detached");
    expect(r.err).not.toContain("switch main");
  });

  test("an untracked file (a test log) is not local work: it fast-forwards and installs the checkout as it is", () => {
    const { root, upstream, dev, git } = checkout();
    writeFileSync(join(dev, "test.log"), "log\n");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");
    const upstreamHead = git(upstream, "rev-parse", "HEAD");

    const r = install(dev, root);
    expect(r.err).not.toContain("has local work");
    expect(git(dev, "rev-parse", "HEAD")).toBe(upstreamHead);
    expect(existsSync(join(dev, "test.log"))).toBe(true);
    // Past the update block, it stops at the checkout check: proof that the pull was not what ended the run.
    expect(r.err).toContain(`is not a seori checkout`);
  });
  // The boundary this test guards was breached for real on this host: a `bun link` from a throwaway checkout, with the
  // developer's own BUN_INSTALL still set, repointed the machine-wide `seori` and took the CLI off PATH. So the assertion
  // is not "the temp tree looks right" but "nothing outside the temp root moved". The run is a full install.sh: past the
  // update block, through `bun install` and `bun link`, on to the skill link and the summary.
  test("a full install.sh run writes the temp BUN_INSTALL and leaves the machine's own global seori alone", () => {
    const { root, dev } = seoriCheckout();
    // What this host's own global link resolves to, read from the real environment before the run.
    const machineGlobal = (): string | null => {
      const p = join(process.env.BUN_INSTALL ?? join(process.env.HOME ?? "", ".bun"), "install", "global", "node_modules", "seori");
      return existsSync(p) ? realpathSync(p) : null;
    };
    const globalBefore = machineGlobal();

    const r = install(dev, root, { SEORI_NO_PULL: "1" });
    expect(r.code).toBe(0);
    // Past the update block, through bun, to the summary: the full run, not the update-decision stub. The skill step
    // warns because the fixture's src/cli.ts is a stub and cannot answer `install-skill`; that is the one part of a real
    // install this test does not exercise, and it links into SKILLS_DIR under the temp root, not the machine's.
    expect(r.out).toContain(`Installed seori from ${realpathSync(dev)}`);

    // The link landed in the temp root, pointing at the temp checkout, with the bin beside it.
    expect(realpathSync(join(root, "bun", "install", "global", "node_modules", "seori"))).toBe(realpathSync(dev));
    expect(existsSync(join(root, "bun", "bin", "seori"))).toBe(true);

    // The machine's own global link is exactly where it was (or still absent, on a host that has none).
    expect(machineGlobal()).toBe(globalBefore);
  }, FULL_INSTALL_MS);
  test("SEORI_NO_PULL=1 installs a dirty checkout as it is, saying so", () => {
    const { root, upstream, dev, git } = checkout();
    writeFileSync(join(dev, "tracked.txt"), "edited\n");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");
    const head = git(dev, "rev-parse", "HEAD");

    const r = install(dev, root, { SEORI_NO_PULL: "1" });
    expect(r.err).toContain("SEORI_NO_PULL=1: installing " + realpathSync(dev) + " as it is, without pulling");
    expect(git(dev, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(dev, "tracked.txt"), "utf8")).toBe("edited\n");
  });

  // The point of the remedies: a printed line, pasted as-is, must install the tree that printed it. A remedy missing
  // SEORI_SRC re-runs against the default checkout instead and repoints the machine-wide `seori` at it — the developer
  // then believes their edited checkout is installed when it is not. This runs the printed line verbatim.
  test("the printed remedy, pasted verbatim, installs the checkout that printed it", () => {
    const { root, dev } = refusedCheckout(true);
    const first = install(dev, root);
    expect(first.code).toBe(1);

    // The environment the refusal came from, minus SEORI_*: the pasted command must carry everything it needs.
    const r = Bun.spawnSync(["bash", "-c", remedyCommand(first.err, "install this checkout as it is:")], { env: tempEnv(root), stdout: "pipe", stderr: "pipe" });
    // It installed the dev checkout, not a fresh clone of the default one.
    expect(r.stdout.toString()).toContain(`Installed seori from ${realpathSync(dev)}`);
    expect(realpathSync(join(root, "bun", "install", "global", "node_modules", "seori"))).toBe(realpathSync(dev));
  }, FULL_INSTALL_MS);

  // Remedy 2 chains an install after the pull, and that install must reproduce this one: a bare `install.sh` there
  // installs the *default* checkout in a shell without SEORI_SRC, which is the failure this PR exists to stop. Pasted
  // whole, in a shell with no SEORI_*, it keeps the work, takes the update and installs the checkout that printed it.
  test("remedy 2 pasted whole keeps the work, takes the update and installs that same checkout", () => {
    const { root, upstream, dev, git } = seoriCheckout();
    // Local work in a file upstream does not touch, so the autostash comes back cleanly.
    writeFileSync(join(dev, "skills", "seori-mode", "SKILL.md"), "my skill\n");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");
    const first = install(dev, root);
    expect(first.code).toBe(1);

    const r = Bun.spawnSync(["bash", "-c", remedyCommand(first.err, "update it and keep the work:")], { env: tempEnv(root), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain(`Installed seori from ${realpathSync(dev)}`);
    expect(realpathSync(join(root, "bun", "install", "global", "node_modules", "seori"))).toBe(realpathSync(dev));
    expect(git(dev, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(readFileSync(join(dev, "skills", "seori-mode", "SKILL.md"), "utf8")).toBe("my skill\n");
  }, FULL_INSTALL_MS);

  // `git pull --rebase --autostash` exits 0 even when the autostash stops on a conflict. The chained install carries no
  // SEORI_NO_PULL, so it checks the tree again and refuses the unmerged index instead of installing a conflicted tree.
  test("remedy 2 whose autostash stops on a conflict: the chained install refuses and installs nothing", () => {
    const { root, dev, git } = refusedCheckout(true); // tracked.txt changed on both sides
    const first = install(dev, root);
    expect(first.code).toBe(1);

    const r = Bun.spawnSync(["bash", "-c", remedyCommand(first.err, "update it and keep the work:")], { env: tempEnv(root), stdout: "pipe", stderr: "pipe" });
    expect(git(dev, "ls-files", "--unmerged")).not.toBe("");
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("it has unresolved conflicts (listed below), so nothing was merged or installed");
    expect(r.stdout.toString()).not.toContain("Installed seori");
    expect(existsSync(join(root, "bun", "install", "global", "node_modules", "seori"))).toBe(false);
  });

  // Through `curl | bash` there is no file to name, so the remedy is the one-liner — and it must carry SEORI_SRC for the
  // same reason: without it the re-run installs the default checkout, not the one that refused.
  test("the piped variant's remedy names SEORI_SRC and the one-liner, not a cwd-relative file", () => {
    const { root, dev } = refusedCheckout(true);

    // Piping the script through stdin is the `curl … | bash` shape: BASH_SOURCE is /dev/stdin, so no path can be named.
    // The script's path goes in as an argument, never into the command text, so no path needs escaping here.
    const env = tempEnv(root, { SEORI_HOME: join(root, "state"), SEORI_SRC: dev, SKILLS_DIR: join(root, "skills") });
    const r = Bun.spawnSync(["bash", "-c", 'cat "$1" | bash', "_", INSTALL], { env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    const err = r.stderr.toString();
    const line = remedyCommand(err, "install this checkout as it is:");
    // Every path field compared with the same resolved-prefix rule as the file mode: /var and /private/var are one place
    // on macOS, and a hand-built `toContain(realpathSync(...))` string mixes the two forms.
    expect(samePath(remedyField(line, "SEORI_SRC"), dev)).toBe(true);
    expect(samePath(remedyField(line, "SEORI_HOME"), join(root, "state"))).toBe(true);
    expect(samePath(remedyField(line, "SKILLS_DIR"), join(root, "skills"))).toBe(true);
    expect(line).toEndWith("bash <(curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh)");
    // The re-fetched script may be newer than the one that refused, and the refusal says so.
    expect(err).toContain("These commands fetch install.sh from main again");
  });
  // The remedies must carry the *resolved* checkout. A relative SEORI_SRC is the sharpest test: pasted from any other
  // directory, a raw `./dev` names a different tree (or none), and installing that repoints the machine-wide `seori` at
  // it. This is the failure the review reproduced, so it is pinned here: run the printed line from an unrelated cwd and
  // check that the global link landed on the intended dev checkout.
  test("a relative SEORI_SRC: the printed remedy, run from another cwd, installs that same checkout", () => {
    const { root, dev } = refusedCheckout(true);

    // Relative to the clone's parent, which is how `SEORI_SRC=./dev bash install.sh` is normally written.
    const parent = join(root);
    const rel = `./${dev.slice(parent.length + 1)}`;
    const env = tempEnv(root, { SEORI_HOME: join(root, "state"), SKILLS_DIR: join(root, "skills"), SEORI_SRC: rel });
    // The refusal from the parent directory, with the relative SEORI_SRC.
    const first = Bun.spawnSync(["bash", INSTALL], { env, cwd: parent, stdout: "pipe", stderr: "pipe" });
    expect(first.exitCode).toBe(1);
    const command = remedyCommand(first.stderr.toString(), "install this checkout as it is:");
    // The remedy names an absolute, resolved path — not the `./dev` it was given.
    expect(samePath(remedyField(command, "SEORI_SRC"), dev)).toBe(true);

    // Paste it from somewhere unrelated: the global link must end up on the intended checkout, not on a default clone.
    const r = Bun.spawnSync(["bash", "-c", command], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(r.stdout.toString()).toContain(`Installed seori from ${realpathSync(dev)}`);
    expect(realpathSync(join(root, "bun", "install", "global", "node_modules", "seori"))).toBe(realpathSync(dev));
  }, FULL_INSTALL_MS);

  // A symlinked checkout has two spellings; the refusal prints the resolved one, so the remedy must agree with it, or a
  // reader pasting it installs a path the rest of the message never named.
  test("a symlinked SEORI_SRC: the remedy names the same path the refusal does", () => {
    const { root, dev } = refusedCheckout(true);
    const link = join(root, "dev-link");
    symlinkSync(dev, link);

    const r = install(link, root);
    expect(r.code).toBe(1);
    // The refusal and the remedy agree: both name the resolved checkout, and neither echoes the symlink.
    expect(r.err).toContain(`${realpathSync(dev)} has local work`);
    const line = remedyCommand(r.err, "install this checkout as it is:");
    expect(samePath(remedyField(line, "SEORI_SRC"), dev)).toBe(true);
    expect(remedyField(line, "SEORI_SRC")).not.toBe(link);
  });

  // A directory name with shell syntax in it is the sharpest test of "safe to paste": every path in a remedy must be
  // `printf %q`-escaped, or pasting the line runs `$(…)` out of the path instead of installing from it. This checkout is
  // a real clone (so the guard fires exactly as for any other) that happens to live at a path containing `$(touch …)`,
  // and the pasted remedy must install it while never creating the canary file.
  test("a checkout at a path containing shell syntax: the printed remedy installs it and runs nothing from the name", () => {
    const c = seoriCheckout();
    const canary = join(c.root, "PWNED");
    // A sibling clone of the same origin, named with shell syntax. Being a clone is what makes the guard fire; a plain
    // copy would have no upstream, so no remedy would be printed and the test would prove nothing.
    const nasty = join(c.root, `dev$(touch ${canary})`);
    const nastyGit = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: hostEnv(), stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    expect(Bun.spawnSync(["git", "clone", "--quiet", c.upstream, nasty], { env: hostEnv() }).exitCode).toBe(0);
    nastyGit(nasty, "branch", "--set-upstream-to=origin/main");
    writeFileSync(join(nasty, "tracked.txt"), "edited locally\n");
    // Upstream moves on, so the guard has a waiting update to refuse.
    writeFileSync(join(c.upstream, "tracked.txt"), "two\n");
    c.git(c.upstream, "commit", "--quiet", "-am", "two");

    const r = install(nasty, c.root);
    // Whatever it decides, nothing in the path may have executed.
    expect(existsSync(canary)).toBe(false);
    expect(r.code).toBe(1);
    const env = tempEnv(c.root);

    // Each of the three printed remedies, on its own. Remedy 1 is read first because pasting it installs the checkout;
    // the two git remedies are pasted too, since a hand-quoted `"$src"` in *any* of them runs the name on paste.
    const command = remedyCommand(r.err, "install this checkout as it is:");
    // The line names the checkout that printed it, read the way a shell would: `printf %q` escapes the metacharacters
    // (`dev\$\(touch\ …`) rather than hiding the path. Compared with the resolved-prefix rule, because install.sh prints
    // `pwd -P` output while this path may still carry a symlinked prefix (`/var` vs `/private/var` on macOS).
    expect(samePath(remedyField(command, "SEORI_SRC"), nasty)).toBe(true);
    const pasted = Bun.spawnSync(["bash", "-c", command], { env, stdout: "pipe", stderr: "pipe" });
    expect(existsSync(canary)).toBe(false);
    expect(pasted.stdout.toString()).toContain("Installed seori from");
    expect(existsSync(join(c.root, "bun", "install", "global", "node_modules", "seori"))).toBe(true);
    expect(samePath(realpathSync(join(c.root, "bun", "install", "global", "node_modules", "seori")), nasty)).toBe(true);
    for (const what of ["update it and keep the work:", "update it and drop the work:"]) {
      const cmd = remedyCommand(r.err, what);
      // Pasting a git remedy must not run anything out of the name either. It may fail (an autostash that stops on a
      // conflict) or install (a reset that drops the work): what matters is that it never creates the canary.
      Bun.spawnSync(["bash", "-c", cmd], { env, stdout: "pipe", stderr: "pipe" });
      expect(existsSync(canary)).toBe(false);
    }
  }, FULL_INSTALL_MS);
});
