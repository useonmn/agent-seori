// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import {
  DISCORD_IDENTIFY_BUDGET, IDENTIFY_WINDOW_MS, type LineEvents, type PresenceDeps, RELEASE_TIMEOUT_MS, runPresence, SLACK_REASSERT_MS, SLACK_TICKLE_MS, SlackCallError, STABLE_MS,
} from "../src/messenger/presence.ts";
import { World } from "./fake.ts";

// `seori presence`: sockets, timers, sleep, clock and the Slack Web API are all injected; nothing touches the network.

const home = (secrets?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "seori-presence-"));
  if (secrets) writeFileSync(join(root, "secrets.json"), JSON.stringify(secrets), { mode: 0o600 });
  return root;
};

type Conn = { url: string; headers: Record<string, string>; on: LineEvents; sent: unknown[]; closed: number | undefined; at: number };

/** Fake world: `onOpen` runs for each new connection (index from 0) and drives it. */
function rig(onOpen: (c: Conn, i: number, r: ReturnType<typeof base>) => void = () => {}) {
  const r = base();
  r.deps = {
    ...r.deps,
    open: (url, headers, on) => {
      const c: Conn = { url, headers: { ...headers }, on, sent: [], closed: undefined, at: r.clock };
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
const resumableReady = (c: Conn, s = 1) =>
  c.on.onMessage(JSON.stringify({ op: 0, s, t: "READY", d: { session_id: "sess-1", resume_gateway_url: "wss://resume.example" } }));
const ops = (c: Conn) => c.sent.map((f) => (f as { op: number }).op);

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

  test("a closed socket opens a new session: backoff 5, 10, 20 ... capped at 300 s; a 61 s session keeps it, a 10 min one resets it", async () => {
    expect(STABLE_MS).toBe(10 * 60_000);
    const r = rig((c, i, r) => {
      hello(c);
      readyEvent(c);
      if (i === 10) r.clock += 61_000; // held just over a minute: not stable
      if (i === 11) r.clock += 10 * 60_000; // held ten minutes: stable
      if (i === 13) return r.stop.abort();
      c.on.onClose(1006);
    });
    expect(await runPresence(root(), "discord", {}, r.deps, r.stop.signal)).toBe(0);
    expect(r.conns).toHaveLength(14);
    expect(reconnects(r.out)).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300, 300, 300, 5, 10]);
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

  test("after READY a dropped connection resumes at resume_gateway_url with op 6 and the last seq, no op 2", async () => {
    const r = rig((c, i, r) => {
      hello(c);
      if (i === 0) {
        resumableReady(c, 1);
        c.on.onMessage(JSON.stringify({ op: 0, s: 5, t: "GUILD_CREATE", d: {} }));
        c.on.onClose(1006);
      } else {
        c.on.onMessage(JSON.stringify({ op: 0, s: 6, t: "RESUMED", d: null }));
        r.stop.abort();
      }
    });
    expect(await runPresence(root(), "discord", {}, r.deps, r.stop.signal)).toBe(0);
    expect(r.conns).toHaveLength(2);
    expect(r.conns[1]!.url).toBe("wss://resume.example/?v=10&encoding=json");
    expect(r.conns[1]!.sent[0]).toEqual({ op: 6, d: { token: "dc-test-token", session_id: "sess-1", seq: 5 } });
    expect(ops(r.conns[1]!)).not.toContain(2);
    expect(r.out.filter((l) => l === "PRESENCE_READY discord")).toHaveLength(1);
  });

  test("op 9 d=false and close 4009 drop the session (fresh op 2 at the normal URL); op 9 d=true resumes", async () => {
    const cases: [string, (c: Conn) => void, string, number][] = [
      ["op9 false", (c) => c.on.onMessage(JSON.stringify({ op: 9, d: false })), "wss://gateway.discord.gg/?v=10&encoding=json", 2],
      ["close 4009", (c) => c.on.onClose(4009), "wss://gateway.discord.gg/?v=10&encoding=json", 2],
      ["op9 true", (c) => c.on.onMessage(JSON.stringify({ op: 9, d: true })), "wss://resume.example/?v=10&encoding=json", 6],
    ];
    for (const [name, end, url, op] of cases) {
      const r = rig((c, i, r) => {
        hello(c);
        if (i === 0) {
          resumableReady(c, 3);
          c.on.onClose(1006);
        } else if (i === 1) end(c); // the resume attempt is refused (or the resumed session dies)
        else r.stop.abort();
      });
      expect(await runPresence(root(), "discord", {}, r.deps, r.stop.signal)).toBe(0);
      expect(r.conns, name).toHaveLength(3);
      expect(ops(r.conns[1]!)[0], name).toBe(6);
      expect(r.conns[2]!.url, name).toBe(url);
      expect(ops(r.conns[2]!)[0], name).toBe(op);
    }
  });

  test("identify budget: when 200 identifies sit in the last 24 h it prints PRESENCE_WAIT and identifies only after the window; resumes are not counted", async () => {
    expect(DISCORD_IDENTIFY_BUDGET).toBe(200);
    const dir = root();
    const start = 30 * IDENTIFY_WINDOW_MS;
    const oldest = start - IDENTIFY_WINDOW_MS + 90_000; // leaves the window 90 s from now
    mkdirSync(join(dir, "presence"), { recursive: true });
    const state = join(dir, "presence", "discord-identify.json");
    writeFileSync(state, JSON.stringify([oldest, ...Array.from({ length: 199 }, () => start - 1_000)]));
    const r = rig((c, i, r) => {
      hello(c);
      if (i === 0) {
        resumableReady(c, 2);
        c.on.onClose(1006);
      } else {
        c.on.onMessage(JSON.stringify({ op: 0, s: 3, t: "RESUMED", d: null }));
        r.stop.abort();
      }
    });
    r.clock = start;
    r.deps = { ...r.deps, sleep: async (ms) => void (r.slept.push(ms), (r.clock += ms)) };
    expect(await runPresence(dir, "discord", {}, r.deps, r.stop.signal)).toBe(0);
    expect(r.out[0]).toBe("PRESENCE_WAIT discord identify budget spent; next identify in 90s");
    expect(r.slept[0]).toBe(90_000);
    expect(r.conns[0]!.at).toBe(start + 90_000); // no socket (so no op 2) before the window passed
    expect(ops(r.conns[0]!)[0]).toBe(2);
    // the budget is full again (199 + this identify), yet the resume goes out without waiting and is not recorded
    expect(r.conns).toHaveLength(2);
    expect(ops(r.conns[1]!)[0]).toBe(6);
    expect(r.out.filter((l) => l.startsWith("PRESENCE_WAIT"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(state, "utf8"))).toHaveLength(200);
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
    expect(r.slept).toEqual([SLACK_REASSERT_MS, 5_000, SLACK_REASSERT_MS, RELEASE_TIMEOUT_MS]);
    expect(r.out.at(-1)).toBe("PRESENCE slack away");
  });

  test("stop during an outage: every Slack call gets the abort signal, so the run settles promptly", async () => {
    const r = base();
    const signals: (AbortSignal | undefined)[] = [];
    const called = Promise.withResolvers<void>();
    // A Slack API that never answers: a call ends only when its signal aborts.
    r.deps = {
      ...r.deps,
      slackCall: (_method, _token, _params, _cookie, signal) => {
        signals.push(signal);
        called.resolve();
        return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    };
    const run = runPresence(home({ slack: { botToken: "xoxb-test" } }), "slack", {}, r.deps, r.stop.signal);
    await called.promise;
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
    r.stop.abort();
    expect(await run).toBe(0);
    expect(signals[0]!.aborted).toBe(true);
    // the release (set away) call is bounded by its own deadline
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(true);
    expect(r.err).toEqual(["PRESENCE slack: could not set away on release: aborted"]);
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

  test("user mode: a socket error carrying the client URL prints PRESENCE_FAILED with the token redacted", async () => {
    const r = base();
    r.slackAnswer = socketAnswer;
    r.deps = {
      ...r.deps,
      open: (url) => {
        throw new Error(`connect failed: ${url}`);
      },
    };
    const root = home({ slack: { botToken: "xoxb-test", userToken: "xoxc-test-123", cookie: "d-test" } });
    expect(await runPresence(root, "slack", { user: true }, r.deps, r.stop.signal)).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toStartWith("PRESENCE_FAILED slack: cannot open the Slack client socket");
    expect(r.err[0]).toContain("token=REDACTED");
    expect(r.err[0]).not.toContain("xoxc-test-123");
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
