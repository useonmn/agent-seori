import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatPath } from "../src/daemon.ts";
import { Refusal } from "../src/harness.ts";
import { loadMessengers, type MessengerConfig } from "../src/messenger/adapter.ts";
import { FakeAdapter, fakeDir, type FakeInboundRow } from "../src/messenger/fake.ts";
import { TelegramAdapter } from "../src/messenger/telegram.ts";
import { candidateLine, PAIR_LOOKBACK_MS, pairedLine, pairOwner, type PairCandidate, writeOwner } from "../src/pair.ts";

const home = () => mkdtempSync(join(tmpdir(), "seori-pair-"));
const fast = { adapterFor: (_c: unknown, root: string, cursorRoot: string) => new FakeAdapter(root, { pollMs: 5, cursorRoot }) };

function inbound(root: string, ...rows: FakeInboundRow[]): void {
  mkdirSync(fakeDir(root), { recursive: true });
  appendFileSync(join(fakeDir(root), "in.jsonl"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

const messengers = (root: string) => JSON.parse(readFileSync(join(root, "messengers.json"), "utf8"));

function beat(root: string, at: number): void {
  mkdirSync(join(root, "messenger"), { recursive: true });
  writeFileSync(heartbeatPath(root), JSON.stringify({ at, pid: 1 }));
}

describe("pairOwner", () => {
  test("stops at the first sender, prints it, and writes nothing without --write", async () => {
    const root = home();
    const now = Date.now();
    inbound(root, { msgId: "1", chat: "c9", from: "u9", text: "hello seori" }, { msgId: "2", chat: "c8", from: "u8", text: "later" });
    const seen: PairCandidate[] = [];
    const got = await pairOwner(root, "fake", {}, { now: () => now, ...fast, onCandidate: (c) => seen.push(c) });
    expect(got.map((c) => [c.id, c.chat, c.text])).toEqual([["u9", "c9", "hello seori"]]);
    expect(seen).toEqual(got);
    expect(existsSync(join(root, "messengers.json"))).toBe(false);
    // pairing reads through a throwaway cursor: the daemon's offset file is never written
    expect(existsSync(join(fakeDir(root), "offset"))).toBe(false);
  });

  test("--write creates messengers.json with the sender as owner", async () => {
    const root = home();
    inbound(root, { msgId: "1", chat: "c9", from: "u9", text: "hi" });
    await pairOwner(root, "fake", { write: true }, { now: Date.now, ...fast });
    expect(loadMessengers(root)).toEqual([{ source: "fake", owner: "u9" }]);
    expect(pairedLine(root, "fake", "u9")).toBe(`PAIRED fake owner=u9 in ${join(root, "messengers.json")}; a running seori daemon restarts on the change`);
  });

  test("--write keeps other entries, the entry's options and unknown fields; the entry's options reach the adapter", async () => {
    const root = home();
    writeFileSync(
      join(root, "messengers.json"),
      JSON.stringify({ note: "mine", messengers: [{ source: "telegram", owner: "1" }, { source: "fake", owner: "old", options: { pollMs: 5 } }] }),
    );
    inbound(root, { msgId: "1", chat: "c9", from: "u9", text: "hi" });
    // default pairingAdapter: a 500 ms poll would still pass, but the entry's 5 ms option is used
    await pairOwner(root, "fake", { write: true }, { now: Date.now });
    expect(messengers(root)).toEqual({ note: "mine", messengers: [{ source: "telegram", owner: "1" }, { source: "fake", owner: "u9", options: { pollMs: 5 } }] });
  });

  test("--all reports every sender once, in order, until the window or the caller ends it", async () => {
    const root = home();
    inbound(
      root,
      { msgId: "1", chat: "c1", from: "u1", text: "a" },
      { msgId: "2", chat: "c1", from: "u1", text: "again" },
      { msgId: "3", chat: "c2", from: "u2", text: "b" },
    );
    const stop = new AbortController();
    const got = await pairOwner(root, "fake", { all: true }, { now: Date.now, ...fast, signal: stop.signal, onCandidate: (c) => c.id === "u2" && stop.abort() });
    expect(got.map((c) => c.id)).toEqual(["u1", "u2"]);
  });

  test("ignores edits and messages sent well before pairing started", async () => {
    const root = home();
    const now = 10_000_000;
    inbound(
      root,
      { msgId: "1", chat: "c1", from: "stale", text: "old", at: now - PAIR_LOOKBACK_MS - 1 },
      { msgId: "2:edit:5", chat: "c1", from: "editor", text: "(edited) x", at: now },
      { msgId: "3", chat: "c3", from: "owner", text: "just before", at: now - PAIR_LOOKBACK_MS },
    );
    const got = await pairOwner(root, "fake", {}, { now: () => now, ...fast });
    expect(got.map((c) => c.id)).toEqual(["owner"]);
  });

  test("never moves the daemon's cursor: messages skipped by pairing still reach the daemon's adapter", async () => {
    const root = home();
    const now = Date.now();
    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: "u1", options: { pollMs: 5 } }] }));
    inbound(root, { msgId: "0", chat: "c1", from: "u1", text: "already delivered", at: now - 1 });
    writeFileSync(join(fakeDir(root), "offset"), "1");
    inbound(
      root,
      { msgId: "1", chat: "c1", from: "u1", text: "urgent request", at: now - PAIR_LOOKBACK_MS - 60_000 },
      { msgId: "2", chat: "c2", from: "u2", text: "pair", at: now },
    );
    // default pairingAdapter, so the cursorRoot wiring is the one under test
    const got = await pairOwner(root, "fake", {}, { now: () => now });
    expect(got.map((c) => c.id)).toEqual(["u2"]);
    expect(readFileSync(join(fakeDir(root), "offset"), "utf8")).toBe("1");

    const stop = new AbortController();
    const seen: string[] = [];
    await new FakeAdapter(root, { pollMs: 5 }).receive(stop.signal, async (m) => {
      seen.push(m.text);
      if (seen.length === 2) stop.abort();
    });
    expect(seen).toEqual(["urgent request", "pair"]);
  });

  test("no message in the window is a refusal", async () => {
    const root = home();
    // A real 60 ms window: the timer under test is pairOwner's own setTimeout.
    const p = pairOwner(root, "fake", { minutes: 0.001 }, { now: Date.now, ...fast });
    await expect(p).rejects.toBeInstanceOf(Refusal);
    await expect(p).rejects.toThrow("no direct message reached the fake bot in 0.001 min");
  });

  test("a caller abort with nothing seen returns no candidates", async () => {
    const root = home();
    const stop = new AbortController();
    stop.abort();
    expect(await pairOwner(root, "fake", {}, { now: Date.now, ...fast, signal: stop.signal })).toEqual([]);
  });

  test("refuses a configured source while the daemon heartbeat is fresh; a stale heartbeat or an unconfigured source passes", async () => {
    const root = home();
    const now = Date.now();
    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: "old" }] }));
    beat(root, now - 5_000);
    const p = pairOwner(root, "fake", {}, { now: () => now, ...fast });
    await expect(p).rejects.toBeInstanceOf(Refusal);
    await expect(p).rejects.toThrow(`already has "fake" and the seori daemon is running (heartbeat 5 s ago)`);

    beat(root, now - 60_000);
    inbound(root, { msgId: "1", chat: "c9", from: "u9", text: "hi" });
    expect((await pairOwner(root, "fake", {}, { now: () => now, ...fast })).map((c) => c.id)).toEqual(["u9"]);

    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [{ source: "telegram", owner: "1" }] }));
    beat(root, now);
    // the daemon delivered the first row meanwhile (pairing itself never advances the daemon's offset)
    writeFileSync(join(fakeDir(root), "offset"), "1");
    inbound(root, { msgId: "2", chat: "c8", from: "u8", text: "hi" });
    expect((await pairOwner(root, "fake", {}, { now: () => now, ...fast })).map((c) => c.id)).toEqual(["u8"]);
  });

  test("refuses bad options, unsupported sources and ambiguous entries; a damaged messengers.json is an error", async () => {
    const root = home();
    const d = { now: Date.now, ...fast };
    await expect(pairOwner(root, "irc", {}, d)).rejects.toThrow("messenger irc is not supported; pairing works for telegram, slack, discord, fake");
    await expect(pairOwner(root, "fake", { minutes: 0 }, d)).rejects.toBeInstanceOf(Refusal);
    await expect(pairOwner(root, "fake", { minutes: Number.NaN }, d)).rejects.toBeInstanceOf(Refusal);
    await expect(pairOwner(root, "fake", { write: true, all: true }, d)).rejects.toThrow("--write records the first sender");
    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [{ source: "fake", owner: "a" }, { source: "fake", owner: "b" }] }));
    await expect(pairOwner(root, "fake", {}, d)).rejects.toThrow(`has 2 "fake" entries`);
    writeFileSync(join(root, "messengers.json"), "{ nope");
    const broken = pairOwner(root, "fake", {}, d);
    await expect(broken).rejects.not.toBeInstanceOf(Refusal);
    await expect(broken).rejects.toThrow("not valid JSON");
    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: {} }));
    await expect(pairOwner(root, "fake", {}, d)).rejects.toThrow(`"messengers" must be an array of objects`);
  });
});

