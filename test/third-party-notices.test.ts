import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const HEADER = "under the Sustainable Use License; see THIRD_PARTY_NOTICES.md";

function headered(): string[] {
  const files = [...new Bun.Glob("{src,test,.github}/**/*.{ts,yml}").scanSync({ cwd: root, dot: true })];
  return files.filter((f) => readFileSync(join(root, f), "utf8").split("\n", 3).some((l) => l.includes(HEADER))).sort();
}

function listed(): string[] {
  const text = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const section = text.slice(text.indexOf("## Sustainable Use License portions"));
  return [...section.matchAll(/^- (\S+)$/gm)].map((m) => m[1]!).sort();
}

test("THIRD_PARTY_NOTICES.md lists exactly the files that carry the Sustainable Use License header", () => {
  expect(listed()).toEqual(headered());
});
