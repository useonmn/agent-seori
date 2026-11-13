import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { type Deps } from "../src/harness.ts";
import { loadHooks, substitute } from "../src/hooks.ts";
import type { InboundMessage } from "../src/messenger/adapter.ts";
import { TelegramAdapter } from "../src/messenger/telegram.ts";
import { transcribe, TranscriptionError, voiceTranscriber } from "../src/messenger/voice.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { World } from "./fake.ts";

// hooks.transcribe: `seori transcribe <file>` and the Telegram voice/audio transcript on the lead-channel row.

const TOKEN = "123:abc";
const home = () => mkdtempSync(join(tmpdir(), "seori-transcribe-"));
const writeHooks = (root: string, hooks: unknown) => writeFileSync(join(root, "config.json"), JSON.stringify({ hooks }));

/** An Exec that records every call and answers with `reply`. */
function fakeExec(reply: { code?: number; stdout?: string; stderr?: string } = { stdout: "hello world\n" }) {
  const calls: { cmd: string; argv: readonly string[] }[] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push({ cmd, argv });
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { exec, calls };
}

describe("hooks.transcribe config", () => {
  test("loadHooks accepts transcribe and substitute fills {file}", () => {
    const root = home();
    writeHooks(root, { transcribe: ["whisper-cli", "--in", "{file}"] });
    const hook = loadHooks(root).transcribe;
    expect(hook).toEqual(["whisper-cli", "--in", "{file}"]);
    expect(substitute(hook!, { file: "/tmp/a b.ogg" })).toEqual(["whisper-cli", "--in", "/tmp/a b.ogg"]);
  });
});

describe("transcribe()", () => {
  test("runs the argv template with {file} and returns the trimmed stdout", async () => {
    const x = fakeExec({ stdout: "  hi there \n" });
    expect(await transcribe(x.exec, ["stt", "{file}", "--fast"], "/a/v.ogg")).toBe("hi there");
    expect(x.calls).toEqual([{ cmd: "stt", argv: ["/a/v.ogg", "--fast"] }]);
  });

  test("no hook, a non-zero exit, empty output and a spawn error are one-line TranscriptionErrors", async () => {
    await expect(transcribe(fakeExec().exec, undefined, "/a/v.ogg")).rejects.toThrow("hooks.transcribe is not configured");
    const failing = fakeExec({ code: 3, stderr: "model missing\nmore" });
    await expect(transcribe(failing.exec, ["stt", "{file}"], "/a/v.ogg")).rejects.toThrow("transcription failed (exit 3): model missing");
    await expect(transcribe(fakeExec({ stdout: "  \n" }).exec, ["stt", "{file}"], "/a/v.ogg")).rejects.toBeInstanceOf(TranscriptionError);
    const broken: Exec = async () => {
      throw new Error("spawn stt ENOENT");
    };
    await expect(transcribe(broken, ["stt", "{file}"], "/a/v.ogg")).rejects.toThrow("transcription failed: spawn stt ENOENT");
  });
});

describe("seori transcribe", () => {
  async function run(argv: string[], d: Deps): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const { log } = console;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      return { code: await main(argv, d), out: out.join("\n"), err: "" };
    } catch (e) {
      return { code: 2, out: out.join("\n"), err: (e as Error).message };
    } finally {
      console.log = log;
    }
  }

  test("prints the transcript from the configured hook", async () => {
    const x = fakeExec({ stdout: "buy milk\n" });
    const d: Deps = { ...new World().deps(), exec: x.exec };
    writeHooks(d.store.root, { transcribe: ["stt", "-f", "{file}"] });
    const audio = join(d.store.root, "memo.ogg");
    writeFileSync(audio, "x");
    expect(await run(["transcribe", audio], d)).toEqual({ code: 0, out: "buy milk", err: "" });
    expect(x.calls).toEqual([{ cmd: "stt", argv: ["-f", audio] }]);
  });

  test("a missing hook is a one-line error and runs nothing", async () => {
    const x = fakeExec();
    const d: Deps = { ...new World().deps(), exec: x.exec };
    const audio = join(d.store.root, "memo.ogg");
    writeFileSync(audio, "x");
    const r = await run(["transcribe", audio], d);
    expect(r.code).toBe(2);
    expect(r.err).toBe("hooks.transcribe is not configured in config.json");
    expect(x.calls).toEqual([]);
  });

  test("a missing audio file and a missing argument are refused", async () => {
    const x = fakeExec();
    const d: Deps = { ...new World().deps(), exec: x.exec };
    writeHooks(d.store.root, { transcribe: ["stt", "{file}"] });
    expect((await run(["transcribe", join(d.store.root, "nope.ogg")], d)).err).toContain("audio file not found");
    expect((await run(["transcribe"], d)).code).toBe(2);
    expect(x.calls).toEqual([]);
  });
});

