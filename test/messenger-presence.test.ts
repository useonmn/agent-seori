// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import {
  DISCORD_IDENTIFY_BUDGET, discordPresence, IDENTIFY_WINDOW_MS, type PresenceDeps, RELEASE_TIMEOUT_MS, runPresence, SLACK_TICK_MS, STABLE_MS,
} from "../src/messenger/presence.ts";
import { type SlackCall, slackPresence } from "../src/messenger/slack-presence.ts";
import { World } from "./fake.ts";

// `seori presence`: sockets, timers, sleep, clock and the Slack Web API are all injected; nothing touches the network.

const home = (secrets?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "seori-presence-"));
  if (secrets) writeFileSync(join(root, "secrets.json"), JSON.stringify(secrets), { mode: 0o600 });
  return root;
};

const fakeTimers = () => {
  const live = new Set<() => void>();
  return {
    live,
    timers: {
      setInterval: (cb: () => void) => {
        live.add(cb);
        return cb;
      },
      clearInterval: (h: unknown) => {
        live.delete(h as () => void);
      },
    },
    fire: () => {
      for (const cb of live) cb();
    },
  };
};

type Call = { method: string; params: Record<string, unknown>; signal: AbortSignal | undefined };
const socketAnswer = (method: string): Record<string, unknown> =>
  method === "client.getWebSocketURL" ? { ok: true, primary_websocket_url: "wss://wss-primary.example/", routing_context: "gw-1" } : { ok: true };

/** A fake Slack Web API: records every call and answers through `answer`. */
const fakeSlack = (answer: (method: string, n: number) => Record<string, unknown> = socketAnswer) => {
  const calls: Call[] = [];
  const call: SlackCall = async (method, params, signal) => {
    calls.push({ method, params, signal });
    return answer(method, calls.length);
  };
  return { calls, call };
};

type Gateway = { sent: unknown[]; closed: boolean; at: number; msg: (m: unknown) => void; close: (code: number) => void };

/** The whole run's world: `onTick` drives Slack after each hold, `onOpen` drives each new Discord connection. */
function rig(opts: { onOpen?: (g: Gateway, i: number) => void; answer?: (method: string, n: number) => Record<string, unknown> } = {}) {
  const stop = new AbortController();
  const t = fakeTimers();
  const slack = fakeSlack(opts.answer);
  const r = {
    stop,
    t,
    clock: 0,
    out: [] as string[],
    err: [] as string[],
    slept: [] as number[],
    calls: slack.calls,
    auths: [] as { token: string; cookie: string }[],
    lines: [] as { url: string; headers: Record<string, string>; frames: unknown[]; open: boolean }[],
    gateways: [] as Gateway[],
    onSleep: (_ms: number) => {},
    deps: undefined as unknown as PresenceDeps,
  };
  r.deps = {
    openSlack: (url, headers) => {
      const l = { url, headers: { ...headers }, frames: [] as unknown[], open: true };
      r.lines.push(l);
      return { isOpen: () => l.open, send: (f) => void l.frames.push(JSON.parse(f)), close: () => void (l.open = false) };
    },
    openDiscord: () => {
      let onMessage: (d: string) => void = () => {};
      let onClose: (code: number) => void = () => {};
      const g: Gateway = {
        sent: [],
        closed: false,
        at: r.clock,
        msg: (m) => onMessage(JSON.stringify(m)),
        close: (code) => onClose(code),
      };
      r.gateways.push(g);
      const i = r.gateways.length - 1;
      queueMicrotask(() => opts.onOpen?.(g, i));
      return {
        send: (d) => void g.sent.push(JSON.parse(d)),
        close: () => void (g.closed = true),
        onMessage: (cb) => void (onMessage = cb),
        onClose: (cb) => void (onClose = cb),
      };
    },
    slackApi: (auth) => {
      r.auths.push(auth);
      return slack.call;
    },
    timers: t.timers,
    sleep: async (ms) => {
      r.slept.push(ms);
      r.onSleep(ms);
    },
    now: () => r.clock,
    log: (l) => void r.out.push(l),
    error: (l) => void r.err.push(l),
    env: {},
  };
  return r;
}

