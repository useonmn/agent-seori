// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choiceFor, defaultRuntimes } from "../src/runtime/index.ts";
import { readRuntimeChoice, RuntimeChoiceError, RuntimeConfigError } from "../src/runtime/select.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";

const home = mkdtempSync(join(tmpdir(), "seori-select-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const noConfig = join(home, "absent.json");
let n = 0;
const configWith = (body: string): string => {
  const path = join(home, `config-${n++}.json`);
  writeFileSync(path, body);
  return path;
};
/** A PATH lookup with no real binaries: `bins` are the files that "exist" in /bin. */
const onPath = (...bins: string[]) => ({ PATH: "/bin", exists: (p: string) => bins.some((b) => p === `/bin/${b}`) });
const choose = (env: Record<string, string>, configPath = noConfig, bins: string[] = []) =>
  readRuntimeChoice({ env: { PATH: "/bin", ...env }, configPath, exists: onPath(...bins).exists });

describe("readRuntimeChoice order", () => {
  test("1. SEORI_RUNTIME wins over config, terminal env and PATH", () => {
    const config = configWith('{"runtime":"hc"}');
    expect(choose({ SEORI_RUNTIME: "herdr", HC_TERMINAL_ID: "t1", HERDR_PANE_ID: "w1:p1" }, config, ["hc"])).toEqual({ kind: "herdr", source: "env" });
  });

  test("1. a bad SEORI_RUNTIME is an error, not a fallthrough", () => {
    expect(() => choose({ SEORI_RUNTIME: "tmux", HC_TERMINAL_ID: "t1" })).toThrow(RuntimeConfigError);
  });

  test("2. config.json runtime wins over terminal env and PATH", () => {
    const config = configWith('{"runtime":"herdr"}');
    expect(choose({ HC_TERMINAL_ID: "t1" }, config, ["hc"])).toEqual({ kind: "herdr", source: "config" });
  });

  test("2. a config without a runtime key falls through; a malformed one is an error", () => {
    expect(choose({ HC_TERMINAL_ID: "t1" }, configWith("{}"))).toEqual({ kind: "hc", source: "detect:HC_TERMINAL_ID" });
    expect(() => choose({}, configWith("{nope"))).toThrow(RuntimeConfigError);
    expect(() => choose({}, configWith('{"runtime":"x"}'))).toThrow(RuntimeConfigError);
  });

  test("3. HC_TERMINAL_ID picks hc, ahead of HERDR_PANE_ID and PATH", () => {
    expect(choose({ HC_TERMINAL_ID: "t1", HERDR_PANE_ID: "w1:p1" }, noConfig, ["herdr"])).toEqual({ kind: "hc", source: "detect:HC_TERMINAL_ID" });
  });

  test("4. HERDR_PANE_ID picks herdr, ahead of PATH", () => {
    expect(choose({ HERDR_PANE_ID: "w1:p1" }, noConfig, ["hc"])).toEqual({ kind: "herdr", source: "detect:HERDR_PANE_ID" });
  });

  test("empty env values count as unset", () => {
    expect(choose({ SEORI_RUNTIME: "", HC_TERMINAL_ID: "", HERDR_PANE_ID: "" }, noConfig, ["herdr"])).toEqual({ kind: "herdr", source: "detect:path" });
  });

  test("5. PATH: hc alone, herdr alone, and hc preferred when both are installed", () => {
    expect(choose({}, noConfig, ["hc"])).toEqual({ kind: "hc", source: "detect:path" });
    expect(choose({}, noConfig, ["herdr"])).toEqual({ kind: "herdr", source: "detect:path" });
    expect(choose({}, noConfig, ["herdr", "hc"])).toEqual({ kind: "hc", source: "detect:path" });
  });

  test("neither found: one line that says how to fix it", () => {
    const err = (() => {
      try {
        choose({});
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(RuntimeChoiceError);
    const message = (err as Error).message;
    expect(message).not.toContain("\n");
    expect(message).toContain("SEORI_RUNTIME");
    expect(message).toContain(noConfig);
  });
});

describe("registry wiring", () => {
  test("choiceFor reads <home>/config.json and the selector runs once, on first use", () => {
    const dir = mkdtempSync(join(home, "h-"));
    writeFileSync(join(dir, "config.json"), '{"runtime":"hc"}');
    const rts = defaultRuntimes(undefined, undefined, choiceFor(dir, {}));
    expect(rts.choice()).toEqual({ kind: "hc", source: "config" });
    expect(rts.default).toBeInstanceOf(HcRuntime);
  });

  test("a selector error surfaces only when the choice is needed", () => {
    const rts = defaultRuntimes(undefined, undefined, choiceFor(home, { PATH: "" }));
    expect(() => rts.choice()).toThrow(RuntimeChoiceError);
    expect(() => rts.for({ runtime: "hc", id: "t1" })).not.toThrow();
  });

  test("a fixed kind keeps working (tests hand in herdr)", () => {
    const rts = defaultRuntimes();
    expect(rts.choice()).toEqual({ kind: "herdr", source: "fixed" });
    expect(rts.default).toBeInstanceOf(HerdrRuntime);
  });
});
