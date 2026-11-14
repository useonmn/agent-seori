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
    write({ source: "discord", owner: "42", others: false });
    expect(loadMessengers(root)).toEqual([{ source: "discord", owner: "42", others: false }]);
  });

  test('discord "others" needs "guilds", a non-empty list of server ids as digit strings, and only discord takes "guilds"', () => {
    const root = mkdtempSync(join(tmpdir(), "seori-messengers-"));
    const write = (m: Record<string, unknown>) => writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [m] }));
    write({ source: "discord", owner: "42", others: true });
    expect(() => loadMessengers(root)).toThrow('messengers[0].others on discord needs "guilds"');
    write({ source: "discord", owner: "42", others: true, guilds: ["1100000000000000001", "1100000000000000002"] });
    expect(loadMessengers(root)).toEqual([{ source: "discord", owner: "42", others: true, guilds: ["1100000000000000001", "1100000000000000002"] }]);
    for (const guilds of [[], "1100000000000000001", [11], [""], ["G1"]]) {
      write({ source: "discord", owner: "42", others: true, guilds });
      expect(() => loadMessengers(root)).toThrow("messengers[0].guilds must be a non-empty array of Discord server ids as strings of digits");
    }
    write({ source: "slack", owner: "U1", others: true, guilds: ["1"] });
    expect(() => loadMessengers(root)).toThrow("messengers[0].guilds is only for discord");
  });

  test('"ownerNeedsMention" is optional, boolean and only for discord', () => {
    const root = mkdtempSync(join(tmpdir(), "seori-messengers-"));
    const write = (m: Record<string, unknown>) => writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [m] }));
    write({ source: "discord", owner: "42", ownerNeedsMention: true });
    expect(loadMessengers(root)).toEqual([{ source: "discord", owner: "42", ownerNeedsMention: true }]);
    write({ source: "discord", owner: "42", ownerNeedsMention: "yes" });
    expect(() => loadMessengers(root)).toThrow('messengers[0].ownerNeedsMention must be true or false, got "yes"');
    write({ source: "slack", owner: "U1", ownerNeedsMention: false });
    expect(() => loadMessengers(root)).toThrow("messengers[0].ownerNeedsMention is only for discord");
  });
});
