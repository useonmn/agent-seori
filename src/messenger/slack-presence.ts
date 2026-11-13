// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// Slack shows a user-token account as active only while a web-client-type socket is open: rtm.connect sockets are typed
// as bot connections and never count. One such socket stays green; an idle one is auto-awayed after ~30 min, so a
// tickle frame every minute keeps it active. Never answer a manual_presence_change event with setPresence: two
// writers echo each other into a flip-flop loop.
import { httpJson } from "./common.ts";

export type SlackAuth = { readonly token: string; readonly cookie: string };
/** One Slack Web API call with the account's token and cookie; resolves the `ok: true` body. `signal` aborts it. */
export type SlackCall = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
export type ClientLine = { isOpen(): boolean; send(frame: string): void; close(): void };
export type OpenLine = (url: string, headers: Readonly<Record<string, string>>) => ClientLine;

export const clientSocketUrl = async (call: SlackCall, token: string, signal?: AbortSignal): Promise<string> => {
  const res = await call("client.getWebSocketURL", {}, signal);
  if (typeof res["primary_websocket_url"] !== "string" || typeof res["routing_context"] !== "string")
    throw new Error("client.getWebSocketURL returned an unexpected shape");
  const url = new URL(res["primary_websocket_url"]);
  const params: Record<string, string> = {
    token,
    sync_desync: "1",
    slack_client: "desktop",
    start_args: "?agent=client&org_wide_aware=true&connect_only=true&ms_latest=true",
    no_query_on_subscribe: "1",
    flannel: "3",
    lazy_channels: "1",
    gateway_server: res["routing_context"],
    batch_presence_aware: "1",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
};

export const slackPresence = (call: SlackCall, open: OpenLine, auth: SlackAuth) => {
  let line: ClientLine | null = null;
  let id = 0;
  return {
    async hold(signal?: AbortSignal): Promise<"opened" | "tickled"> {
      if (line?.isOpen()) {
        line.send(JSON.stringify({ type: "tickle", id: ++id }));
        return "tickled";
      }
      await call("users.setPresence", { presence: "auto" }, signal);
      line = open(await clientSocketUrl(call, auth.token, signal), {
        Cookie: `d=${auth.cookie}`,
        Origin: "https://app.slack.com",
      });
      return "opened";
    },
    async release(signal?: AbortSignal): Promise<void> {
      line?.close();
      line = null;
      await call("users.setPresence", { presence: "away" }, signal);
    },
  };
};

/** The real Slack Web API for one account: bearer token plus the `d` cookie; `ok: false` is an error. */
export const slackApi = (auth: SlackAuth, base = "https://slack.com/api"): SlackCall => async (method, params, signal) => {
  const headers = { Authorization: `Bearer ${auth.token}`, Cookie: `d=${auth.cookie}` };
  // The signal also cuts httpJson's retry waits short, so a stop during an outage returns promptly.
  const sleep = (ms: number) => (signal ? abortableSleep(ms, signal) : Bun.sleep(ms));
  const res = await httpJson(`${base}/${method}`, { method: "POST", headers, body: params, ...(signal ? { signal } : {}) }, { mutating: false, sleep });
  const body = (res.body ?? {}) as Record<string, unknown>;
  if (body["ok"] !== true) throw new Error(`slack ${method}: ${String(body["error"] ?? res.status)}`);
  return body;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}
