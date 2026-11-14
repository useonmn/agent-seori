import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  const gitEnv = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  };

  // A local origin and a clone of it, so `@{u}` exists and no network is needed. `bun` is real (install.sh only checks
  // that it is on PATH before the update block); nothing here reaches `bun link`, because every run stops at the update
  // decision or at the "not a seori checkout" check that follows it.
  function checkout() {
    const root = dir();
    const upstream = join(root, "upstream");
    const dev = join(root, "dev");
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, ...gitEnv }, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    Bun.spawnSync(["git", "init", "--quiet", upstream], { env: { ...process.env, ...gitEnv } });
    writeFileSync(join(upstream, "tracked.txt"), "one\n");
    git(upstream, "add", "tracked.txt");
    git(upstream, "commit", "--quiet", "-m", "one");
    git(upstream, "branch", "-M", "main");
    Bun.spawnSync(["git", "clone", "--quiet", upstream, dev], { env: { ...process.env, ...gitEnv } });
    return { root, upstream, dev, git };
  }

  /**
   * A checkout that passes install.sh's "is this a seori checkout" check, so a run reaches `bun link`. It is a local
   * origin and a clone of it carrying this repository's package.json (with its devDependencies dropped, so `bun install`
   * needs no network), the seori-mode skill directory and the package's bin target. Nothing but a temp tree is written.
   */
  function seoriCheckout() {
    const c = checkout();
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    delete pkg.devDependencies;
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
    // Nothing of this machine's own SEORI_* may leak in either: the point is a checkout and a home under the temp root.
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: join(root, "home"),
      BUN_INSTALL: join(root, "bun"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      SEORI_HOME: join(root, "state"),
      SEORI_SRC: dev,
      SKILLS_DIR: join(root, "skills"),
      ...extra,
    };
    for (const k of Object.keys(env)) if (k.startsWith("SEORI_") && !["SEORI_HOME", "SEORI_SRC", "SEORI_NO_PULL"].includes(k)) delete env[k];
    const r = Bun.spawnSync(["bash", INSTALL], { env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
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
    // The remedies name the script's own file, so they work from anywhere, and the keep-the-work one autostashes the
    // very edits that triggered the refusal (plain `pull --rebase` refuses unstaged changes).
    expect(r.err).toContain(`SEORI_NO_PULL=1 bash "${realpathSync(INSTALL)}"`);
    expect(r.err).toContain("pull --rebase --autostash");
    expect(r.err).toContain(`see "Working on seori itself" in README.md`);
    expect(readFileSync(join(dev, "tracked.txt"), "utf8")).toBe("edited\n");
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
    // The update block never claimed anything about local work: git's own "no upstream" message is the explanation.
    expect(r.err).not.toContain("has local work");
    expect(r.err).toContain("Could not update");
    expect(readFileSync(join(dev, "tracked.txt"), "utf8")).toBe("edited\n");
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
  });
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
});
