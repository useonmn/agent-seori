// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { type LineEvents, type PresenceDeps, runPresence, SLACK_REASSERT_MS, SLACK_TICKLE_MS, SlackCallError } from "../src/messenger/presence.ts";
import { World } from "./fake.ts";

// `seori presence`: sockets, timers, sleep, clock and the Slack Web API are all injected; nothing touches the network.

const home = (secrets?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "seori-presence-"));
  if (secrets) writeFileSync(join(root, "secrets.json"), JSON.stringify(secrets), { mode: 0o600 });
  return root;
};

type Conn = { url: string; headers: Record<string, string>; on: LineEvents; sent: unknown[]; closed: number | undefined };

/** Fake world: `onOpen` runs for each new connection (index from 0) and drives it. */
function rig(onOpen: (c: Conn, i: number, r: ReturnType<typeof base>) => void = () => {}) {
  const r = base();
  r.deps = {
    ...r.deps,
    open: (url, headers, on) => {
      const c: Conn = { url, headers: { ...headers }, on, sent: [], closed: undefined };
      r.conns.push(c);
      queueMicrotask(() => onOpen(c, r.conns.length - 1, r));
      return {
        send: (f) => void c.sent.push(JSON.parse(f)),
        close: (code) => {
          c.closed = code ?? 1000;
        },
      };
    },
  };
  return r;
}

function base() {
  const stop = new AbortController();
  const r = {
    stop,
    clock: 0,
    out: [] as string[],
    err: [] as string[],
    slept: [] as number[],
    calls: [] as { method: string; token: string; params: Record<string, string>; cookie?: string }[],
    intervals: [] as { cb: () => void; ms: number; live: boolean }[],
    conns: [] as Conn[],
    slackAnswer: (_method: string, _n: number): Record<string, unknown> => ({ ok: true }),
    deps: undefined as unknown as PresenceDeps,
  };
  r.deps = {
    open: () => {
      throw new Error("no socket in this test");
    },
    timers: {
      setInterval: (cb, ms) => {
        const h = { cb, ms, live: true };
        r.intervals.push(h);
        return h;
      },
      clearInterval: (h) => {
        (h as { live: boolean }).live = false;
      },
    },
    sleep: async (ms) => {
      r.slept.push(ms);
    },
    now: () => r.clock,
    log: (l) => void r.out.push(l),
    error: (l) => void r.err.push(l),
    slackCall: async (method, token, params, cookie) => {
      r.calls.push({ method, token, params, ...(cookie ? { cookie } : {}) });
      return r.slackAnswer(method, r.calls.length);
    },
    env: {},
  };
  return r;
}

const reconnects = (out: string[]) => out.filter((l) => l.startsWith("PRESENCE_RECONNECT")).map((l) => Number(/retry_in=(\d+)s/.exec(l)![1]));
const hello = (c: Conn, interval = 41_250) => c.on.onMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: interval } }));
const readyEvent = (c: Conn, s = 1) => c.on.onMessage(JSON.stringify({ op: 0, s, t: "READY", d: {} }));

