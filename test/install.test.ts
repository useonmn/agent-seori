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
   * Reads one `NAME=value` out of a printed remedy. install.sh writes these with `printf %q`, which quotes only when it
   * has to: a plain path appears as `SEORI_SRC=/tmp/x/dev`. Both the quoted and the bare form are accepted.
   */
  const remedyField = (line: string, name: string) =>
    line.match(new RegExp(`${name}=(?:"([^"]+)"|(\\S+))`))?.slice(1).find((v) => v !== undefined);

  /**
   * The value a shell would see for `NAME` in a printed remedy. `printf %q` escapes metacharacters (`dev\$\(touch\ …`),
   * so a path containing `$`, a backtick, a quote or a space can only be compared after the shell has read it back.
   */
  const shellValue = (line: string, name: string) => {
    const r = Bun.spawnSync(["bash", "-c", `set -- ${line.match(new RegExp(`${name}=((?:\\\\.|[^\\s\\\\])*)`))?.[1] ?? ""}; printf '%s' "$1"`], { stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString();
  };
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
    // Every SEORI_* of this shell is deleted first, then the temp defaults and `extra` are applied: keeping one back
    // (SEORI_NO_PULL, say) would let `SEORI_NO_PULL=1 bun test` change what these cases exercise.
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("SEORI_")) delete env[k];
    Object.assign(env, {
      HOME: join(root, "home"),
      BUN_INSTALL: join(root, "bun"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      SEORI_HOME: join(root, "state"),
      SEORI_SRC: dev,
      SKILLS_DIR: join(root, "skills"),
    }, extra);
    // The script's own git calls (fetch, merge, status) are isolated the same way the fixture's are: a host
    // `core.hooksPath` or `fetch.*` setting would otherwise reach them and red a case that has nothing to do with it.
    Object.assign(env, gitEnv);
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
    // The remedies reproduce this very install: they carry the resolved SEORI_SRC (without it, pasting the printed line
    // installs a *different* tree — the default checkout — and repoints the machine-wide `seori` at it), the homes that
    // differ from the defaults, and the script's own path so they run from anywhere. Each field is compared after
    // resolving both sides: on macOS /var is a symlink to /private/var, so a hand-built expected string mixes forms.
    const remedy = r.err.split("\n").find((l) => l.includes("install this checkout as it is:"));
    expect(remedy).toBeDefined();
    // `printf %q` leaves a plain path bare and quotes only when it must, so the reader accepts both forms.
    expect(samePath(remedyField(remedy!, "SEORI_SRC"), dev)).toBe(true);
    expect(samePath(remedyField(remedy!, "SEORI_HOME"), join(root, "state"))).toBe(true);
    expect(samePath(remedyField(remedy!, "SKILLS_DIR"), join(root, "skills"))).toBe(true);
    expect(samePath(remedy!.split("bash ")[1]!.replace(/"/g, ""), INSTALL)).toBe(true);
    expect(remedy).toContain("SEORI_NO_PULL=1");
    expect(r.err).toContain("pull --rebase --autostash");
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
    // With no upstream there is nothing to wait for, so the refusal block stays out of it and the merge fails on git's own
    // line. The fallback names that cause — a missing upstream, not local work, which stashing would not fix.
    expect(r.err).not.toContain("has commits it does not");
    expect(r.err).toContain("Could not update");
    expect(r.err).toContain("its branch has no upstream to merge from");
    expect(r.err).not.toContain("it has local work (listed below)");
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

  // The point of the remedies: a printed line, pasted as-is, must install the tree that printed it. A remedy missing
  // SEORI_SRC re-runs against the default checkout instead and repoints the machine-wide `seori` at it — the developer
  // then believes their edited checkout is installed when it is not. This runs the printed line verbatim.
  test("the printed remedy, pasted verbatim, installs the checkout that printed it", () => {
    const { root, upstream, dev, git } = seoriCheckout();
    writeFileSync(join(dev, "tracked.txt"), "edited\n");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");

    const first = install(dev, root);
    expect(first.code).toBe(1);
    const line = first.err.split("\n").find((l) => l.includes("install this checkout as it is:"));
    expect(line).toBeDefined();
    const command = line!.slice(line!.indexOf("SEORI_NO_PULL=1"));

    // The environment the refusal came from, minus SEORI_*: the pasted command must carry everything it needs.
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("SEORI_")) delete env[k];
    Object.assign(env, { HOME: join(root, "home"), BUN_INSTALL: join(root, "bun"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") });
    const r = Bun.spawnSync(["bash", "-c", command], { env, stdout: "pipe", stderr: "pipe" });
    // It installed the dev checkout, not a fresh clone of the default one.
    expect(r.stdout.toString()).toContain(`Installed seori from ${realpathSync(dev)}`);
    expect(realpathSync(join(root, "bun", "install", "global", "node_modules", "seori"))).toBe(realpathSync(dev));
  });

  // Through `curl | bash` there is no file to name, so the remedy is the one-liner — and it must carry SEORI_SRC for the
  // same reason: without it the re-run installs the default checkout, not the one that refused.
  test("the piped variant's remedy names SEORI_SRC and the one-liner, not a cwd-relative file", () => {
    const { root, upstream, dev, git } = seoriCheckout();
    writeFileSync(join(dev, "tracked.txt"), "edited\n");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");

    // Piping the script through stdin is the `curl … | bash` shape: BASH_SOURCE is /dev/stdin, so no path can be named.
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("SEORI_")) delete env[k];
    Object.assign(env, { HOME: join(root, "home"), BUN_INSTALL: join(root, "bun"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), SEORI_HOME: join(root, "state"), SEORI_SRC: dev, SKILLS_DIR: join(root, "skills") });
    const r = Bun.spawnSync(["bash", "-c", `cat "${INSTALL}" | bash`], { env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    const line = r.stderr.toString().split("\n").find((l) => l.includes("install this checkout as it is:"));
    expect(line).toBeDefined();
    // Every path field compared with the same resolved-prefix rule as the file mode: /var and /private/var are one place
    // on macOS, and a hand-built `toContain(realpathSync(...))` string mixes the two forms.
    // Same reader for both forms: `printf %q` leaves a plain path bare and quotes only when it must.
    expect(samePath(remedyField(line!, "SEORI_SRC"), dev)).toBe(true);
    expect(samePath(remedyField(line!, "SEORI_HOME"), join(root, "state"))).toBe(true);
    expect(samePath(remedyField(line!, "SKILLS_DIR"), join(root, "skills"))).toBe(true);
    expect(line).toContain("curl -fsSL");
  });
  // The remedies must carry the *resolved* checkout. A relative SEORI_SRC is the sharpest test: pasted from any other
  // directory, a raw `./dev` names a different tree (or none), and installing that repoints the machine-wide `seori` at
  // it. This is the failure the review reproduced, so it is pinned here: run the printed line from an unrelated cwd and
  // check that the global link landed on the intended dev checkout.
  test("a relative SEORI_SRC: the printed remedy, run from another cwd, installs that same checkout", () => {
    const { root, upstream, dev, git } = seoriCheckout();
    writeFileSync(join(dev, "tracked.txt"), "edited\n");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");

    // Relative to the clone's parent, which is how `SEORI_SRC=./dev bash install.sh` is normally written.
    const parent = join(root);
    const rel = `./${dev.slice(parent.length + 1)}`;
    const env = (): Record<string, string | undefined> => {
      const e: Record<string, string | undefined> = { ...process.env };
      for (const k of Object.keys(e)) if (k.startsWith("SEORI_")) delete e[k];
      Object.assign(e, { HOME: join(root, "home"), BUN_INSTALL: join(root, "bun"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), SEORI_HOME: join(root, "state"), SKILLS_DIR: join(root, "skills"), SEORI_SRC: rel });
      return e;
    };
    // The refusal from the parent directory, with the relative SEORI_SRC.
    const first = Bun.spawnSync(["bash", INSTALL], { env: env(), cwd: parent, stdout: "pipe", stderr: "pipe" });
    expect(first.exitCode).toBe(1);
    const line = first.stderr.toString().split("\n").find((l) => l.includes("install this checkout as it is:"));
    expect(line).toBeDefined();
    // The remedy names an absolute, resolved path — not the `./dev` it was given.
    expect(samePath(remedyField(line!, "SEORI_SRC"), dev)).toBe(true);

    // Paste it from somewhere unrelated: the global link must end up on the intended checkout, not on a default clone.
    const command = line!.slice(line!.indexOf("SEORI_NO_PULL=1"));
    const r = Bun.spawnSync(["bash", "-c", command], { env: env(), cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(r.stdout.toString()).toContain(`Installed seori from ${realpathSync(dev)}`);
    expect(realpathSync(join(root, "bun", "install", "global", "node_modules", "seori"))).toBe(realpathSync(dev));
  });

  // A symlinked checkout has two spellings; the refusal prints the resolved one, so the remedy must agree with it, or a
  // reader pasting it installs a path the rest of the message never named.
  test("a symlinked SEORI_SRC: the remedy names the same path the refusal does", () => {
    const { root, upstream, dev, git } = seoriCheckout();
    writeFileSync(join(dev, "tracked.txt"), "edited\n");
    writeFileSync(join(upstream, "tracked.txt"), "two\n");
    git(upstream, "commit", "--quiet", "-am", "two");
    const link = join(root, "dev-link");
    symlinkSync(dev, link);

    const r = install(link, root);
    expect(r.code).toBe(1);
    // The refusal and the remedy agree: both name the resolved checkout, and neither echoes the symlink.
    expect(r.err).toContain(`${realpathSync(dev)} has local work`);
    const line = r.err.split("\n").find((l) => l.includes("install this checkout as it is:"));
    expect(samePath(remedyField(line!, "SEORI_SRC"), dev)).toBe(true);
    expect(remedyField(line!, "SEORI_SRC")).not.toBe(link);
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
      const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, ...gitEnv }, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    expect(Bun.spawnSync(["git", "clone", "--quiet", c.upstream, nasty], { env: { ...process.env, ...gitEnv } }).exitCode).toBe(0);
    nastyGit(nasty, "branch", "--set-upstream-to=origin/main");
    writeFileSync(join(nasty, "tracked.txt"), "edited locally\n");
    // Upstream moves on, so the guard has a waiting update to refuse.
    writeFileSync(join(c.upstream, "tracked.txt"), "two\n");
    c.git(c.upstream, "commit", "--quiet", "-am", "two");

    const r = install(nasty, c.root);
    // Whatever it decides, nothing in the path may have executed.
    expect(existsSync(canary)).toBe(false);
    expect(r.code).toBe(1);
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("SEORI_")) delete env[k];
    Object.assign(env, { HOME: join(c.root, "home"), BUN_INSTALL: join(c.root, "bun"), XDG_CONFIG_HOME: join(c.root, "config"), XDG_DATA_HOME: join(c.root, "data"), XDG_CACHE_HOME: join(c.root, "cache") }, gitEnv);

    // Each of the three printed remedies, on its own. Remedy 1 is read first because pasting it installs the checkout;
    // the two git remedies are pasted too, since a hand-quoted `"$src"` in *any* of them runs the name on paste.
    const line = (what: string) => r.err.split("\n").find((l) => l.includes(what));
    const asIs = line("install this checkout as it is:")!;
    expect(asIs).toBeDefined();
    const command = asIs.slice(asIs.indexOf("SEORI_NO_PULL=1"));
    // The line names the checkout that printed it, read the way a shell would: `printf %q` escapes the metacharacters
    // (`dev\$\(touch\ …`) rather than hiding the path. Compared with the resolved-prefix rule, because install.sh prints
    // `pwd -P` output while this path may still carry a symlinked prefix (`/var` vs `/private/var` on macOS).
    expect(samePath(shellValue(command, "SEORI_SRC"), nasty)).toBe(true);
    const pasted = Bun.spawnSync(["bash", "-c", command], { env, stdout: "pipe", stderr: "pipe" });
    expect(existsSync(canary)).toBe(false);
    expect(pasted.stdout.toString()).toContain("Installed seori from");
    expect(existsSync(join(c.root, "bun", "install", "global", "node_modules", "seori"))).toBe(true);
    expect(samePath(realpathSync(join(c.root, "bun", "install", "global", "node_modules", "seori")), nasty)).toBe(true);
    for (const what of ["update it and keep the work:", "update it and drop the work:"]) {
      const text = line(what)!;
      expect(text).toBeDefined();
      const cmd = text.slice(text.indexOf("git -C "));
      // Pasting the git half of the remedy must not run anything out of the name either. It may fail (a rebase with a
      // dirty tree, a reset that moves the branch) — what matters is that it never creates the canary.
      Bun.spawnSync(["bash", "-c", cmd], { env, stdout: "pipe", stderr: "pipe" });
      expect(existsSync(canary)).toBe(false);
    }
  });
});