describe("Telegram voice transcript", () => {
  let servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers = [];
  });

  const AUDIO = "OggS-bytes";

  /** A Bot API mock serving one voice update, getFile and the file download. */
  function api(kind: "voice" | "audio" = "voice") {
    const methods: string[] = [];
    const update = {
      update_id: 1,
      message: {
        message_id: 7,
        from: { id: 42, is_bot: false },
        chat: { id: 42, type: "private" },
        date: 1_700_000_000,
        [kind]: { file_id: "v/1", mime_type: "audio/ogg", duration: 3, file_size: 10 },
      },
    };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === `/file/bot${TOKEN}/voice/file_9.oga`) return new Response(AUDIO);
        const method = new RegExp(`^/bot${TOKEN}/(\\w+)$`).exec(path)?.[1] ?? "";
        methods.push(method);
        if (method === "getUpdates") {
          const offset = ((await req.json()) as { offset?: number }).offset ?? 0;
          return Response.json({ ok: true, result: offset <= 1 ? [update] : [] });
        }
        if (method === "getFile") return Response.json({ ok: true, result: { file_id: "v/1", file_path: "voice/file_9.oga" } });
        return Response.json({ ok: true, result: true });
      },
    });
    servers.push(server);
    return { methods, apiBase: `http://127.0.0.1:${server.port}` };
  }

  async function receiveOne(root: string, apiBase: string, exec: Exec, warnings: string[]): Promise<InboundMessage> {
    const adapter = new TelegramAdapter({ source: "telegram", owner: "42", options: { apiBase, pollTimeoutSec: 0 } }, root, {
      env: { SEORI_TELEGRAM_TOKEN: TOKEN },
      sleep: async () => {},
      transcribe: voiceTranscriber(root, exec),
      warn: (line) => void warnings.push(line),
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2_000);
    let got: InboundMessage | undefined;
    try {
      await adapter.receive(ac.signal, async (m) => {
        got ??= m;
        ac.abort();
      });
    } finally {
      clearTimeout(timer);
    }
    return got!;
  }

  test("appends the transcript to the message text and keeps the downloaded file", async () => {
    const root = home();
    writeHooks(root, { transcribe: ["stt", "{file}"] });
    const x = fakeExec({ stdout: "call me at five\n" });
    const warnings: string[] = [];
    const m = await receiveOne(root, api().apiBase, x.exec, warnings);
    const file = join(root, "messenger", "telegram", "voice", "v_1.oga");
    expect(m.text).toBe("[attachment: voice (audio/ogg, 3s, 10 B) telegram-file:v/1]\n[transcript: call me at five]");
    expect(x.calls).toEqual([{ cmd: "stt", argv: [file] }]);
    expect(readFileSync(file, "utf8")).toBe(AUDIO);
    expect(warnings).toEqual([]);
  });

  test("audio messages are transcribed too", async () => {
    const root = home();
    writeHooks(root, { transcribe: ["stt", "{file}"] });
    const m = await receiveOne(root, api("audio").apiBase, fakeExec({ stdout: "song lyrics" }).exec, []);
    expect(m.text).toEndWith("[transcript: song lyrics]");
  });

  test("no hook: text unchanged, one warning, nothing downloaded or run", async () => {
    const root = home();
    const x = fakeExec();
    const t = api();
    const warnings: string[] = [];
    const m = await receiveOne(root, t.apiBase, x.exec, warnings);
    expect(m.text).toBe("[attachment: voice (audio/ogg, 3s, 10 B) telegram-file:v/1]");
    expect(warnings).toEqual(["seori: telegram (telegram): voice message not transcribed: hooks.transcribe is not configured in config.json"]);
    expect(t.methods).not.toContain("getFile");
    expect(existsSync(join(root, "messenger", "telegram", "voice"))).toBe(false);
    expect(x.calls).toEqual([]);
  });

  test("a failing hook leaves the text as it was, warns once and keeps the file", async () => {
    const root = home();
    writeHooks(root, { transcribe: ["stt", "{file}"] });
    const warnings: string[] = [];
    const m = await receiveOne(root, api().apiBase, fakeExec({ code: 1, stderr: "boom" }).exec, warnings);
    expect(m.text).toBe("[attachment: voice (audio/ogg, 3s, 10 B) telegram-file:v/1]");
    expect(warnings).toEqual(["seori: telegram (telegram): voice message not transcribed: transcription failed (exit 1): boom"]);
    expect(existsSync(join(root, "messenger", "telegram", "voice", "v_1.oga"))).toBe(true);
  });
});
