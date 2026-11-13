import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { main } from "../src/cli.ts";
import { Refusal, type Deps } from "../src/harness.ts";
import { DiscordAdapter } from "../src/messenger/discord.ts";
import { FakeAdapter } from "../src/messenger/fake.ts";
import { SlackAdapter } from "../src/messenger/slack.ts";
import { TelegramAdapter } from "../src/messenger/telegram.ts";
import { World } from "./fake.ts";

// `seori msg show <id>`: the lead reads a message by id, first from the lead channel, else from the messenger, so
// "read the replied-to message first" can always be done or says why it cannot.

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
  return { w, d, root, channel: new Channel(root), fake: new FakeAdapter(root) };
}

let servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

function serve(answer: (path: string, url: URL) => Response) {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${decodeURIComponent(url.pathname)}${url.search}`);
      return answer(url.pathname, url);
    },
  });
  servers.push(server);
  return { calls, base: `http://127.0.0.1:${server.port}` };
}

const home = () => mkdtempSync(join(tmpdir(), "seori-show-"));
const AT = Date.parse("2026-11-13T00:00:00.000Z");

describe("seori msg show", () => {
  test("a message in the lead channel is printed from there, with what it replies to", async () => {
    const { d, channel } = setup();
    channel.appendInbound({ id: "fake:c1:5", kind: "messenger", source: "fake", chat: "c1", from: "u1", at: AT, text: "yes\nthat one", replyTo: { id: "fake:c1:4" } });
    expect(await run(["msg", "show", "fake:c1:5"], d)).toEqual({
      code: 0,
      out: "MESSAGE fake:c1:5 from u1 at 2026-11-13T00:00:00.000Z (reply to fake:c1:4)\nyes\nthat one",
    });
  });

  test("a message not in the lead channel is fetched from the messenger; one it cannot find is UNAVAILABLE, exit 1", async () => {
    const { d, root } = setup();
    await new FakeAdapter(root, { now: () => AT }).send({ chat: "c1" }, "Shall I ship v1.4?");
    expect(await run(["msg", "show", "fake:c1:1"], d)).toEqual({ code: 0, out: "MESSAGE fake:c1:1 from seori at 2026-11-13T00:00:00.000Z\nShall I ship v1.4?" });
    expect(await run(["msg", "show", "fake:c1:404"], d)).toEqual({ code: 1, out: "UNAVAILABLE fake:c1:404: not found" });
  });

  test("an id that is not source:chat:message, or names no configured messenger, is refused", async () => {
    const { d } = setup();
    await expect(main(["msg", "show", "fake:c1"], d)).rejects.toThrow(Refusal);
    await expect(main(["msg", "show", "slack:C1:1"], d)).rejects.toThrow(/no messenger "slack"/);
  });
});

describe("fetchMessage", () => {
  test("Discord reads the message by id; a 404 is not found", async () => {
    const s = serve((path) =>
      path.endsWith("/99") ? Response.json({ id: "99", author: { id: "BOT" }, timestamp: "2026-11-13T00:00:00.000Z", content: "Shall I ship?" }) : Response.json({ code: 10008 }, { status: 404 }),
    );
    const a = new DiscordAdapter({ source: "discord", owner: "42", options: { apiBase: `${s.base}/api` } }, home(), { env: { SEORI_DISCORD_TOKEN: "T0K" }, sleep: async () => {} });
    expect(await a.fetchMessage("C1", "99")).toEqual({ from: "BOT", at: AT, text: "Shall I ship?" });
    expect(await a.fetchMessage("C1", "98")).toEqual({ unavailable: "not found" });
    expect(s.calls).toEqual(["GET /api/channels/C1/messages/99", "GET /api/channels/C1/messages/98"]);
  });

  test("Slack reads the message at that ts from the channel's history; none there is not found", async () => {
    const s = serve((_path, url) =>
      Response.json({ ok: true, messages: url.searchParams.get("latest") === "1700000000.000150" ? [{ ts: "1700000000.000150", user: "UBOT", text: "Shall I &lt;ship&gt;?" }] : [] }),
    );
    const a = new SlackAdapter({ source: "slack", owner: "U1", options: { apiBase: `${s.base}/api` } }, home(), {
      env: { SEORI_SLACK_BOT_TOKEN: "xoxb-1", SEORI_SLACK_APP_TOKEN: "xapp-1" },
      sleep: async () => {},
    });
    expect(await a.fetchMessage("C1", "1700000000.000150")).toEqual({ from: "UBOT", at: 1_700_000_000_000, text: "Shall I <ship>?" });
    expect(await a.fetchMessage("C1", "1700000000.000999")).toEqual({ unavailable: "not found" });
    expect(s.calls[0]).toBe("GET /api/conversations.history?channel=C1&latest=1700000000.000150&inclusive=true&limit=1");
  });

  test("Telegram bots cannot read a message by id, and say where the text comes from instead", async () => {
    const a = new TelegramAdapter({ source: "telegram", owner: "42" }, home(), { env: { SEORI_TELEGRAM_TOKEN: "1:t" } });
    expect(await a.fetchMessage("42", "7")).toEqual({
      unavailable: "Telegram bots cannot read a message by id; a reply carries the text it replies to, shown in the lead channel line",
    });
  });
});
