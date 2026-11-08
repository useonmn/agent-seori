import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The skill half of install.sh / install.ps1, and `seori uninstall`, in bun so macOS, Linux and Windows share it.

/** Where omp loads user skills: SKILLS_DIR, else ~/.omp/agent/skills. */
export const defaultSkillsDir = (env: Record<string, string | undefined> = process.env): string =>
  env["SKILLS_DIR"] || join(homedir(), ".omp", "agent", "skills");

/** The checkout this CLI runs from: its skills/seori-mode is what gets linked. */
export const SEORI_SRC = resolve(import.meta.dir, "..");

/** A copied skill (where no link could be made) carries this file, so a later install refreshes it and uninstall removes it. */
export const COPY_MARK = ".seori-copy";

const SKILL = "seori-mode";

/** Removes a symlink or a Windows junction without touching what it points to (a junction is removed like a directory). */
const removeLink = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
};

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Links `<src>/skills/seori-mode` into the skills directory: a symlink on macOS/Linux, a directory junction on Windows
 * (no admin rights or developer mode needed). An existing link or an earlier seori copy is replaced, so a reinstall
 * never leaves an old skill behind; any other directory there is the owner's and is left alone. If no link can be made,
 * the skill is copied with COPY_MARK, and the next install refreshes the copy.
 */
export function installSkill(
  src: string = SEORI_SRC,
  skillsDir: string = defaultSkillsDir(),
  platform: string = process.platform,
): { ok: boolean; note: string } {
  const target = join(resolve(src), "skills", SKILL);
  if (!existsSync(join(target, "SKILL.md"))) return { ok: false, note: `${target} has no SKILL.md; not a seori checkout` };
  mkdirSync(skillsDir, { recursive: true });
  const link = join(skillsDir, SKILL);
  if (existsSync(link) || isLink(link)) {
    if (!isLink(link) && !existsSync(join(link, COPY_MARK))) {
      return { ok: false, note: `NOT linked: ${link} exists and is not a link (move it away and install again)` };
    }
    if (isLink(link)) removeLink(link);
    else rmSync(link, { recursive: true, force: true });
  }
  try {
    symlinkSync(target, link, platform === "win32" ? "junction" : "dir");
    return { ok: true, note: `${link} -> ${target}` };
  } catch (e) {
    cpSync(target, link, { recursive: true });
    writeFileSync(join(link, COPY_MARK), `${target}\n`);
    return { ok: true, note: `${link} (a copy of ${target}: no link could be made, ${e instanceof Error ? e.message : String(e)}; install again after updating)` };
  }
}

/**
 * `seori uninstall`: removes the skill link (or seori's own copy) and unlinks the `seori` command from bun's global bin.
 * $SEORI_HOME (secrets, messages, lanes) is removed only with `purge`. The CLI runs `seori down` first; the lead and
 * duty omp panes `seori up` opened keep running: the returned lines say to close that workspace.
 */
export async function uninstall(
  opts: { src?: string; skillsDir?: string; home: string; name?: string; purge: boolean; unlink?: (src: string) => Promise<string> },
): Promise<string[]> {
  const src = opts.src ?? SEORI_SRC;
  const out: string[] = [];
  const link = join(opts.skillsDir ?? defaultSkillsDir(), SKILL);
  if (isLink(link)) {
    const to = (() => {
      try {
        return readlinkSync(link);
      } catch {
        return "?";
      }
    })();
    removeLink(link);
    out.push(`removed skill link ${link} (-> ${to})`);
  } else if (existsSync(join(link, COPY_MARK))) {
    rmSync(link, { recursive: true, force: true });
    out.push(`removed skill copy ${link}`);
  } else if (existsSync(link)) out.push(`left ${link}: not a link or a seori copy`);
  else out.push(`no skill at ${link}`);
  const unlink = opts.unlink ?? bunUnlink;
  out.push(await unlink(src));
  if (opts.purge) {
    rmSync(opts.home, { recursive: true, force: true });
    out.push(`removed ${opts.home}`);
  } else if (existsSync(opts.home)) out.push(`kept ${opts.home} (secrets, messages, lanes); remove it with seori uninstall --purge`);
  out.push(`Close the ${opts.name ?? "seori"} workspace in herdr to end the lead and duty omp (seori down stopped its loops and daemon).`);
  return out;
}

async function bunUnlink(src: string): Promise<string> {
  const p = Bun.spawn(["bun", "unlink"], { cwd: src, env: process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return code === 0 ? `unlinked the seori command (bun unlink in ${src})` : `bun unlink in ${src} failed (${(stderr || stdout).trim() || code}); the seori command may still be on PATH`;
}
