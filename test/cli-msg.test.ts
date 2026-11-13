import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { main } from "../src/cli.ts";
import { Channel, type InboundRow } from "../src/channel.ts";
import { Refusal, type Deps } from "../src/harness.ts";
import { FakeAdapter } from "../src/messenger/fake.ts";
import { World } from "./fake.ts";

// `seori msg ...` end to end through the CLI with the file-backed fake messenger: exit codes and the lines the lead sees.

async function run(argv: string[], d: Deps): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { code: await main(argv, d), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

function setup() {
  const w = new World();
  const d = w.deps();
  const root = d.store.root;
  w.messengers(root, [{ source: "fake", owner: "u1" }]);
  const channel = new Channel(root);
  for (const n of ["1", "2", "3"]) {
    channel.appendInbound({ id: `fake:c1:${n}`, kind: "messenger", source: "fake", chat: "c1", from: "u1", at: w.clock, text: `question ${n}` });
  }
  const fake = new FakeAdapter(root);
  return { w, d, root, channel, fake };
}

describe("seori msg edit", () => {
  test("--to edits the message named through the messenger, never the ledger", async () => {
    const { d, fake, channel } = setup();
    expect(await run(["msg", "edit", "--to", "fake:c1:t7", "--message", "9", "--text", "Fix login: done"], d)).toEqual({ code: 0, out: "EDITED fake:c1:t7 message=9" });
    expect(fake.actions().map(({ at: _at, ...r }) => r)).toEqual([{ action: "edit", chat: "c1", thread: "t7", message: "9", text: "Fix login: done" }]);
    expect(fake.sent()).toEqual([]);
    expect(channel.ledger()).toEqual([]);
  });

  test("--reply-of edits seori's first reply to that message, wherever it went out", async () => {
    const { d, fake } = setup();
    expect((await run(["msg", "send", "--reply-to", "fake:c1:1", "--text", "Fix login, 0m"], d)).out).toBe("SENT fake:c1:1 message=1");
    expect((await run(["msg", "send", "--reply-to", "fake:c1:1", "--again", "--text", "the result"], d)).out).toBe("SENT fake:c1:1 message=2");
    expect(await run(["msg", "edit", "--reply-of", "fake:c1:1", "--text", "Fix login: done"], d)).toEqual({ code: 0, out: "EDITED fake:c1:1 message=1" });
    expect(fake.actions().map(({ at: _at, ...r }) => r)).toEqual([{ action: "edit", chat: "c1", message: "1", text: "Fix login: done" }]);
    await expect(main(["msg", "edit", "--reply-of", "fake:c1:2", "--text", "x"], d)).rejects.toThrow(/no reply to fake:c1:2 has been sent/);
    await expect(main(["msg", "edit", "--reply-of", "fake:c1:1", "--to", "fake:c1", "--message", "1", "--text", "x"], d)).rejects.toThrow(/exactly one of --reply-of ID or --to/);
  });

  test("a messenger failure exits 1 with FAILED and what the messenger said", async () => {
    const { d, fake } = setup();
    writeFileSync(fake.sendModePath, "error");
    expect(await run(["msg", "edit", "--to", "fake:c1", "--message", "9", "--text", "x"], d)).toEqual({ code: 1, out: "FAILED edit fake:c1: fake messenger: edit failed (send-mode error)" });
  });

  test("refusals name what is wrong and nothing reaches the messenger", async () => {
    const { d, fake } = setup();
    await expect(main(["msg", "edit", "--to", "fake:c1", "--text", "x"], d)).rejects.toThrow(/--message/);
    await expect(main(["msg", "edit", "--to", "fake:c1", "--message", "9", "--text", " "], d)).rejects.toThrow(/empty/);
    await expect(main(["msg", "edit", "--to", "fake:c1", "--message", "../../guilds/1", "--text", "x"], d)).rejects.toThrow(/--message must be a message id/);
    await expect(main(["msg", "edit", "--to", "fake:c1", "--message", "..", "--text", "x"], d)).rejects.toThrow(/--message must be a message id/);
    expect(fake.actions()).toEqual([]);
  });
});

describe("seori msg", () => {
  test("a reply to a message an earlier seori stored from someone other than the owner is refused", async () => {
    const { w, d, channel, fake } = setup();
    channel.appendInbound({ id: "fake:c1:9", kind: "messenger", source: "fake", chat: "c1", from: "u2", sender: { kind: "person", id: "u2" }, at: w.clock, text: "hi" } as unknown as InboundRow);
    await expect(main(["msg", "send", "--reply-to", "fake:c1:9", "--text", "x"], d)).rejects.toThrow(/fake:c1:9 came from someone other than the owner/);
    expect(fake.sent()).toEqual([]);
  });

  test("send --reply-to with comma-separated ids sends one reply and exits 0; a second reply is refused unless --again", async () => {
    const { d, fake } = setup();
    expect(await run(["msg", "send", "--reply-to", "fake:c1:1,fake:c1:2", "--text", "both done"], d)).toEqual({
      code: 0,
      out: "SENT fake:c1:1,fake:c1:2 message=1",
    });
    expect(fake.sent().map((r) => [r.chat, r.replyTo, r.text])).toEqual([["c1", "1", "both done"]]);
    await expect(main(["msg", "send", "--reply-to", "fake:c1:2", "--text", "again"], d)).rejects.toThrow(Refusal);
    expect(fake.sent()).toHaveLength(1);
    expect((await run(["msg", "send", "--reply-to", "fake:c1:2", "--text", "once more", "--again"], d)).code).toBe(0);
    expect(fake.sent()).toHaveLength(2);
  });

  test("an uncertain send exits 3 with HELD and later replies to that id are refused", async () => {
    const { d, fake } = setup();
    writeFileSync(fake.sendModePath, "timeout");
    const r = await run(["msg", "send", "--reply-to", "fake:c1:3", "--text", "maybe"], d);
    expect(r.code).toBe(3);
    expect(r.out).toStartWith("HELD fake:c1:3:");
    writeFileSync(fake.sendModePath, "ok");
    await expect(main(["msg", "send", "--reply-to", "fake:c1:3", "--text", "maybe"], d)).rejects.toThrow(/UNCERTAIN/);
  });

  test("--to sends a notice without touching the ledger; exactly one of --reply-to and --to", async () => {
    const { d, fake, channel } = setup();
    expect(await run(["msg", "send", "--to", "fake:c9:t1", "--text", "heads up"], d)).toEqual({ code: 0, out: "SENT fake:c9:t1 message=1" });
    expect(fake.sent().map((r) => [r.chat, r.thread, r.text])).toEqual([["c9", "t1", "heads up"]]);
    expect(channel.ledger()).toEqual([]);
    await expect(main(["msg", "send", "--to", "fake:c9", "--reply-to", "fake:c1:1", "--text", "x"], d)).rejects.toThrow(/exactly one/);
  });

  test("close needs --why and takes the id off the open list; list --all shows every state", async () => {
    const { d } = setup();
    await expect(main(["msg", "close", "fake:c1:1"], d)).rejects.toThrow(/--why/);
    expect(await run(["msg", "close", "fake:c1:1", "--why", "handled in person"], d)).toEqual({ code: 0, out: "CLOSED fake:c1:1" });
    const open = (await run(["msg", "list"], d)).out.split("\n");
    expect(open.map((l) => l.split("  ")[0])).toEqual(["fake:c1:2", "fake:c1:3"]);
    const all = (await run(["msg", "list", "--all"], d)).out.split("\n");
    expect(all.map((l) => l.split("  ").slice(0, 2))).toEqual([["fake:c1:1", "closed"], ["fake:c1:2", "open"], ["fake:c1:3", "open"]]);
  });

  test("list prints EMPTY when nothing is open", async () => {
    const w = new World();
    expect(await run(["msg", "list"], w.deps())).toEqual({ code: 0, out: "EMPTY" });
  });

  test("a reply goes out at once even while the lead extension holds the consumer lock", async () => {
    const { w, d, root, fake } = setup();
    w.consumerLock(root, "alive");
    // The lock is held by a live consumer: nothing is held back, the messenger takes the reply now.
    expect(await run(["msg", "send", "--reply-to", "fake:c1:1", "--text", "the answer"], d)).toEqual({ code: 0, out: "SENT fake:c1:1 message=1" });
    expect(fake.sent().map((r) => [r.chat, r.replyTo, r.text])).toEqual([["c1", "1", "the answer"]]);
    // It is recorded as answered at once, not held: the id is replied and off the open list.
    expect((await run(["msg", "list", "--all"], d)).out.split("\n")[0]).toStartWith("fake:c1:1  replied  ");
    expect((await run(["msg", "list"], d)).out).not.toContain("fake:c1:1");
  });

  test("a notice goes out at once while the lead extension holds the consumer lock", async () => {
    const { w, d, root, fake } = setup();
    w.consumerLock(root, "alive");
    expect(await run(["msg", "send", "--to", "fake:c9:t1", "--text", "heads up"], d)).toEqual({ code: 0, out: "SENT fake:c9:t1 message=1" });
    expect(fake.sent().map((r) => [r.chat, r.thread, r.text])).toEqual([["c9", "t1", "heads up"]]);
  });
});
