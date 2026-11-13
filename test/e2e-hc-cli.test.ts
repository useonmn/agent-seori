// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNIT_KINDS, unitName } from "../src/systemd.ts";
import {
  enabled,
  fixture,
  hc,
  newHome,
  screen,
  seori,
  startCore,
  statusOf,
  stopCore,
  systemctlLog,
  terminal,
  unitDir,
  until,
  waitStatus,
} from "./e2e-hc-setup.ts";

// The seori CLI against real hc (herdr-core) on one isolated core, only with SEORI_E2E_HC=1, with a fake omp that
// reports OSC 7501 as omp does: lanes (start, send, a queued send, ready, done) and `seori up` / `seori down` with a
// fake systemctl. One lane home is shared by the lane scenarios, which run in file order.
const laneHome = enabled ? newHome("lanes") : "";
let lane = "";

const addressOf = (line: string, key: string): string => {
  const ref = new RegExp(`${key} pane=hc:(\\S+)`).exec(line)?.[1];
  if (ref === undefined) throw new Error(`no hc ref in: ${line}`);
  return ref;
};
const rows = (r: Record<string, unknown>) => (r["terminals"] ?? []) as Record<string, unknown>[];
const fgArgv = (t: Record<string, unknown>) => (t["foreground"] as { argv?: string[] } | undefined)?.argv ?? [];

beforeAll(async () => {
  if (enabled) await startCore();
});

afterAll(async () => {
  if (!enabled) return;
  const stopped = await stopCore();
  expect(stopped.pid).toBeNumber();
  expect(stopped.alive).toBe(false);
  expect(stopped.sockets).toEqual([]);
});

test.skipIf(!enabled)(
  "seori start opens a lane whose agent is idle once the fixture reports, and the kickoff reached it",
  async () => {
    const brief = join(laneHome, "brief.md");
    writeFileSync(brief, "E2E-HC-BRIEF\n");
    // --force: the free-disk/memory guard is not under test, and CI runners and dev boxes often sit below its floor.
    const started = await seori(laneHome, "start", "e2e-k", "--brief", brief, "--cwd", laneHome, "--force");
    lane = addressOf(started, "STARTED e2e-k");
    const t = await until("the lane to report idle with the fixture in front", async () => {
      const got = await terminal(lane);
      return got["reported"] === true && statusOf(got) === "idle" && fgArgv(got).includes(fixture) ? got : undefined;
    });
    expect((t["status"] as Record<string, unknown>)["app"]).toBe("omp");
    expect((t["labels"] as Record<string, string>)["seori.lane"]).toBe("e2e-k");
    const text = await screen(lane);
    expect(text).toContain(`echo: /goal Read your brief at ${join(laneHome, "briefs", "e2e-k.md")} and execute it.`);
    expect(await seori(laneHome, "status")).toMatch(new RegExp(`^e2e-k\\s+working\\s+hc:${lane}\\s`, "m"));
  },
  60_000,
);

test.skipIf(!enabled)(
  "seori send delivers to the idle lane and the fixture echoes it",
  async () => {
    expect(await seori(laneHome, "send", "e2e-k", "--text", "hi")).toContain("DELIVERED e2e-k");
    await until("the echo of hi", async () => ((await screen(lane)).includes("echo: hi") ? true : undefined));
    await waitStatus(lane, "idle");
  },
  60_000,
);

test.skipIf(!enabled)(
  "a terminal that never reports is not an agent: send queues and nothing is typed into it",
  async () => {
    const plain = String((await hc("run", "--bg", "--no-parent", "--no-notify", "--name", "plain", "--", "sh"))["address"]);
    const t = await until("the plain shell in front", async () => {
      const got = await terminal(plain);
      return got["foreground"] ? got : undefined;
    });
    expect(t["reported"]).toBe(false);
    expect(t["status"]).toBeNull();
    expect(await seori(laneHome, "send", `hc:${plain}`, "--text", "QUEUED-E2E")).toContain(`QUEUED hc:${plain}`);
    const inbox = join(laneHome, "inbox");
    const files = readdirSync(inbox).filter((f) => f.endsWith(`${plain}.jsonl`));
    expect(files).toHaveLength(1);
    const entries = readFileSync(join(inbox, files[0] ?? ""), "utf8").split("\n").filter(Boolean);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("QUEUED-E2E");
    expect(await seori(laneHome, "inbox", "list", `hc:${plain}`)).toMatch(/^1 queued from cli /m);
    expect(await screen(plain)).not.toContain("QUEUED-E2E");
    await hc("kill", plain);
    await hc("rm", plain);
  },
  60_000,
);

