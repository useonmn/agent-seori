import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { main } from "../src/cli.ts";
import { Channel } from "../src/channel.ts";
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

describe("seori msg", () => {
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

  test("with the lead extension consuming: DRAFTED, REPLACED, drafts, drop, flush and --now", async () => {
    const { w, d, root, fake } = setup();
    w.consumerLock(root, "alive");
    const drafted = await run(["msg", "send", "--reply-to", "fake:c1:1", "--text", "first try"], d);
    const draft = /^DRAFTED ([0-9a-f]{8}) /.exec(drafted.out)?.[1];
    expect(drafted).toEqual({ code: 0, out: `DRAFTED ${draft} fake:c1:1: goes out when your turn ends` });
    expect(await run(["msg", "send", "--reply-to", "fake:c1:1", "--text", "second try"], d)).toEqual({ code: 0, out: `REPLACED ${draft}` });
    const notice = (await run(["msg", "send", "--to", "fake:c9:t1", "--text", "heads up"], d)).out;
    const noticeDraft = /^DRAFTED ([0-9a-f]{8}) fake:c9:t1: goes out when your turn ends$/.exec(notice)?.[1];
    expect(noticeDraft).toBeDefined();
    expect(await run(["msg", "send", "--replace", noticeDraft!, "--text", "heads up!"], d)).toEqual({ code: 0, out: `REPLACED ${noticeDraft}` });
    expect((await run(["msg", "list"], d)).out.split("\n")[0]).toStartWith("fake:c1:1  drafted  ");
    expect((await run(["msg", "drafts"], d)).out).toBe(`${draft}  0m  reply fake:c1:1  "second try"\n${noticeDraft}  0m  notice fake:c9:t1  "heads up!"`);
    expect(fake.sent()).toEqual([]);

    // --now: the one-line acknowledgement goes out at once.
    expect(await run(["msg", "send", "--reply-to", "fake:c1:2", "--text", "on it", "--now"], d)).toEqual({ code: 0, out: "SENT fake:c1:2 message=1" });

    await expect(main(["msg", "drop", noticeDraft!], d)).rejects.toThrow(/--why/);
    expect(await run(["msg", "drop", noticeDraft!, "--why", "not needed"], d)).toEqual({ code: 0, out: `DROPPED ${noticeDraft}` });
    expect(await run(["msg", "flush"], d)).toEqual({ code: 0, out: `SENT ${draft} fake:c1:1 message=2` });
    expect(fake.sent().map((r) => [r.replyTo, r.text])).toEqual([["2", "on it"], ["1", "second try"]]);
    expect(await run(["msg", "flush"], d)).toEqual({ code: 0, out: "EMPTY" });
    expect(await run(["msg", "drafts"], d)).toEqual({ code: 0, out: "EMPTY" });
  });

  test("flush exits 3 when a draft is HELD and 1 when one failed (it stays open)", async () => {
    const { w, d, root, fake } = setup();
    w.consumerLock(root, "alive");
    const a = /^DRAFTED (\w+)/.exec((await run(["msg", "send", "--reply-to", "fake:c1:1", "--text", "one"], d)).out)![1];
    writeFileSync(fake.sendModePath, "timeout");
    const held = await run(["msg", "flush"], d);
    expect(held.code).toBe(3);
    expect(held.out).toBe(`HELD ${a} fake:c1:1: the messenger may or may not have it; check the chat, it is not sent again`);
    writeFileSync(fake.sendModePath, "ok");
    // An unknown messenger is refused before anything is drafted.
    await expect(main(["msg", "send", "--to", "nope:c1", "--text", "x"], d)).rejects.toThrow('no messenger "nope"');
    const c = /^DRAFTED (\w+)/.exec((await run(["msg", "send", "--reply-to", "fake:c1:2", "--text", "two"], d)).out)![1];
    w.messengers(root, [{ source: "other", owner: "u1" }]);
    const failed = await run(["msg", "flush"], d);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe(`FAILED ${c} fake:c1:2: no messenger "fake" in messengers.json; the draft stays open: flush again, or drop it`);
    expect((await run(["msg", "drafts"], d)).out).toStartWith(`${c}  `);
  });
});
