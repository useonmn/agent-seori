import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Store home permissions", () => {
  test("a home the Store creates is readable by its owner only, whatever the umask", () => {
    const parent = mkdtempSync(join(tmpdir(), "seori-store-"));
    made.push(parent);
    const root = join(parent, "home");
    const umask = process.umask(0o022);
    try {
      new Store(root);
    } finally {
      process.umask(umask);
    }
    expect(statSync(root).mode & 0o077).toBe(0);
  });

  test("an existing home keeps the mode its owner gave it", () => {
    const root = mkdtempSync(join(tmpdir(), "seori-store-"));
    made.push(root);
    chmodSync(root, 0o750);
    mkdirSync(join(root, "lanes"));
    new Store(root);
    expect(statSync(root).mode & 0o777).toBe(0o750);
  });
});
