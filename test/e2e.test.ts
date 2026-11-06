import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shq, spawnExec } from "../src/herdr.ts";

// Real herdr in an isolated named session and a REAL omp lane (model calls, costs money): opt-in with SEORI_E2E_OMP=1.
// Needs herdr's omp integration installed (`herdr integration install omp`); seori refuses to start lanes without it.
const herdrBin = Bun.which("herdr");
const enabled = !!herdrBin && process.env["SEORI_E2E_OMP"] === "1";
const session = `seori-e2e-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), "seori-e2e-"));
const cli = resolve(import.meta.dir, "../src/cli.ts");
const model = process.env["SEORI_E2E_MODEL"] ?? "anthropic/claude-haiku-5-5";
// The lane's omp runs in a herdr pane and does not inherit this process's env: its seori command carries home and session.
const seoriCmd = `SEORI_HOME=${shq(home)} SEORI_HERDR_SESSION=${session} bun ${shq(cli)}`;
const env = { ...process.env, SEORI_HOME: home, SEORI_HERDR_SESSION: session, SEORI_MODEL: model, SEORI_CMD: seoriCmd };
const LANE_MS = 180_000;
const TEST_MS = 300_000;
let server: ReturnType<typeof Bun.spawn> | undefined;

const herdr = async (...argv: string[]) => {
  const r = await spawnExec("herdr", ["--session", session, ...argv]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout || "{}").result;
};
const seori = async (argv: string[], extra: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", cli, ...argv], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`seori ${argv.join(" ")} -> ${code}: ${err}`);
  return out;
};
const until = async <T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
};
// The lead here is `cat`, which herdr does not recognise as an agent: a bare shell pane. Messages for it must stay in its
// inbox and never be typed into it (#66).
const leadInbox = (lead: string) => Bun.file(join(home, "inbox", `${lead.replaceAll(":", "_")}.jsonl`)).text();
const leadScreen = async (lead: string) =>
  (await spawnExec("herdr", ["--session", session, "pane", "read", lead, "--lines", "80", "--source", "recent"])).stdout;
const waitInbox = (lead: string, needle: string) =>
  until(`${needle} in the lead inbox`, async () => {
    const text = await leadInbox(lead);
    return text.includes(needle) ? text : undefined;
  }, LANE_MS);
// A brief a small model follows literally: two seori calls, nothing else.
const writeBrief = (path: string, key: string) =>
  writeFileSync(path, [
    "You are an end-to-end test lane. Run exactly these two shell commands, in this order, and do nothing else:",
    "",
    `1. ${seoriCmd} report ${key} --text 'read brief'`,
    `2. ${seoriCmd} ready ${key} --text 'e2e lane finished' --evidence ${shq(`file://${path}`)}`,
    "",
    "Do not edit files, do not run any other command. After the second command succeeds, stop.",
    "",
  ].join("\n"));
const leadPane = async (label: string) => {
  const ws = await herdr("workspace", "create", "--label", label, "--cwd", home, "--no-focus");
  const lead = ws.root_pane.pane_id as string;
  await herdr("pane", "run", lead, "cat");
  await seori(["role", "lead", lead]);
  return { lead, workspace: ws.workspace.workspace_id as string };
};
// After READY the lane's omp still finishes its turn (and its goal). `seori done` refuses a working pane, so wait for the
// integration to report it idle. A lane that never goes idle here means goal mode kept it going after READY.
const waitLaneIdle = (key: string) =>
  until(`lane ${key} idle`, async () => {
    const lane = JSON.parse(await Bun.file(join(home, "lanes", `${key}.json`)).text()) as { paneId: string };
    const pane = (await herdr("pane", "get", lane.paneId)).pane as { agent_status?: string };
    return pane.agent_status === "idle" || pane.agent_status === "done" ? true : undefined;
  }, LANE_MS);

beforeAll(async () => {
  if (!enabled) return;
  server = Bun.spawn([herdrBin!, "--session", session, "server"], { stdout: "ignore", stderr: "ignore" });
  await until("herdr server", () => herdr("workspace", "list"));
});

afterAll(async () => {
  if (!enabled) return;
  await spawnExec("herdr", ["--session", session, "server", "stop"]);
  await server?.exited;
  await spawnExec("herdr", ["session", "delete", session]);
});

test.skipIf(!enabled)("a real omp lane started in real herdr reports and finishes; the lead pane has no agent, so both wait in its inbox", async () => {
  const { lead, workspace } = await leadPane("e2e");
  const brief = join(home, "brief.md");
  writeBrief(brief, "e2e-lane");

  await seori(["start", "e2e-lane", "--brief", brief, "--workspace", workspace, "--cwd", home]);

  const leadText = await waitInbox(lead, "[READY e2e-lane]");
  expect(await leadScreen(lead)).not.toContain("e2e-lane");
  expect(leadText).toContain("[START e2e-lane]");
  expect(leadText).toContain("[REPORT e2e-lane] read brief");
  expect(leadText).toContain("[READY e2e-lane] e2e lane finished");
  expect(await seori(["status"])).toMatch(/e2e-lane\s+ready/);
  await waitLaneIdle("e2e-lane");
  expect(await seori(["done", "e2e-lane"])).toContain("DONE e2e-lane");
}, TEST_MS);

test.skipIf(!enabled)("the hourly loop starts a backlog item as a real omp lane and reports the run to the lead", async () => {
  const { lead, workspace } = await leadPane("e2e-loop");
  const brief = join(home, "loop-brief.md");
  writeBrief(brief, "loop-item");
  expect(await seori(["backlog", "add", "loop-item", "--brief", brief, "--cwd", home, "--priority", "2"])).toContain("ADDED loop-item p2");

  const once = await seori(["loop", "--once", "--force", "--max-lanes", "5", "--max-load", "100000"], { HERDR_WORKSPACE_ID: workspace });
  expect(once).toContain("LOOP started=1");

  const leadText = await waitInbox(lead, "[READY loop-item]");
  expect(await leadScreen(lead)).not.toContain("loop-item");
  expect(leadText).toContain("[START loop-item]");
  expect(leadText).toContain("[LOOP ");
  expect(leadText).toContain("started: loop-item (p2)");
  expect(await seori(["backlog", "list"])).toMatch(/loop-item\s+running/);
  expect(await seori(["loop", "status"])).toContain("started: loop-item (p2)");

  expect(await seori(["loop", "stop", "--text", "e2e pause"])).toContain("LOOP STOPPED");
  const lanesBefore = readdirSync(join(home, "lanes")).sort();
  expect(await seori(["loop", "--once", "--force"], { HERDR_WORKSPACE_ID: workspace })).toContain("LOOP skipped: stopped: e2e pause");
  expect(readdirSync(join(home, "lanes")).sort()).toEqual(lanesBefore);
  await waitLaneIdle("loop-item");
  expect(await seori(["done", "loop-item"])).toContain("DONE loop-item");
}, TEST_MS);
