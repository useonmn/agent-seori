import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMessengers } from "../src/messenger/adapter.ts";

describe("loadMessengers", () => {
  test("a truncated messengers.json is a configuration error naming the file", () => {
    const root = mkdtempSync(join(tmpdir(), "seori-messengers-"));
    const path = join(root, "messengers.json");
    writeFileSync(path, '{ "messengers": [ { "source": "fake"');
    expect(() => loadMessengers(root)).toThrow(path);
  });
});
