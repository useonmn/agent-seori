import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "../src/channel.ts";
import { Refusal } from "../src/harness.ts";
import {
  publishWorklog, renderUntilStable, renderWorklog, WORKLOG_MARKER, worklogAdd, worklogClose, WorklogError, worklogItemLine,
  worklogLines, worklogList, worklogListOutput, worklogMarkdownPath, worklogNext, worklogNote, worklogPath, worklogRead,
} from "../src/worklog.ts";

const T0 = Date.UTC(2026, 10, 7, 9, 0, 0);
const roots: string[] = [];
const home = (): string => {
  const root = mkdtempSync(join(tmpdir(), "seori-worklog-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worklog", () => {
  test("add, next, note and close fold into one item and render worklog.md", () => {
    const root = home();
    const added = worklogAdd(root, "  Fix the login bug ", "telegram:42:7", T0);
    expect(added.id).toMatch(/^[0-9a-f]{8}$/);
    expect(added).toEqual({ id: added.id, title: "Fix the login bug", source: "telegram:42:7", openedAt: new Date(T0).toISOString(), notes: [] });
    worklogNext(root, added.id, "start lane login-fix", T0 + 1000);
    worklogNote(root, added.id, "owner wants it today", T0 + 2000);
    const next = worklogNext(root, added.id, "wait for READY", T0 + 3000);
    expect(next.next).toBe("wait for READY");
    expect(next.notes).toEqual([{ at: new Date(T0 + 2000).toISOString(), text: "owner wants it today" }]);

    const md = readFileSync(worklogMarkdownPath(root), "utf8");
    expect(md.split("\n")[0]).toBe(WORKLOG_MARKER);
    expect(md).toContain(`### ${added.id} Fix the login bug\n- Source: telegram:42:7\n- Opened: ${new Date(T0).toISOString()}\n- Next: wait for READY`);
    expect(md).toContain("## Closed\n\n(none)");

    const closed = worklogClose(root, added.id, "merged acme/web#12", T0 + 4000);
    expect(closed.closedAt).toBe(new Date(T0 + 4000).toISOString());
    expect(closed.result).toBe("merged acme/web#12");
    const after = readFileSync(worklogMarkdownPath(root), "utf8");
    expect(after).toContain("## Open\n\n(none)");
    expect(after).toContain("- Result: merged acme/web#12");
    expect(worklogList(root, { open: true }).items).toEqual([]);
    expect(worklogList(root).items).toEqual([closed]);
    expect(readFileSync(worklogPath(root), "utf8").trimEnd().split("\n")).toHaveLength(5);
  });

  test("refuses unknown and closed items, and text that is not one nonempty line", () => {
    const root = home();
    const item = worklogAdd(root, "Task", "slack:C1:1", T0);
    expect(() => worklogNote(root, "deadbeef", "x", T0)).toThrow("worklog item not found: deadbeef");
    for (const bad of ["two\nlines", "tab\tinside", "   ", "nel\u0085x", "sep\u2028x"]) {
      expect(() => worklogNote(root, item.id, bad, T0)).toThrow(WorklogError);
    }
    expect(() => worklogAdd(root, "x".repeat(201), "s", T0)).toThrow('"title" must be one nonempty line of at most 200 characters');
    worklogClose(root, item.id, "done", T0);
    expect(() => worklogNext(root, item.id, "more", T0)).toThrow(`worklog item ${item.id} is closed: done`);
    expect(() => worklogClose(root, item.id, "again", T0)).toThrow(Refusal);
    // Refused changes appended nothing.
    expect(readFileSync(worklogPath(root), "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  test("ids are distinct 8-hex values", () => {
    const root = home();
    const ids = new Set(Array.from({ length: 20 }, (_, i) => worklogAdd(root, `t${i}`, "s", T0).id));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("a damaged line is named and skipped; a torn line is skipped quietly and the next write starts a fresh line", () => {
    const root = home();
    const item = worklogAdd(root, "Keep me", "s", T0);
    appendFileSync(worklogPath(root), 'garbage that is not json\n{"op":"add","id":"zz","at":"x","title":"t","source":"s"}\n{"op":"note","id":"');
    const read = worklogRead(root);
    expect(read.items.map((i) => i.id)).toEqual([item.id]);
    expect(read.problems).toHaveLength(2);
    expect(read.problems[0]).toStartWith(`${worklogPath(root)}:2: `);
    expect(read.problems[1]).toBe(`${worklogPath(root)}:3: worklog field "id" must be 8 lowercase hex digits`);

    const noted = worklogNote(root, item.id, "after the torn write", T0 + 1);
    expect(noted.notes.map((n) => n.text)).toEqual(["after the torn write"]);
    const lines = readFileSync(worklogPath(root), "utf8").split("\n");
    expect(lines[3]).toBe('{"op":"note","id":"');
    expect(JSON.parse(lines[4]!)).toMatchObject({ op: "note", id: item.id });
    expect(worklogRead(root).problems).toHaveLength(2);
  });

  test("racing writers: the first close wins, a later close is silent, a later note is a warning", () => {
    const root = home();
    const item = worklogAdd(root, "Race", "s", T0);
    const at = new Date(T0 + 5).toISOString();
    appendFileSync(worklogPath(root), [
      JSON.stringify({ op: "close", id: item.id, at, result: "first" }),
      JSON.stringify({ op: "close", id: item.id, at, result: "second" }),
      JSON.stringify({ op: "note", id: item.id, at, text: "late" }),
    ].join("\n") + "\n");
    const read = worklogRead(root);
    expect(read.items[0]!.result).toBe("first");
    expect(read.problems).toEqual([]);
    expect(read.warnings).toEqual([`${worklogPath(root)}:4: worklog item ${item.id} was already closed; note ignored`]);
    expect(worklogListOutput(read).stderr).toEqual([`WORKLOG_WARNING ${read.warnings[0]}`]);
  });

  test("a worklog.md seori did not write is never replaced, and the record stays unchanged", () => {
    const root = home();
    writeFileSync(worklogMarkdownPath(root), "# my own notes\n");
    expect(() => worklogAdd(root, "Task", "s", T0)).toThrow("was not written by seori worklog; move it aside");
    expect(existsSync(worklogPath(root))).toBe(false);
    expect(readFileSync(worklogMarkdownPath(root), "utf8")).toBe("# my own notes\n");
  });

  test("publishWorklog keeps a file someone wrote between the temp write and the rename", () => {
    const root = home();
    const path = worklogMarkdownPath(root);
    expect(publishWorklog(path, renderWorklog([]), () => writeFileSync(path, "mine\n"))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("mine\n");
  });

  test("renderUntilStable publishes again while the record grew during a publish", () => {
    let record = Buffer.from("a\n");
    const published: string[] = [];
    const text = renderUntilStable(
      () => record,
      (r) => {
        published.push(r);
        if (published.length === 1) record = Buffer.from("a\nb\n");
      },
      () => record.length,
    );
    expect(published).toEqual(["a\n", "a\nb\n"]);
    expect(text).toBe("a\nb\n");
  });

  test("formatters: item line, list output, boot lines", () => {
    const root = home();
    const a = worklogAdd(root, 'Say "hi"', "telegram:1:2", T0);
    const b = worklogAdd(root, "Other", "slack:C:3", T0);
    worklogNext(root, a.id, "reply", T0);
    worklogClose(root, b.id, "dropped", T0);
    const read = worklogList(root);
    expect(worklogItemLine(read.items[0]!)).toBe(JSON.stringify(read.items[0]));
    expect(JSON.parse(worklogListOutput(read).stdout)).toEqual(read.items);
    expect(worklogLines(read.items)).toEqual([
      "WORKLOG open=1",
      `OPEN ${a.id} "Say \\"hi\\"" source="telegram:1:2" next="reply"`,
    ]);
  });

  test("a message from someone other than the owner creates no worklog item", () => {
    const root = home();
    const channel = new Channel(root);
    channel.appendInbound({ id: "fake:c:1", kind: "messenger", source: "fake", chat: "c", from: "u2", sender: { kind: "person", id: "u2" }, at: T0, text: "do my thing" });
    channel.appendInbound({ id: "fake:c:2", kind: "messenger", source: "fake", chat: "c", from: "u1", sender: { kind: "owner", id: "u1" }, at: T0, text: "do it" });
    expect(() => worklogAdd(root, "their thing", "fake:c:1", T0)).toThrow(WorklogError);
    expect(worklogRead(root).items).toEqual([]);
    expect(worklogAdd(root, "owner thing", "fake:c:2", T0).source).toBe("fake:c:2");
    expect(worklogAdd(root, "from the pane", "pane", T0).source).toBe("pane");
    channel.appendInbound({ id: "fake:c:3", kind: "messenger", source: "fake", chat: "c", from: "u3", sender: { kind: "trusted", id: "u3" }, at: T0, text: "fix it" });
    expect(worklogAdd(root, "trusted thing", "fake:c:3", T0).source).toBe("fake:c:3");
  });
});
