import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../src/runtime/exec.ts";
import { Store } from "../src/store.ts";
import { enabled, OmpRig, until } from "./e2e-hc-omp.ts";

// REAL omp lanes on an isolated hc core (model calls, costs money): opt-in with SEORI_E2E_HC=1 SEORI_E2E_OMP=1, see
// e2e-hc-omp.ts. e2e-hc-cli.test.ts drives the same commands with a fake omp; here a real omp reads its brief and runs
// seori itself, and the hourly loop starts a backlog item. The lead is `cat`, a program that never reports a status
// over OSC 7501: messages for it must stay in its inbox and never be typed into it.
const rig = enabled ? new OmpRig("ln") : undefined;
const home = rig?.home ?? "";
const LANE_MS = 180_000;
const TEST_MS = 300_000;

const r = () => rig!;
const seori = (argv: string[]) => r().seori(argv);
/** The lead's inbox file, by the name seori gives it. */
const leadInbox = (lead: string) => {
  const file = new Store(home).inboxPath({ runtime: "hc", id: lead });
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const leadScreen = async (lead: string) => String((await r().hc("read", lead, "--lines", "80"))["text"] ?? "");
const waitInbox = (lead: string, needle: string) =>
  until(`${needle} in the lead inbox`, () => {
    const text = leadInbox(lead);
    return text.includes(needle) ? text : undefined;
  }, LANE_MS);
// A brief a small model follows literally: two seori calls, nothing else.
const writeBrief = (path: string, key: string) =>
  writeFileSync(path, [
    "You are an end-to-end test lane. Run exactly these two shell commands, in this order, and do nothing else:",
    "",
    `1. ${r().seoriCmd} report ${key} --text 'read brief'`,
    `2. ${r().seoriCmd} ready ${key} --text 'e2e lane finished' --evidence ${shq(`file://${path}`)}`,
    "",
    "Do not edit files, do not run any other command. After the second command succeeds, stop.",
    "",
  ].join("\n"));
/** A terminal running `cat`, recorded as the lead. */
const leadTerminal = async (name: string) => {
  const lead = String((await r().hc("run", "--bg", "--no-parent", "--no-notify", "--name", name, "--cwd", home, "--", "cat"))["address"]);
  await seori(["role", "lead", `hc:${lead}`]);
  return lead;
};
// After READY the lane's omp still finishes its turn (and its goal). `seori done` refuses a working lane, so wait for
// omp to report it idle. A lane that never goes idle here means goal mode kept it going after READY.
const waitLaneIdle = (key: string) =>
  until(`lane ${key} idle`, async () => {
    const lane = JSON.parse(readFileSync(join(home, "lanes", `${key}.json`), "utf8")) as { sessionRef: { id: string } };
    return (await r().settled(lane.sessionRef.id)) ? true : undefined;
  }, LANE_MS, 1000);

beforeAll(async () => {
  if (enabled) await r().startCore();
}, 60_000);

afterAll(async () => {
  if (!rig) return;
  const stopped = await rig.stop();
  rig.log(`cleanup: core pid ${stopped.pid} alive=${stopped.alive}, sockets ${JSON.stringify(stopped.sockets)}, leftovers ${JSON.stringify(stopped.leftovers)}`);
  expect(stopped.alive).toBe(false);
  expect(stopped.sockets).toEqual([]);
  expect(stopped.leftovers).toEqual([]);
}, 120_000);

test.skipIf(!enabled)("a real omp lane reports and finishes; the lead terminal has no agent, so both wait in its inbox", async () => {
  const lead = await leadTerminal("e2e-lead");
  const brief = join(home, "brief.md");
  writeBrief(brief, "e2e-lane");

  // --force: the free-disk/memory guard is not under test.
  await seori(["start", "e2e-lane", "--brief", brief, "--cwd", home, "--force"]);

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
  const lead = await leadTerminal("e2e-loop-lead");
  const brief = join(home, "loop-brief.md");
  writeBrief(brief, "loop-item");
  expect(await seori(["backlog", "add", "loop-item", "--brief", brief, "--cwd", home, "--priority", "2"])).toContain("ADDED loop-item p2");

  const once = await seori(["loop", "--once", "--force", "--max-lanes", "5", "--max-load", "100000"]);
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
  expect(await seori(["loop", "--once", "--force"])).toContain("LOOP skipped: stopped: e2e pause");
  expect(readdirSync(join(home, "lanes")).sort()).toEqual(lanesBefore);
  await waitLaneIdle("loop-item");
  expect(await seori(["done", "loop-item"])).toContain("DONE loop-item");
}, TEST_MS);
