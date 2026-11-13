import type { Socket } from "bun";

// A tiny HTTP proxy (CONNECT tunnels, and plain-http requests in absolute form) whose behaviour the e2e test switches at run time: "refuse" answers every tunnel request
// with 502 (the client sees a provider connection failure), "pass" tunnels bytes to the requested host. omp routes
// provider traffic through PI_PROXY, so pointing a lead at this proxy simulates a provider outage and its recovery.

export type ProxyMode = "refuse" | "pass";

export type SwitchProxy = {
  readonly url: string;
  mode: ProxyMode;
  /** CONNECT requests seen per mode: proves the client really goes through the proxy. */
  readonly seen: Record<ProxyMode, number>;
  stop(): void;
};

/** Bun's socket.write may take only part of a buffer; the rest waits here until the socket drains. */
class Out {
  private queue: Buffer[] = [];
  private ending = false;
  constructor(private readonly socket: () => Socket<unknown> | undefined) {}

  write(data: Uint8Array): void {
    if (data.length) this.queue.push(Buffer.from(data));
    this.flush();
  }

  end(): void {
    this.ending = true;
    this.flush();
  }

  flush(): void {
    const s = this.socket();
    if (!s) return;
    while (this.queue.length) {
      const head = this.queue[0]!;
      const n = s.write(head);
      if (n < head.length) {
        this.queue[0] = head.subarray(Math.max(n, 0));
        return;
      }
      this.queue.shift();
    }
    if (this.ending) s.end();
  }
}

type Client = { head: Buffer; tunnel?: { toUpstream: Out; toClient: Out; upstream?: Socket<undefined> }; closed: boolean };

export function startSwitchProxy(mode: ProxyMode = "pass"): SwitchProxy {
  const state = { mode, seen: { refuse: 0, pass: 0 } as Record<ProxyMode, number> };
  // Keep-alive connections outlive a switch to "refuse": an outage must cut the tunnels already open too.
  const live = new Set<Socket<Client>>();
  const server = Bun.listen<Client>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { head: Buffer.alloc(0), closed: false };
        live.add(s);
      },
      data(s, chunk) {
        const c = s.data;
        if (c.tunnel) {
          c.tunnel.toUpstream.write(chunk);
          return;
        }
        c.head = Buffer.concat([c.head, chunk]);
        const end = c.head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const request = c.head.subarray(0, end).toString("latin1");
        const early = c.head.subarray(end + 4);
        // CONNECT host:port for https; a plain-http provider (a local endpoint) is asked in absolute form instead,
        // which is passed on verbatim (servers take the absolute form) over a connection to that host. That connection
        // then carries the rest of the client's keep-alive requests too: omp sends them all to its one provider
        // endpoint, and a switch to "refuse" cuts every open connection anyway.
        const connect = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]/.exec(request);
        const plain = connect ? null : /^[A-Z]+ http:\/\/([^\s:/]+)(?::(\d+))?[^\s]* HTTP\/1\.[01]/.exec(request);
        const m = connect ?? (plain && [plain[0], plain[1], plain[2] ?? "80"]);
        if (!m) {
          s.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        state.seen[state.mode]++;
        if (state.mode === "refuse") {
          s.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const tunnel: NonNullable<Client["tunnel"]> = {
          toUpstream: new Out(() => tunnel.upstream as Socket<unknown> | undefined),
          toClient: new Out(() => (c.closed ? undefined : (s as Socket<unknown>))),
        };
        c.tunnel = tunnel;
        tunnel.toUpstream.write(connect ? early : c.head);
        Bun.connect<undefined>({
          hostname: m[1]!,
          port: Number(m[2]),
          socket: {
            open(up) {
              tunnel.upstream = up;
              if (connect) tunnel.toClient.write(Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
              tunnel.toUpstream.flush();
            },
            data(_up, d) {
              tunnel.toClient.write(d);
            },
            drain() {
              tunnel.toUpstream.flush();
            },
            close() {
              tunnel.toClient.end();
            },
            error() {
              tunnel.toClient.end();
            },
          },
        }).catch(() => s.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"));
      },
      drain(s) {
        s.data.tunnel?.toClient.flush();
      },
      close(s) {
        live.delete(s);
        s.data.closed = true;
        s.data.tunnel?.toUpstream.end();
      },
      error(s) {
        live.delete(s);
        s.data.closed = true;
        s.data.tunnel?.toUpstream.end();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    get mode() {
      return state.mode;
    },
    set mode(m: ProxyMode) {
      state.mode = m;
      if (m === "refuse") for (const s of live) s.terminate();
    },
    seen: state.seen,
    stop: () => server.stop(true),
  };
}
