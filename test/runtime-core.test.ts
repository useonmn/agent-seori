import { describe, expect, test } from "bun:test";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { defaultRuntimes, Runtimes } from "../src/runtime/index.ts";
import { RuntimeChoiceError } from "../src/runtime/select.ts";
import { formatRef, parseRef, type RuntimeKind, type SessionRuntime } from "../src/runtime/types.ts";
import { World } from "./fake.ts";

/** A runtime that is only its kind: enough to see which one the registry routes to. */
const stub = (kind: RuntimeKind): SessionRuntime => ({ kind }) as SessionRuntime;

describe("Runtimes", () => {
  test("builds each kind once, on first use, and routes a ref to its own runtime", () => {
    const made: RuntimeKind[] = [];
    const rts = new Runtimes("herdr", (kind) => (made.push(kind), stub(kind)));
    expect(made).toEqual([]);
    expect(rts.default.kind).toBe("herdr");
    expect(rts.for({ runtime: "hc", id: "t1" }).kind).toBe("hc");
    expect(rts.for({ runtime: "herdr", id: "w1:p1" })).toBe(rts.default);
    expect(made).toEqual(["herdr", "hc"]);
    expect(rts.kinds()).toEqual(["herdr", "hc"]);
  });

  test("selfAny reads hc before herdr and builds no runtime", () => {
    const rts = new Runtimes("herdr", () => {
      throw new Error("built");
    });
    expect(rts.selfAny({ HC_TERMINAL_ID: "t3", HERDR_PANE_ID: "w1:p1" })).toEqual({ runtime: "hc", id: "t3" });
    expect(rts.selfAny({ HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" })).toEqual({ runtime: "herdr", id: "w1:p1", group: "w1" });
    expect(rts.selfAny({ HC_TERMINAL_ID: "", HERDR_PANE_ID: "" })).toBeUndefined();
    expect(rts.kinds()).toEqual([]);
  });

  test("seori's default registry opens herdr, maps stored pane ids to herdr refs and refuses hc for now", () => {
    const rts = defaultRuntimes();
    expect(rts.default).toBeInstanceOf(HerdrRuntime);
    expect(rts.for({ runtime: "herdr", id: "w1:p2" })).toBe(rts.default);
    expect(() => rts.for({ runtime: "hc", id: "t1" })).toThrow(RuntimeChoiceError);
  });
});

test("refs: prefixed and bare herdr ids parse, a bare t<n> is a lane key, not a ref", () => {
  expect(parseRef("herdr:w1:p3")).toEqual({ runtime: "herdr", id: "w1:p3" });
  expect(parseRef("w1:p3")).toEqual({ runtime: "herdr", id: "w1:p3" });
  expect(parseRef("hc:t7")).toEqual({ runtime: "hc", id: "t7" });
  expect(parseRef("t7")).toBeUndefined();
  expect(parseRef("hc:w1:p3")).toBeUndefined();
  expect(formatRef({ runtime: "hc", id: "t7" })).toBe("hc:t7");
});

test("the herdr adapter: a tab ref carries its workspace and tab, and Escape is herdr's `esc`", async () => {
  const w = new World();
  const rt = w.deps().runtimes.default;
  const ref = await rt.create({ name: "lane", cwd: "/w", env: { A: "1" }, role: "lane", container: "tab", group: "w1" });
  expect(ref).toEqual({ runtime: "herdr", id: "w1:p2", group: "w1", container: "w1:t2" });
  await rt.keys(ref, ["escape", "enter"]);
  expect(w.calls.slice(-2).map((c) => c.argv)).toEqual([["pane", "send-keys", "w1:p2", "esc"], ["pane", "send-keys", "w1:p2", "enter"]]);
});