const hello = (g: Gateway, interval = 41_250) => g.msg({ op: 10, d: { heartbeat_interval: interval } });
const ops = (g: Gateway) => g.sent.map((f) => (f as { op: number }).op);
const reconnects = (out: string[]) => out.filter((l) => l.startsWith("PRESENCE_RECONNECT")).map((l) => Number(/retry_in=(\d+)s/.exec(l)![1]));

// Ported from upstream's messenger-presence tests.

test("Slack presence opens one client-type socket with the cookie, then only tickles it; release closes it and sets away", async () => {
  const { calls, call } = fakeSlack();
  const frames: string[] = [];
  let opened: { url: string; headers: Record<string, string> } | null = null;
  let open = false;
  const p = slackPresence(
    call,
    (url, headers) => {
      opened = { url, headers: { ...headers } };
      open = true;
      return {
        isOpen: () => open,
        send: (f) => frames.push(f),
        close: () => {
          open = false;
        },
      };
    },
    { token: "xt", cookie: "dc" },
  );
  expect(await p.hold()).toBe("opened");
  expect(await p.hold()).toBe("tickled");
  expect(await p.hold()).toBe("tickled");
  const url = new URL(opened!.url);
  expect(url.searchParams.get("token")).toBe("xt");
  expect(url.searchParams.get("slack_client")).toBe("desktop");
  expect(url.searchParams.get("gateway_server")).toBe("gw-1");
  expect(opened!.headers).toEqual({ Cookie: "d=dc", Origin: "https://app.slack.com" });
  expect(frames.map((f) => JSON.parse(f).type)).toEqual(["tickle", "tickle"]);
  await p.release();
  expect(open).toBe(false);
  expect(calls.filter((c) => c.method === "users.setPresence").map((c) => c.params["presence"])).toEqual(["auto", "away"]);
});

