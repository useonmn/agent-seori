// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// A fake `hc` binary (run by bun through a `hc` shim on PATH): records each argv line to $FAKE_HC_DIR/calls.jsonl and
// answers with the JSON shapes hc 0.1.20 printed on this host (see the spike notes), over a terminals map kept in
// $FAKE_HC_DIR/state.json. Errors go to stderr as {"error":{kind,message,hint}} with hc's exit code for the kind.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeStatus = { state: string; app?: string } | null;
export type FakeTerminal = {
  state: "live" | "finished";
  pid?: number;
  title?: string;
  cwd?: string;
  status: FakeStatus;
  turn: number;
  foreground: { name: string; argv: string[]; pid: number } | null;
  name?: string;
  labels: Record<string, string>;
  argv?: string[];
  screen?: string;
};

export type FakeKnobs = {
  /** Every `send` answers this error kind and types nothing. */
  sendError?: string;
  /** Every `send` exits 1 with no JSON at all (a transport failure). */
  sendGarbled?: boolean;
  /** Overrides `started` in a send answer. */
  started?: boolean | null;
  /** How many `rm` calls answer `live` after a kill. */
  liveAfterKill?: number;
  /** The next `run` with --name answers `name_taken`. */
  nameTaken?: boolean;
  /** `get` answers this error kind for every terminal. */
  getError?: string;
  /** `read` answers this error kind for every terminal. */
  readError?: string;
  /** A send into a silent terminal makes omp report idle in front (an agent start). */
  agentReports?: boolean;
  /** The status word the agent reports after such a start (default idle). */
  agentReportsAs?: string;
};

export type FakeState = { terminals: Record<string, FakeTerminal>; knobs: FakeKnobs; next: number; sent: { id: string; text: string }[] };

const EXIT: Readonly<Record<string, number>> = {
  usage: 2,
  not_found: 3,
  unavailable: 5,
  blocked: 9,
  status_mismatch: 10,
  finished: 11,
};

type Out = { code: number; stdout?: unknown; stderr?: string };
const ok = (value: unknown): Out => ({ code: 0, stdout: value });
const fail = (kind: string, message: string, hint = `hint for ${kind}`): Out => ({
  code: EXIT[kind] ?? 1,
  stderr: JSON.stringify({ error: { hint, kind, message } }),
});
const base = (p: string): string => p.split("/").pop() ?? p;

function getShape(id: string, t: FakeTerminal): Record<string, unknown> {
  return {
    address: id,
    argv: t.argv ?? ["bash"],
    cols: 200,
    created_ms: 1794521980870,
    cwd: t.cwd ?? "/w",
    die_with_parent: false,
    exit_code: null,
    finished_ms: t.state === "finished" ? 1794521990000 : null,
    foreground: t.foreground === null ? null : { ...t.foreground, cwd: t.cwd ?? "/w" },
    keep: false,
    labels: t.labels,
    name: t.name ?? null,
    notify: false,
    parent: null,
    pid: t.pid ?? 900,
    reason: t.state === "finished" ? "killed" : null,
    rows: 120,
    signal: t.state === "finished" ? 1 : null,
    state: t.state,
    status: t.status,
    status_ms: t.status === null ? null : 1794522005152,
    title: t.title ?? "user@host: /tmp/work",
    turn: t.turn,
  };
}

