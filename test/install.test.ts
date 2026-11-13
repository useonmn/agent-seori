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