test("Discord presence identifies as online after hello, heartbeats with the last sequence, and stops beating on close", () => {
  const sent: string[] = [];
  let onMsg: (d: string) => void = () => {};
  const t = fakeTimers();
  let closed = false;
  const p = discordPresence(
    () => ({
      send: (d) => sent.push(d),
      close: () => {
        closed = true;
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onClose: () => {},
    }),
    "BOT",
    t.timers,
    { identify: () => {}, end: () => {} },
  );
  onMsg(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  onMsg(JSON.stringify({ op: 0, s: 3, t: "READY", d: {} }));
  t.fire();
  const identify = JSON.parse(sent[0] ?? "{}");
  expect(identify.op).toBe(2);
  expect(identify.d.token).toBe("BOT");
  expect(identify.d.presence.status).toBe("online");
  expect(JSON.parse(sent[1] ?? "{}")).toEqual({ op: 1, d: 3 });
  p.close();
  expect(closed).toBe(true);
  expect(t.live.size).toBe(0);
});

describe("seori presence slack", () => {
  const user = () => home({ slack: { botToken: "xoxb-test", userToken: "xoxc-test", cookie: "d-test" } });

  test("with the user token and cookie from secrets.json: PRESENCE_READY, then opened / tickled each minute; a dropped socket reopens; a failed tick warns; stop sets away", async () => {
    let tick = 0;
    const r = rig({
      answer: (method) => {
        if (method === "users.setPresence" && tick === 3) throw new Error("slack users.setPresence: service_unavailable");
        return socketAnswer(method);
      },
    });
    r.onSleep = (ms) => {
      if (ms !== SLACK_TICK_MS) return;
      tick++;
      if (tick === 2) r.lines[0]!.open = false; // the socket dropped
      if (tick === 3) r.lines[1]!.open = false; // dropped again, and the reopen fails once
      if (tick === 5) r.stop.abort();
    };
    expect(await runPresence(user(), "slack", r.deps, r.stop.signal)).toBe(0);
    expect(r.auths).toEqual([{ token: "xoxc-test", cookie: "d-test" }]);
    expect(r.out).toEqual([
      "PRESENCE_READY slack",
      "PRESENCE slack opened",
      "PRESENCE slack tickled",
      "PRESENCE slack opened",
      "WARN slack users.setPresence: service_unavailable",
      "PRESENCE slack opened",
    ]);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]!.frames).toEqual([{ type: "tickle", id: 1 }]);
    expect(r.lines[0]!.headers).toEqual({ Cookie: "d=d-test", Origin: "https://app.slack.com" });
    expect(new URL(r.lines[0]!.url).searchParams.get("token")).toBe("xoxc-test");
    expect(r.slept).toEqual([SLACK_TICK_MS, SLACK_TICK_MS, SLACK_TICK_MS, SLACK_TICK_MS, SLACK_TICK_MS, RELEASE_TIMEOUT_MS]);
    // setPresence auto on every open, away on release; never in answer to anything else
    expect(r.calls.filter((c) => c.method === "users.setPresence").map((c) => c.params["presence"])).toEqual(["auto", "auto", "auto", "auto", "away"]);
    expect(r.lines[2]!.open).toBe(false);
  });

  test("stop during an outage: every Slack call gets the abort signal, so the run settles promptly", async () => {
    const r = rig();
    const signals: (AbortSignal | undefined)[] = [];
    const called = Promise.withResolvers<void>();
    // A Slack API that never answers: a call ends only when its signal aborts.
    r.deps = {
      ...r.deps,
      slackApi: () => (_method, _params, signal) => {
        signals.push(signal);
        called.resolve();
        return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    };
    const run = runPresence(user(), "slack", r.deps, r.stop.signal);
    await called.promise;
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
    r.stop.abort();
    expect(await run).toBe(0);
    expect(signals[0]!.aborted).toBe(true);
    // the release (set away) call is bounded by its own deadline
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(true);
    expect(r.out).toEqual(["PRESENCE_READY slack", "WARN aborted"]);
  });

  test("an error carrying the client socket URL is printed with the token redacted", async () => {
    const r = rig();
    r.onSleep = () => r.stop.abort();
    r.deps = {
      ...r.deps,
      openSlack: (url) => {
        throw new Error(`connect failed: ${url}`);
      },
    };
    const root = home({ slack: { userToken: "xoxc-test-123", cookie: "d-test" } });
    expect(await runPresence(root, "slack", r.deps, r.stop.signal)).toBe(0);
    const warned = r.out.filter((l) => l.startsWith("WARN"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toStartWith("WARN connect failed: wss://wss-primary.example/");
    expect(warned[0]).toContain("token=REDACTED");
    expect(warned.join("\n")).not.toContain("xoxc-test-123");
  });

  test("the user token and cookie come from secrets.json: a missing key is named", async () => {
    const r = rig();
    await expect(runPresence(home({ slack: { botToken: "xoxb-test" } }), "slack", r.deps, r.stop.signal)).rejects.toThrow(`"slack": { "userToken": "..." }`);
    await expect(runPresence(home({ slack: { userToken: "xoxc-test" } }), "slack", r.deps, r.stop.signal)).rejects.toThrow(`"slack": { "cookie": "..." }`);
    expect(r.calls).toHaveLength(0);
  });
});

describe("seori presence discord", () => {
  const root = () => home({ discord: { token: "dc-test-token" } });

  test("identifies with status online and the configured token, heartbeats, and closes on stop", async () => {
    const r = rig({
      onOpen: (g) => {
        hello(g, 30_000);
        g.msg({ op: 0, s: 7, t: "READY", d: {} });
        r.t.fire();
        r.stop.abort();
      },
    });
    expect(await runPresence(root(), "discord", r.deps, r.stop.signal)).toBe(0);
    const g = r.gateways[0]!;
    const identify = g.sent[0] as { op: number; d: { token: string; presence: { status: string } } };
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("dc-test-token");
    expect(identify.d.presence.status).toBe("online");
    expect(g.sent.slice(1)).toEqual([{ op: 1, d: 7 }]);
    expect(g.closed).toBe(true);
    expect(r.t.live.size).toBe(0);
    expect(r.out).toEqual(["PRESENCE_READY discord"]);
  });

  test("a closed connection opens a new one that identifies again: backoff 5, 10 ... 300 s; a 61 s connection keeps it, a 10 min one resets it", async () => {
    expect(STABLE_MS).toBe(10 * 60_000);
    const r = rig({
      onOpen: (g, i) => {
        hello(g);
        if (i === 10) r.clock += 61_000; // held just over a minute: not stable
        if (i === 11) r.clock += 10 * 60_000; // held ten minutes: stable
        if (i === 13) return r.stop.abort();
        g.close(1006);
      },
    });
    expect(await runPresence(root(), "discord", r.deps, r.stop.signal)).toBe(0);
    expect(r.gateways).toHaveLength(14);
    expect(r.gateways.every((g) => ops(g)[0] === 2)).toBe(true);
    expect(reconnects(r.out)).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300, 300, 300, 5, 10]);
    expect(r.slept).toEqual(reconnects(r.out).map((s) => s * 1000));
    expect(r.out[1]).toBe("PRESENCE_RECONNECT discord code=1006 retry_in=5s");
    expect(r.out.filter((l) => l === "PRESENCE_READY discord")).toHaveLength(1);
  });

  test("a gateway that never acknowledges a heartbeat is closed as a zombie and a new one identifies", async () => {
    const r = rig({
      onOpen: (g, i) => {
        if (i === 1) return r.stop.abort();
        hello(g, 30_000);
        r.t.fire(); // first beat goes out
        r.t.fire(); // no op 11 came back: the second tick ends the connection
      },
    });
    expect(await runPresence(root(), "discord", r.deps, r.stop.signal)).toBe(0);
    expect(r.out).toContain("PRESENCE_RECONNECT discord code=zombie retry_in=5s");
    expect(r.gateways).toHaveLength(2);
    expect(r.gateways[0]!.closed).toBe(true);
    expect(ops(r.gateways[0]!)).toEqual([2, 1]);
  }, 2000);

  test("acknowledged heartbeats keep the connection, and an op 1 request is answered with an immediate heartbeat", async () => {
    const r = rig({
      onOpen: (g) => {
        hello(g, 30_000);
        g.msg({ op: 0, s: 4, t: "READY", d: {} });
        r.t.fire();
        g.msg({ op: 11 });
        r.t.fire();
        g.msg({ op: 11 });
        g.msg({ op: 1, d: null });
        r.stop.abort();
      },
    });
    expect(await runPresence(root(), "discord", r.deps, r.stop.signal)).toBe(0);
    expect(r.gateways).toHaveLength(1);
    expect(r.gateways[0]!.sent.slice(1)).toEqual([{ op: 1, d: 4 }, { op: 1, d: 4 }, { op: 1, d: 4 }]);
    expect(r.out).toEqual(["PRESENCE_READY discord"]);
    expect(r.t.live.size).toBe(0);
  }, 2000);

  test("a gateway that never sends hello is closed as no-hello and a new one identifies", async () => {
    const r = rig({
      onOpen: (_g, i) => {
        if (i === 1) return r.stop.abort();
        r.t.fire(); // the hello timeout passes
      },
    });
    expect(await runPresence(root(), "discord", r.deps, r.stop.signal)).toBe(0);
    expect(r.out).toContain("PRESENCE_RECONNECT discord code=no-hello retry_in=5s");
    expect(r.gateways).toHaveLength(2);
    expect(r.gateways[0]!.closed).toBe(true);
    expect(ops(r.gateways[0]!)).toEqual([]);
  }, 2000);

  test("op 7 and op 9 end the connection and a new one identifies", async () => {
    const r = rig({
      onOpen: (g, i) => {
        hello(g);
        if (i === 0) g.msg({ op: 7, d: null });
        else if (i === 1) g.msg({ op: 9, d: true });
        else r.stop.abort();
      },
    });
    expect(await runPresence(root(), "discord", r.deps, r.stop.signal)).toBe(0);
    expect(r.gateways).toHaveLength(3);
    expect(r.gateways[0]!.closed).toBe(true);
    expect(r.gateways[1]!.closed).toBe(true);
    expect(r.gateways.map((g) => ops(g)[0])).toEqual([2, 2, 2]);
    expect(r.out.filter((l) => l.startsWith("PRESENCE_RECONNECT"))).toEqual([
      "PRESENCE_RECONNECT discord code=op7 retry_in=5s",
      "PRESENCE_RECONNECT discord code=op9 retry_in=10s",
    ]);
  });

  test("close 4004 (authentication failed) exits 1 with a clear error and no new identify; 4014 too", async () => {
    for (const code of [4004, 4014]) {
      const r = rig({
        onOpen: (g) => {
          hello(g);
          g.close(code);
        },
      });
      expect(await runPresence(root(), "discord", r.deps, r.stop.signal)).toBe(1);
      expect(r.gateways).toHaveLength(1);
      expect(r.slept).toEqual([]);
      expect(r.out.some((l) => l.startsWith("PRESENCE_RECONNECT"))).toBe(false);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toStartWith("PRESENCE_FAILED discord: Discord");
      expect(r.err[0]).toContain(`close ${code}`);
    }
  });

  test("identify budget: with 200 identifies in the last 24 h it prints PRESENCE_WAIT and opens no connection until the window passes", async () => {
    expect(DISCORD_IDENTIFY_BUDGET).toBe(200);
    const dir = root();
    const start = 30 * IDENTIFY_WINDOW_MS;
    const oldest = start - IDENTIFY_WINDOW_MS + 90_000; // leaves the window 90 s from now
    mkdirSync(join(dir, "presence"), { recursive: true });
    const state = join(dir, "presence", "discord-identify.json");
    writeFileSync(state, JSON.stringify([oldest, ...Array.from({ length: 199 }, () => start - 1_000)]));
    const r = rig({
      onOpen: (g) => {
        hello(g);
        r.stop.abort();
      },
    });
    r.clock = start;
    r.onSleep = (ms) => void (r.clock += ms);
    expect(await runPresence(dir, "discord", r.deps, r.stop.signal)).toBe(0);
    expect(r.out[0]).toBe("PRESENCE_WAIT discord identify budget spent; next identify in 90s");
    expect(r.slept).toEqual([90_000]);
    expect(r.gateways).toHaveLength(1);
    expect(r.gateways[0]!.at).toBe(start + 90_000); // no connection (so no op 2) before the window passed
    expect(ops(r.gateways[0]!)[0]).toBe(2);
    const kept = JSON.parse(readFileSync(state, "utf8")) as number[];
    expect(kept).toHaveLength(200); // the oldest left the window, this identify was added
    expect(kept.at(-1)).toBe(start + 90_000);
  });

  test("no token in the config refuses with the secrets.json key named", async () => {
    const r = rig();
    await expect(runPresence(home(), "discord", r.deps, r.stop.signal)).rejects.toThrow(`"discord": { "token": "..." }`);
    expect(r.gateways).toHaveLength(0);
  });
});

test("seori presence: an unknown platform and a missing token are refusals (exit 2) naming what to fix", async () => {
  const w = new World();
  const d = w.deps();
  const errors: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const refused = async (argv: string[]) => main(argv, d).then(() => "ran", (e: Error) => `${e.constructor.name}: ${e.message}`);
    expect(await refused(["presence", "telegram"])).toStartWith("Refusal: seori presence takes slack or discord");
    const missing = await refused(["presence", "discord"]);
    expect(missing).toStartWith("Refusal: no discord token");
    expect(missing).toContain(`"discord": { "token": "..." }`);
    expect(await refused(["presence", "slack"])).toStartWith("Refusal: no slack userToken");
  } finally {
    console.error = err;
  }
});