export function answer(s: FakeState, args: string[]): Out {
  const [verb, id] = args;
  const k = s.knobs;
  if (verb === "run") {
    if (k.nameTaken && args.includes("--name")) {
      k.nameTaken = false;
      return fail("name_taken", "that name is taken");
    }
    const labels: Record<string, string> = {};
    let cwd = "/w";
    let name: string | undefined;
    const dash = args.indexOf("--");
    const opts = dash < 0 ? args : args.slice(0, dash);
    opts.forEach((a, i) => {
      const v = opts[i + 1];
      if (v === undefined) return;
      if (a === "--label") labels[v.split("=")[0] ?? ""] = v.split("=").slice(1).join("=");
      if (a === "--cwd") cwd = v;
      if (a === "--name") name = v;
    });
    const argv = dash < 0 ? ["bash"] : args.slice(dash + 1);
    const shell = argv.at(-1) ?? "bash";
    const address = `t${(s.next++).toString(36)}`;
    s.terminals[address] = {
      state: "live",
      pid: 5000 + s.next,
      cwd,
      status: null,
      turn: 0,
      foreground: { name: base(shell), argv: [shell], pid: 5000 + s.next },
      labels,
      argv,
      ...(name === undefined ? {} : { name }),
    };
    return ok({ address, agent: base(argv[0] ?? "bash"), cwd, state: "live", turn: 0 });
  }
  if (verb === "ls") {
    const want = args.flatMap((a, i) => (a === "--label" && args[i + 1] !== undefined ? [args[i + 1] ?? ""] : []));
    const all = Object.entries(s.terminals).filter(([, t]) =>
      want.every((kv) => `${kv.split("=")[0]}=${t.labels[kv.split("=")[0] ?? ""] ?? "\u0000"}` === kv),
    );
    const shown = all.filter(([, t]) => t.state === "live" || args.includes("--all"));
    return ok({
      hidden_finished: all.length - shown.length,
      // As real hc (0.1.21): `agent` is the foreground program even for a silent shell, and `status` (the reported
      // state word) is there only once an agent has reported.
      terminals: shown.map(([address, t]) => ({
        address,
        agent: base(t.argv?.[0] ?? t.foreground?.name ?? "bash"),
        cwd: t.cwd ?? "/w",
        state: t.state,
        turn: t.turn,
        ...(t.status === null ? {} : { status: t.status.state }),
        ...(t.name === undefined ? {} : { name: t.name }),
      })),
    });
  }
  if (verb === "get" && k.getError !== undefined) return fail(k.getError, "get refused");
  if (verb === "read" && k.readError !== undefined) return fail(k.readError, "read refused");
  const t = id === undefined ? undefined : s.terminals[id];
  if (t === undefined || id === undefined) return fail("not_found", `no terminal "${id ?? ""}"`, "see `hc ls --all`");
  switch (verb) {
    case "get":
      return ok(getShape(id, t));
    case "read":
      return ok({ complete: true, how: "history", text: t.screen ?? "" });
    case "keys":
      return t.state === "finished" ? fail("finished", `${id} has finished`) : ok({ status: t.status?.state ?? null, turn: t.turn });
    case "send": {
      if (k.sendGarbled) return { code: 1, stderr: "connection reset" };
      if (k.sendError !== undefined) return fail(k.sendError, `send refused (${k.sendError})`, "nothing was typed");
      if (t.state === "finished") return fail("finished", `${id} has finished`);
      if (t.status?.state === "blocked" && !args.includes("--force")) return fail("blocked", `${id} is blocked`, "nothing was typed");
      const ifAt = args.indexOf("--if");
      const want = ifAt >= 0 ? args[ifAt + 1] : undefined;
      const now = t.status?.state ?? "silent";
      if (want !== undefined && now !== want) return fail("status_mismatch", `${id} is ${now}, not ${want}`, "nothing was typed");
      const text = args.at(-1) ?? "";
      s.sent.push({ id, text });
      const before = { started: t.status === null ? null : true, status: t.status?.state ?? null, turn: t.turn };
      if (k.agentReports && t.status === null) {
        t.status = { app: "omp", state: k.agentReportsAs ?? "idle" };
        t.foreground = { name: "omp", argv: ["/opt/omp/bin/omp"], pid: 7777 };
      }
      return ok(k.started === undefined ? before : { ...before, started: k.started });
    }
    case "kill":
      t.state = "finished";
      return ok(getShape(id, t));
    case "rm": {
      const left = k.liveAfterKill ?? 0;
      if (t.state === "live" || left > 0) {
        if (left > 0) k.liveAfterKill = left - 1;
        return fail("live", `${id} is still running`);
      }
      delete s.terminals[id];
      return ok({ removed: id });
    }
    default:
      return fail("usage", `unknown verb ${verb ?? ""}`);
  }
}

if (import.meta.main) {
  const dir = process.env["FAKE_HC_DIR"];
  if (!dir) {
    process.stderr.write("fake hc: FAKE_HC_DIR is not set\n");
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(argv)}\n`);
  const args = argv[0] === "--json" ? argv.slice(1) : argv;
  const statePath = join(dir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
  const out = answer(state, args);
  writeFileSync(statePath, JSON.stringify(state));
  if (out.stdout !== undefined) process.stdout.write(`${JSON.stringify(out.stdout)}\n`);
  if (out.stderr !== undefined) process.stderr.write(`${out.stderr}\n`);
  process.exit(out.code);
}
