import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SendUncertain } from "../src/messenger/adapter.ts";
import { httpJson, replyTarget, secret, splitText } from "../src/messenger/common.ts";
import { readableByOthers } from "../src/platform.ts";

describe("splitText", () => {
  test("prefers a paragraph break, then a line break, then a space, and keeps every chunk within the limit", () => {
    const text = `${"a".repeat(10)}\n\n${"b".repeat(10)} ${"c".repeat(25)}`;
    const chunks = splitText(text, 15);
    expect(chunks).toEqual(["a".repeat(10), "b".repeat(10), "c".repeat(15), "c".repeat(10)]);
    expect(chunks.every((c) => c.length <= 15)).toBe(true);
  });

  test("an indented line at a chunk boundary keeps its indentation", () => {
    expect(splitText(`${"x".repeat(20)}\n    indented();\n    more();`, 30)).toEqual(["x".repeat(20), "    indented();\n    more();"]);
  });

  test("never splits a surrogate pair", () => {
    const chunks = splitText("😀".repeat(5), 3);
    expect(chunks.join("")).toBe("😀".repeat(5));
    expect(chunks.every((c) => c.length <= 3 && !/[\ud800-\udbff]$/.test(c))).toBe(true);
  });

  test("short text is one chunk and blank text none", () => {
    expect(splitText("hi", 10)).toEqual(["hi"]);
    expect(splitText("  \n ", 10)).toEqual([]);
  });
});

test("replyTarget drops an edit suffix so a reply to an edit threads under the original", () => {
  expect(replyTarget("123:edit:1700000000")).toBe("123");
  expect(replyTarget("1712345678.000100")).toBe("1712345678.000100");
});

describe("secret", () => {
  const home = () => mkdtempSync(join(tmpdir(), "seori-secret-"));

  test("the environment wins over secrets.json, which wins over nothing", () => {
    const root = home();
    writeFileSync(join(root, "secrets.json"), JSON.stringify({ telegram: { token: "from-file" } }));
    chmodSync(join(root, "secrets.json"), 0o600);
    expect(secret(root, "telegram", "token", "T", { T: "from-env" })).toBe("from-env");
    expect(secret(root, "telegram", "token", "T", {})).toBe("from-file");
    expect(() => secret(root, "slack", "botToken", "S", {})).toThrow('no slack botToken: set S or "slack": { "botToken": "..." }');
  });

  test("a secrets.json others can read is refused (mode bits on macOS/Linux)", () => {
    const root = home();
    writeFileSync(join(root, "secrets.json"), JSON.stringify({ telegram: { token: "x" } }));
    chmodSync(join(root, "secrets.json"), 0o644);
    expect(() => secret(root, "telegram", "token", "T", {}, (p) => readableByOthers(p, "linux"))).toThrow("must not be readable by others");
  });

  test("Windows reads the ACL instead: an Allow entry for Everyone, Users or Authenticated Users is refused", () => {
    const acl = (lines: string) => (p: string) => readableByOthers(p, "win32", () => lines);
    expect(acl("S-1-5-21-1-2-3-1001 Allow\r\nS-1-5-18 Allow\r\nS-1-5-32-544 Allow")("C:\\s.json")).toBeUndefined();
    expect(acl("S-1-5-21-1-2-3-1001 Allow\r\nS-1-1-0 Allow")("C:\\s.json")).toContain("S-1-1-0 may read it");
    expect(acl("S-1-5-32-545 Allow")("C:\\s.json")).toContain('icacls "C:\\s.json" /inheritance:r');
    expect(acl("S-1-5-11 Deny")("C:\\s.json")).toBeUndefined();
    expect(readableByOthers("C:\\s.json", "win32", () => { throw new Error("access denied"); })).toContain("cannot read the ACL");
  });

  test.if(process.platform === "win32")("on Windows, a real secrets.json granted to Everyone is refused and a private one is read", () => {
    const root = home();
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ telegram: { token: "x" } }));
    expect(Bun.spawnSync(["icacls", path, "/inheritance:r", "/grant:r", `${process.env["USERNAME"]}:F`]).exitCode).toBe(0);
    expect(secret(root, "telegram", "token", "T", {})).toBe("x");
    expect(Bun.spawnSync(["icacls", path, "/grant", "*S-1-1-0:R"]).exitCode).toBe(0);
    expect(() => secret(root, "telegram", "token", "T", {})).toThrow("S-1-1-0 may read it");
  });
});

describe("httpJson", () => {
  test("a mutating request whose answer is cut off mid-body is SendUncertain, not a definite failure", async () => {
    let taken = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        taken++;
        // Headers go out, then the body stalls past the client's timeout.
        const body = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"ok":')) });
        return new Response(body, { headers: { "content-type": "application/json" } });
      },
    });
    try {
      const call = httpJson(`http://127.0.0.1:${server.port}/send`, { body: { text: "hi" } }, { mutating: true, timeoutMs: 200 });
      await expect(call).rejects.toBeInstanceOf(SendUncertain);
      expect(taken).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("a 429 waits Retry-After and retries; a 5xx on a mutating request is SendUncertain", async () => {
    const answers = [new Response("{}", { status: 429, headers: { "retry-after": "2" } }), Response.json({ ok: true }), new Response("boom", { status: 502 })];
    const server = Bun.serve({ port: 0, fetch: () => answers.shift() ?? new Response("gone", { status: 500 }) });
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    try {
      const ok = await httpJson(`http://127.0.0.1:${server.port}/a`, { body: {} }, { mutating: true, sleep });
      expect(ok.body).toEqual({ ok: true });
      expect(slept).toEqual([2000]);
      await expect(httpJson(`http://127.0.0.1:${server.port}/a`, { body: {} }, { mutating: true, sleep })).rejects.toBeInstanceOf(SendUncertain);
    } finally {
      server.stop(true);
    }
  });
});