describe("seori presence discord", () => {
  const root = () => home({ discord: { token: "dc-test-token" } });

  test("identifies with status online and the configured token, heartbeats at the hello interval, and closes on stop", async () => {
    const r = rig((c, _i, r) => {
      hello(c, 30_000);
      readyEvent(c, 7);
      r.intervals[0]!.cb();
      c.on.onMessage(JSON.stringify({ op: 11 }));
      r.intervals[0]!.cb();
      r.stop.abort();
    });
    expect(await runPresence(root(), "discord", {}, r.deps, r.stop.signal)).toBe(0);
    const c = r.conns[0]!;
    expect(c.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    const identify = c.sent[0] as { op: number; d: { token: string; presence: { status: string } } };
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("dc-test-token");
    expect(identify.d.presence.status).toBe("online");
    expect(r.intervals.map((i) => i.ms)).toEqual([30_000]);
    expect(c.sent.slice(1)).toEqual([{ op: 1, d: 7 }, { op: 1, d: 7 }]);
    expect(c.closed).toBe(1000);
    expect(r.intervals[0]!.live).toBe(false);
    expect(r.out).toEqual(["PRESENCE_READY discord"]);
  });

  test("a closed socket opens a new session: backoff 5, 10, 20 ... capped at 300 s, reset after a 60 s session", async () => {
    const r = rig((c, i, r) => {
      hello(c);
      readyEvent(c);
      if (i === 10) r.clock += 60_000; // this session holds a minute
      if (i === 12) return r.stop.abort();
      c.on.onClose(1006);
    });
    expect(await runPresence(root(), "discord", {}, r.deps, r.stop.signal)).toBe(0);
    expect(r.conns).toHaveLength(13);
    expect(reconnects(r.out)).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300, 300, 5, 10]);
    expect(r.slept).toEqual(reconnects(r.out).map((s) => s * 1000));
    expect(r.out[1]).toBe("PRESENCE_RECONNECT discord code=1006 retry_in=5s");
    expect(r.out.filter((l) => l === "PRESENCE_READY discord")).toHaveLength(1);
  });

  test("op 7 (reconnect) and op 9 (invalid session) end the session and open a new one", async () => {
    const r = rig((c, i, r) => {
      hello(c);
      readyEvent(c);
      if (i === 0) c.on.onMessage(JSON.stringify({ op: 7, d: null }));
      else if (i === 1) c.on.onMessage(JSON.stringify({ op: 9, d: false }));
      else r.stop.abort();
    });
    expect(await runPresence(root(), "discord", {}, r.deps, r.stop.signal)).toBe(0);
    expect(r.conns).toHaveLength(3);
    expect(r.conns[0]!.closed).toBe(1000);
    expect(r.conns[1]!.closed).toBe(1000);
    expect(r.out.filter((l) => l.startsWith("PRESENCE_RECONNECT"))).toEqual([
      "PRESENCE_RECONNECT discord code=op7 retry_in=5s",
      "PRESENCE_RECONNECT discord code=op9 retry_in=10s",
    ]);
  });

  test("close 4004 (authentication failed) exits 1 with a clear error and no retry; 4014 too", async () => {
    for (const code of [4004, 4014]) {
      const r = rig((c) => {
        hello(c);
        c.on.onClose(code);
      });
      expect(await runPresence(root(), "discord", {}, r.deps, r.stop.signal)).toBe(1);
      expect(r.conns).toHaveLength(1);
      expect(r.slept).toEqual([]);
      expect(r.out.some((l) => l.startsWith("PRESENCE_RECONNECT"))).toBe(false);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toContain(`PRESENCE_FAILED discord: Discord`);
      expect(r.err[0]).toContain(`close ${code}`);
    }
  });

  test("a missed heartbeat ack ends a zombie session and reconnects", async () => {
    const r = rig((c, i, r) => {
      hello(c);
      if (i === 1) return r.stop.abort();
      r.intervals[0]!.cb(); // beat, no ack follows
      r.intervals[0]!.cb();
    });
    expect(await runPresence(root(), "discord", {}, r.deps, r.stop.signal)).toBe(0);
    expect(r.out).toContain("PRESENCE_RECONNECT discord code=heartbeat-not-acked retry_in=5s");
  });

  test("no token in the config refuses with the secrets.json key named", async () => {
    const r = rig();
    await expect(runPresence(home(), "discord", {}, r.deps, r.stop.signal)).rejects.toThrow(`"discord": { "token": "..." }`);
    expect(r.conns).toHaveLength(0);
  });
});

