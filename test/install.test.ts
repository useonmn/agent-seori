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
  const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

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
    Bun.spawnSync(["git", "init", "--quiet", upstream], { env: process.env });
    writeFileSync(join(upstream, "tracked.txt"), "one\n");
    git(upstream, "add", "tracked.txt");
    git(upstream, "commit", "--quiet", "-m", "one");
    git(upstream, "branch", "-M", "main");
    Bun.spawnSync(["git", "clone", "--quiet", upstream, dev], { env: process.env });
    return { root, upstream, dev, git };
  }

  /** Runs install.sh against `dev`, with the state home, the skills dir and HOME all inside the temp root. */
  function install(dev: string, root: string, extra: Record<string, string> = {}) {
    // Nothing of this machine's own SEORI_* may leak in: the point is a checkout and a home under the temp root.
    const env: Record<string, string | undefined> = { ...process.env, HOME: join(root, "home"), SEORI_HOME: join(root, "state"), SEORI_SRC: dev, SKILLS_DIR: join(root, "skills"), ...extra };
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
    expect(r.err).toContain("SEORI_NO_PULL=1 bash install.sh");
    expect(r.err).toContain(`see "Working on seori itself" in README.md`);
    expect(r.err).toContain("git -C \"" + realpathSync(dev) + "\" pull --rebase");
    expect(readFileSync(join(dev, "tracked.txt"), "utf8")).toBe("edited\n");
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
