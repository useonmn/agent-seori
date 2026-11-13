// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envExec, HcError, hcCall } from "../src/runtime/hc/exec.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import type { SessionRef } from "../src/runtime/types.ts";

// The hc adapter against real hc (herdr-core) on ONE isolated core, only with SEORI_E2E_HC=1. The core is chosen by
// env alone: the caller's HC_TERMINAL_SOCKET / HC_TERMINAL_ID / HC_SCOPE / HC_SOCKET are dropped, XDG_RUNTIME_DIR is a
// short private temp dir and HC_SESSION a short name, so the socket is <tmp>/r/herdr-core/<session>.sock and the
// host's default core is never addressed. `hc server stop` is the last hc call: any later hc call would start a core.
const enabled = process.env["SEORI_E2E_HC"] === "1" && Bun.which("hc") !== null;

const root = enabled ? mkdtempSync("/tmp/shc-") : "";
const run = join(root, "r");
const config = join(root, "c");
const session = `s${process.pid}`;
const {
  HC_TERMINAL_SOCKET: _sock,
  HC_TERMINAL_ID: _id,
  HC_SCOPE: _scope,
  HC_SOCKET: _hcSock,
  HC_SESSION: _session,
  ...outer
} = process.env;
const env = {
  ...outer,
  HC_SESSION: session,
  XDG_RUNTIME_DIR: run,
  XDG_CONFIG_HOME: config,
  XDG_STATE_HOME: join(root, "s"),
  SHELL: "/bin/bash",
};
const exec = envExec(env);
const hc = (...argv: string[]) => hcCall(exec, argv);
const rt = new HcRuntime(exec, { env });
const group = `e2e${process.pid}`;
const socket = join(run, "herdr-core", `${session}.sock`);
let corePid: number | undefined;
let ref: SessionRef | undefined;

const log = (line: string) => void process.stdout.write(`[e2e-hc] ${line}\n`);

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  if (!enabled) return;
  for (const dir of [run, join(config, "herdr-core"), join(root, "s")]) mkdirSync(dir, { recursive: true });
  chmodSync(run, 0o700);
  writeFileSync(join(config, "herdr-core", "config.toml"), "notes = false\n");
  for (const k of ["HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE", "HC_SOCKET"]) expect(k in env).toBe(false);
  await hc("server", "start");
  const status = await hc("server", "status");
  corePid = Number(status["pid"]);
  log(`isolated core pid=${corePid} socket=${socket} exists=${existsSync(socket)}`);
  expect(existsSync(socket)).toBe(true);
});

afterAll(async () => {
  if (!enabled) return;
  try {
    for (const t of ((await hc("ls", "--all"))["terminals"] ?? []) as { address: string }[]) {
      await hc("kill", t.address).catch(() => undefined);
      await hc("rm", t.address).catch(() => undefined);
    }
    const left = await hc("ls", "--all");
    log(`before stop: ls --all = ${JSON.stringify(left)}`);
  } finally {
    // The last hc call of this file.
    const stopped = await hc("server", "stop");
    log(`server stop: ${JSON.stringify(stopped)}`);
  }
  const pid = corePid;
  if (pid !== undefined) await until("the isolated core to exit", async () => (alive(pid) ? undefined : true), 10_000);
  const sockets = existsSync(join(run, "herdr-core")) ? readdirSync(join(run, "herdr-core")) : [];
  log(`after stop: pid ${pid} alive=${pid !== undefined && alive(pid)}, runtime dir entries=${JSON.stringify(sockets)}`);
  rmSync(root, { recursive: true, force: true });
  expect(pid !== undefined && alive(pid)).toBe(false);
  expect(sockets).toEqual([]);
});

test.skipIf(!enabled)(
  "create, list, probe, read, deliver and close one bash terminal in seori.group=<test>",
  async () => {
    ref = await rt.create({ name: "e2e lane", cwd: root, env: { FOO: "1" }, role: "lane", container: "tab", group });
    log(`created ${JSON.stringify(ref)}`);
    expect(ref.runtime).toBe("hc");
    expect(ref.group).toBe(group);
    const id = ref.id;
    expect(id).toMatch(/^t[0-9a-z]+$/);

    const got = await hc("get", id);
    expect(got["labels"]).toMatchObject({ "seori.group": group, "seori.role": "lane", "seori.lane": "e2e lane" });
    expect(got["argv"]).toEqual(["env", "FOO=1", "/bin/bash"]);
    expect(got["notify"]).toBe(false);
    expect(got["status"]).toBeNull();

    const listed = await rt.list({ group });
    log(`list: ${JSON.stringify(listed)}`);
    expect(listed.map((s) => s.ref.id)).toEqual([id]);
    expect(await rt.list({ group: `${group}-none` })).toEqual([]);
    expect(await rt.groups()).toContainEqual({ id: group, label: group });

    const probe = await until("bash in front", async () => {
      const p = await rt.probe(ref as SessionRef);
      return p.foreground?.[0]?.name === "bash" ? p : undefined;
    });
    log(`probe: ${JSON.stringify(probe)}`);
    expect(probe).toMatchObject({ status: "shell", shellInFront: true, agent: "bash" });
    expect(await rt.status(ref)).toBe("shell");

    // A shell is silent: the adapter types nothing into it, and hc itself refuses `--if idle` with rc 10.
    expect(await rt.deliver(ref, "echo DELIVER-E2E")).toEqual({ kind: "no-agent" });
    expect(await rt.deliver(ref, "echo DELIVER-E2E", { when: "any" })).toEqual({ kind: "no-agent" });
    const refused = await hc("send", id, "--if", "idle", "--", "echo MISMATCH-E2E").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HcError);
    expect(refused).toMatchObject({ kind: "status_mismatch", result: { code: 10 } });
    log(`send --if idle into a shell: ${(refused as HcError).message}`);

    expect(await rt.typeIntoShell(ref, "echo FOO=$FOO typed-e2e")).toBe(true);
    const screen = await until("the shell's echo", async () => {
      const text = await rt.read(ref as SessionRef, 20);
      return text.includes("FOO=1 typed-e2e") ? text : undefined;
    });
    expect(screen).not.toContain("DELIVER-E2E");
    expect(screen).not.toContain("MISMATCH-E2E");
    log("read: the shell echoed FOO=1 typed-e2e; nothing from the refused sends was typed");

    await rt.close(ref);
    expect(await rt.probe(ref)).toEqual({ status: "gone", shellInFront: false });
    expect(await rt.list({ group })).toEqual([]);
    expect((await hc("ls", "--all"))["terminals"]).toEqual([]);
    await rt.close(ref);
    log(`closed ${id}: gone, ls --all empty, a second close is a no-op`);
  },
  60_000,
);
