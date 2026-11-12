import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncDir, shPath } from "../src/platform.ts";

describe("shPath", () => {
  test("SEORI_SH wins, then sh on PATH, then plain sh", () => {
    expect(shPath({ SEORI_SH: "/opt/sh" }, () => "/bin/sh")).toBe("/opt/sh");
    expect(shPath({}, (b) => (b === "sh" ? "/bin/sh" : null))).toBe("/bin/sh");
    expect(shPath({}, () => null)).toBe("sh");
  });
});

test("fsyncDir syncs a directory and fails on a missing one", () => {
  expect(() => fsyncDir(tmpdir())).not.toThrow();
  expect(() => fsyncDir(join(tmpdir(), "no-such-dir-seori"))).toThrow();
});