test.skipIf(!enabled)(
  "seori ready then done kills and removes the lane's terminal",
  async () => {
    const evidence = `file://${join(laneHome, "brief.md")}`;
    expect(await seori(laneHome, "ready", "e2e-k", "--text", "e2e-hc finished", "--evidence", evidence)).toContain("READY e2e-k");
    expect(await seori(laneHome, "done", "e2e-k")).toContain("DONE e2e-k");
    const left = rows(await hc("ls", "--all")).find((t) => t["address"] === lane);
    expect(left === undefined || left["state"] === "finished").toBe(true);
    expect(await seori(laneHome, "status")).toMatch(new RegExp(`^e2e-k\\s+done\\s+hc:${lane}\\s`, "m"));
  },
  60_000,
);

test.skipIf(!enabled)(
  "seori up opens lead and duty in one seori.group and starts the units; a second up opens nothing; down closes all",
  async () => {
    const home = newHome("up");
    const name = `e2eup${process.pid}`;
    writeFileSync(join(home, "config.json"), JSON.stringify({ name }));
    const up = await seori(home, "up");
    const m = /^UP lead=hc:(\S+) duty=hc:(\S+) units=(\S+) home=(\S+) name=(\S+)$/m.exec(up);
    expect(m).not.toBeNull();
    const [, lead = "", duty = "", units = ""] = m ?? [];
    const unitNames = UNIT_KINDS.map((kind) => unitName(name, home, kind));
    expect(units).toBe(unitNames.join(","));
    expect(readdirSync(unitDir).sort()).toEqual([...unitNames].sort());

    const listed = rows(await hc("ls", "--label", `seori.group=${name}`)).map((t) => String(t["address"])).sort();
    expect(listed).toEqual([lead, duty].sort());
    for (const [id, role] of [[lead, "lead"], [duty, "duty"]] as const) {
      const t = await terminal(id);
      expect((t["labels"] as Record<string, string>)["seori.role"]).toBe(role);
      expect((t["status"] as Record<string, unknown>)["app"]).toBe("omp");
      expect(t["cwd"]).toBe(home);
      await waitStatus(id, "idle");
    }
    const status = await seori(home, "status");
    expect(status).toContain(`hc:${lead}`);

    const ctl = () => readFileSync(systemctlLog, "utf8").split("\n").filter(Boolean);
    expect(ctl()).toEqual([
      "--user show-environment",
      "--user daemon-reload",
      `--user enable --now ${unitNames[0]}`,
      `--user enable --now ${unitNames[1]} ${unitNames[2]}`,
    ]);

    expect(await seori(home, "up")).toMatch(/^ALREADY UP name=/m);
    expect(rows(await hc("ls", "--label", `seori.group=${name}`))).toHaveLength(2);

    const down = await seori(home, "down");
    expect(down).toContain(`CLOSED hc:${lead}`);
    expect(down).toContain(`CLOSED hc:${duty}`);
    // stop, then disable (each tolerant of a unit that is already gone), then a reload
    expect(ctl().slice(4)).toEqual([`--user stop ${unitNames.join(" ")}`, `--user disable ${unitNames.join(" ")}`, "--user daemon-reload"]);
    expect(readdirSync(unitDir)).toEqual([]);
    expect(rows(await hc("ls", "--label", `seori.group=${name}`))).toEqual([]);
  },
  120_000,
);
