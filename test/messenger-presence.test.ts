// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import {
  DISCORD_IDENTIFY_BUDGET, discordPresence, IDENTIFY_WINDOW_MS, type PresenceDeps, runPresence, STABLE_MS,
} from "../src/messenger/presence.ts";
import { World } from "./fake.ts";

// `seori presence`: sockets, timers, sleep and clock are all injected; nothing touches the network.

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

type Gateway = { sent: unknown[]; closed: boolean; at: number; msg: (m: unknown) => void; close: (code: number) => void };

/** The whole run's world: `onOpen` drives each new Discord connection. */
function rig(opts: { onOpen?: (g: Gateway, i: number) => void } = {}) {
  const stop = new AbortController();
  const t = fakeTimers();
  const r = {
    stop,
    t,
    clock: 0,
    out: [] as string[],
    err: [] as string[],
    slept: [] as number[],
    gateways: [] as Gateway[],
    onSleep: (_ms: number) => {},
    deps: undefined as unknown as PresenceDeps,
  };
  r.deps = {
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
    expect(await runPresence(root(), r.deps, r.stop.signal)).toBe(0);
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
    expect(await runPresence(root(), r.deps, r.stop.signal)).toBe(0);
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
    expect(await runPresence(root(), r.deps, r.stop.signal)).toBe(0);
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
    expect(await runPresence(root(), r.deps, r.stop.signal)).toBe(0);
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
    expect(await runPresence(root(), r.deps, r.stop.signal)).toBe(0);
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
    expect(await runPresence(root(), r.deps, r.stop.signal)).toBe(0);
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
      expect(await runPresence(root(), r.deps, r.stop.signal)).toBe(1);
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
    expect(await runPresence(dir, r.deps, r.stop.signal)).toBe(0);
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
    await expect(runPresence(home(), r.deps, r.stop.signal)).rejects.toThrow(`"discord": { "token": "..." }`);
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
    expect(await refused(["presence", "telegram"])).toStartWith("Refusal: seori presence takes discord");
    expect(await refused(["presence", "slack"])).toStartWith("Refusal: seori presence takes discord");
    const missing = await refused(["presence", "discord"]);
    expect(missing).toStartWith("Refusal: no discord token");
    expect(missing).toContain(`"discord": { "token": "..." }`);
  } finally {
    console.error = err;
  }
});