describe("writeOwner", () => {
  test("adds a missing entry, replaces only the owner of an existing one, and creates the home dir", () => {
    const root = join(home(), "nested");
    writeOwner(root, "slack", "U1");
    writeOwner(root, "telegram", "42");
    writeOwner(root, "slack", "U2");
    expect(messengers(root)).toEqual({ messengers: [{ source: "slack", owner: "U2" }, { source: "telegram", owner: "42" }] });
  });
});

describe("candidateLine", () => {
  test("first 40 characters, JSON-quoted on one line, surrogate pairs kept whole", () => {
    const text = `${"😀".repeat(39)}ab\nc`;
    expect(candidateLine({ source: "telegram", id: "42", chat: "42", text, at: 0 })).toBe(`CANDIDATE telegram id=42 chat=42 text="${"😀".repeat(39)}a"`);
    expect(candidateLine({ source: "slack", id: "U1", chat: "D1", text: 'say "hi"\nnow', at: 0 })).toBe('CANDIDATE slack id=U1 chat=D1 text="say \\"hi\\"\\nnow"');
  });
});

describe("pairing through the Telegram adapter", () => {
  let servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers = [];
  });

  test("a stranger's direct message pairs; bots, groups, chats not with the sender and edits never do; the daemon's cursor is untouched", async () => {
    const date = Math.floor(Date.now() / 1000);
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 9, is_bot: true }, chat: { id: 9, type: "private" }, date, text: "bot" } },
      { update_id: 2, message: { message_id: 2, from: { id: 8, is_bot: false }, chat: { id: -100, type: "supergroup" }, date, text: "group" } },
      { update_id: 3, edited_message: { message_id: 3, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, date, edit_date: date, text: "edit" } },
      { update_id: 4, message: { message_id: 4, from: { id: 6, is_bot: false }, chat: { id: 5, type: "private" }, date, text: "odd" } },
      { update_id: 5, message: { message_id: 5, from: { id: 4242, is_bot: false }, chat: { id: 4242, type: "private" }, date, text: "pair me" } },
    ];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const method = new URL(req.url).pathname.split("/").pop();
        const body = (await req.json().catch(() => ({}))) as { offset?: number };
        if (method === "deleteWebhook") return Response.json({ ok: true, result: true });
        if (method === "getUpdates") {
          const ready = updates.filter((u) => u.update_id >= (body.offset ?? 0));
          if (!ready.length) await Bun.sleep(10);
          return Response.json({ ok: true, result: ready });
        }
        return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
      },
    });
    servers.push(server);
    const root = home();
    const got = await pairOwner(
      root,
      "telegram",
      { write: true },
      {
        now: Date.now,
        adapterFor: (c, r, cursorRoot) =>
          new TelegramAdapter({ ...c, options: { apiBase: `http://127.0.0.1:${server.port}`, pollTimeoutSec: 0 } }, r, {
            env: { SEORI_TELEGRAM_TOKEN: "1:x" },
            pairing: true,
            cursorRoot,
          }),
      },
    );
    expect(got.map(candidateLine)).toEqual(['CANDIDATE telegram id=4242 chat=4242 text="pair me"']);
    expect(loadMessengers(root)).toEqual([{ source: "telegram", owner: "4242" }]);
    // the offset moved in the throwaway cursor only; the daemon's cursor file is never written
    expect(existsSync(join(root, "messenger", "telegram", "cursor.json"))).toBe(false);
  });

  test("a configured owner is refused without force (Telegram drops what pairing reads past); force pairs from the daemon's offset and leaves its cursor alone", async () => {
    const date = Math.floor(Date.now() / 1000);
    const updates = [
      { update_id: 3, message: { message_id: 3, from: { id: 4242, is_bot: false }, chat: { id: 4242, type: "private" }, date: date - 600, text: "urgent request" } },
      { update_id: 4, message: { message_id: 4, from: { id: 77, is_bot: false }, chat: { id: 77, type: "private" }, date, text: "pair" } },
    ];
    const offsets: (number | undefined)[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const method = new URL(req.url).pathname.split("/").pop();
        const body = (await req.json().catch(() => ({}))) as { offset?: number };
        if (method === "deleteWebhook") return Response.json({ ok: true, result: true });
        offsets.push(body.offset);
        const ready = updates.filter((u) => u.update_id >= (body.offset ?? 0));
        if (!ready.length) await Bun.sleep(10);
        return Response.json({ ok: true, result: ready });
      },
    });
    servers.push(server);
    const root = home();
    writeFileSync(join(root, "messengers.json"), JSON.stringify({ messengers: [{ source: "telegram", owner: "4242" }] }));
    const cursor = join(root, "messenger", "telegram", "cursor.json");
    mkdirSync(join(root, "messenger", "telegram"), { recursive: true });
    writeFileSync(cursor, JSON.stringify({ offset: 3 }));
    const d = {
      now: Date.now,
      adapterFor: (c: MessengerConfig, r: string, cursorRoot: string) =>
        new TelegramAdapter({ ...c, options: { apiBase: `http://127.0.0.1:${server.port}`, pollTimeoutSec: 0 } }, r, {
          env: { SEORI_TELEGRAM_TOKEN: "1:x" },
          pairing: true,
          cursorRoot,
        }),
    };
    const refused = pairOwner(root, "telegram", {}, d);
    await expect(refused).rejects.toBeInstanceOf(Refusal);
    await expect(refused).rejects.toThrow(`already has "telegram" with owner 4242`);
    expect(offsets).toEqual([]);

    const got = await pairOwner(root, "telegram", { force: true }, d);
    expect(got.map((c) => c.id)).toEqual(["77"]);
    expect(offsets[0]).toBe(3);
    expect(JSON.parse(readFileSync(cursor, "utf8"))).toEqual({ offset: 3 });
  });

  test("without pairing mode the same adapter still passes only the owner", async () => {
    const date = Math.floor(Date.now() / 1000);
    const stop = new AbortController();
    let polls = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const method = new URL(req.url).pathname.split("/").pop();
        if (method === "deleteWebhook") return Response.json({ ok: true, result: true });
        // The second poll means the first batch was handled: stop there.
        if (++polls === 2) stop.abort();
        const offset = ((await req.json()) as { offset?: number }).offset ?? 0;
        const update = { update_id: 1, message: { message_id: 1, from: { id: 4242 }, chat: { id: 4242, type: "private" }, date, text: "x" } };
        return Response.json({ ok: true, result: offset > 1 ? [] : [update] });
      },
    });
    servers.push(server);
    const a = new TelegramAdapter({ source: "telegram", owner: "1", options: { apiBase: `http://127.0.0.1:${server.port}`, pollTimeoutSec: 0 } }, home(), {
      env: { SEORI_TELEGRAM_TOKEN: "1:x" },
    });
    const seen: string[] = [];
    await a.receive(stop.signal, async (m) => {
      seen.push(m.from);
    });
    expect(seen).toEqual([]);
    expect(polls).toBe(2);
  });
});