describe("seori presence slack", () => {
  test("bot mode: users.setPresence auto with the configured bot token, re-asserted; a failed call backs off; stop sets away", async () => {
    const r = base();
    r.slackAnswer = (_m, n) => {
      if (n === 2) throw new SlackCallError("users.setPresence", "service_unavailable");
      if (n === 4) r.stop.abort();
      return { ok: true };
    };
    const root = home({ slack: { botToken: "xoxb-test", appToken: "xapp-test" } });
    expect(await runPresence(root, "slack", {}, r.deps, r.stop.signal)).toBe(0);
    expect(r.calls.map((c) => `${c.token} ${c.params["presence"]}`)).toEqual(["xoxb-test auto", "xoxb-test auto", "xoxb-test auto", "xoxb-test auto", "xoxb-test away"]);
    expect(r.out[0]).toBe("PRESENCE_READY slack");
    expect(r.out).toContain("PRESENCE_RECONNECT slack code=service_unavailable retry_in=5s");
    expect(r.slept).toEqual([SLACK_REASSERT_MS, 5_000, SLACK_REASSERT_MS]);
    expect(r.out.at(-1)).toBe("PRESENCE slack away");
  });

  test("bot mode: a rejected token exits 1 without retrying", async () => {
    const r = base();
    r.slackAnswer = () => {
      throw new SlackCallError("users.setPresence", "invalid_auth");
    };
    expect(await runPresence(home({ slack: { botToken: "xoxb-test" } }), "slack", {}, r.deps, r.stop.signal)).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.err[0]).toContain("invalid_auth");
  });

  const user = () => home({ slack: { botToken: "xoxb-test", userToken: "xoxc-test", cookie: "d-test" } });
  const socketAnswer = (method: string) =>
    method === "client.getWebSocketURL" ? { ok: true, primary_websocket_url: "wss://wss-primary.example/", routing_context: "gw-1" } : { ok: true };

  test("user mode: a client socket with the configured token and cookie, tickled; a drop reconnects with backoff; manual_presence_change is left alone", async () => {
    const r = rig((c, i, r) => {
      c.on.onMessage(JSON.stringify({ type: "hello" }));
      if (i === 0) {
        r.intervals[0]!.cb();
        c.on.onMessage(JSON.stringify({ type: "manual_presence_change", presence: "away" }));
        c.on.onClose(1006);
      } else r.stop.abort();
    });
    r.slackAnswer = socketAnswer;
    expect(await runPresence(user(), "slack", { user: true }, r.deps, r.stop.signal)).toBe(0);
    expect(r.conns).toHaveLength(2);
    const url = new URL(r.conns[0]!.url);
    expect(url.searchParams.get("token")).toBe("xoxc-test");
    expect(url.searchParams.get("slack_client")).toBe("desktop");
    expect(url.searchParams.get("gateway_server")).toBe("gw-1");
    expect(r.conns[0]!.headers).toEqual({ Cookie: "d=d-test", Origin: "https://app.slack.com" });
    expect(r.conns[0]!.sent).toEqual([{ type: "tickle", id: 1 }]);
    expect(r.intervals[0]!.ms).toBe(SLACK_TICKLE_MS);
    expect(r.out.filter((l) => l.startsWith("PRESENCE_RECONNECT"))).toEqual(["PRESENCE_RECONNECT slack code=1006 retry_in=5s"]);
    // setPresence only at start (auto) and on release (away): never in answer to manual_presence_change
    expect(r.calls.filter((c) => c.method === "users.setPresence").map((c) => c.params["presence"])).toEqual(["auto", "away"]);
    expect(r.calls.every((c) => c.token === "xoxc-test" && c.cookie === "d-test")).toBe(true);
    expect(r.calls.filter((c) => c.method === "client.getWebSocketURL")).toHaveLength(2);
    expect(r.conns[1]!.closed).toBe(1000);
  });

  test("user mode needs userToken and cookie in secrets.json: the missing key is named", async () => {
    const r = base();
    await expect(runPresence(home({ slack: { botToken: "xoxb-test" } }), "slack", { user: true }, r.deps, r.stop.signal)).rejects.toThrow(`"slack": { "userToken": "..." }`);
    await expect(runPresence(home(), "slack", {}, r.deps, r.stop.signal)).rejects.toThrow(`"slack": { "botToken": "..." }`);
    expect(r.calls).toHaveLength(0);
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
  } finally {
    console.error = err;
  }
});
