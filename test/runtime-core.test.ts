import { expect, test } from "bun:test";
import { formatRef, parseRef } from "../src/runtime/types.ts";

test("refs: only hc:<address> parses; a bare t<n> is a lane key, and a herdr pane id is no ref", () => {
  expect(parseRef("hc:t7")).toEqual({ runtime: "hc", id: "t7" });
  expect(parseRef("t7")).toBeUndefined();
  expect(parseRef("hc:w1:p3")).toBeUndefined();
  expect(parseRef("hc:t1b")).toEqual({ runtime: "hc", id: "t1b" });
  expect(parseRef("hc:m1/t2h")).toBeUndefined();
  expect(parseRef("t1b")).toBeUndefined();
  expect(parseRef("w1:p3")).toBeUndefined();
  expect(parseRef("herdr:w1:p3")).toBeUndefined();
  expect(formatRef({ runtime: "hc", id: "t7" })).toBe("hc:t7");
});
