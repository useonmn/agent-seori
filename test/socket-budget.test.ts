import { expect, test } from "bun:test";
import { SOCKET_PATH_MAX, socketPathLength, socketRootBase } from "./socket-budget.ts";

const session = "e2e-12345";

test("a tmpdir whose holder socket exceeds the budget is replaced by /tmp", () => {
  // With a 50-byte tmpdir the core socket is 90 bytes (fits) and the holder socket is 106 bytes (over the budget).
  const tmp = `/${"t".repeat(49)}`;
  expect(socketRootBase(tmp, session)).toBe("/tmp");
});

test("a tmpdir whose holder socket is exactly at the budget is kept", () => {
  const tmp = `/${"t".repeat(43)}`;
  expect(socketPathLength(tmp, session)).toBe(SOCKET_PATH_MAX);
  expect(socketRootBase(tmp, session)).toBe(tmp);
});
