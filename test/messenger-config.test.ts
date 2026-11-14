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

  test('"others" is optional and boolean; any other value, or true on telegram, is an error naming the field', () => {
    const root = mkdtempSync(join(tmpdir(), "seori-messengers-"));
    const write = (m: Record<string, unknown>) => writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [m] }));
    write({ source: "slack", owner: "U1", others: true });
    expect(loadMessengers(root)).toEqual([{ source: "slack", owner: "U1", others: true }]);
    write({ source: "slack", owner: "U1" });
    expect(loadMessengers(root)).toEqual([{ source: "slack", owner: "U1" }]);
    write({ source: "slack", owner: "U1", others: "yes" });
    expect(() => loadMessengers(root)).toThrow('messengers[0].others must be true or false, got "yes"');
    write({ source: "telegram", owner: "1", others: true });
    expect(() => loadMessengers(root)).toThrow("messengers[0].others is not supported for telegram");
  });
});
