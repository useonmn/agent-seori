// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameSession } from "./refs.ts";
import type { RuntimeKind, SessionRef } from "./runtime/types.ts";
import { lockFile } from "./store.ts";

/**
 * The durable record of one `seori migrate` of a lane or role (`SEORI_HOME/migrate/<name>.json`), rewritten tmp+rename
 * before each phase so a cut-short run resumes where it stopped. `hold`: the session is held (no flush, no nudge);
 * `creating`: the replacement `newRef` exists but omp may not be started in it yet (a resumed run closes it and opens
 * again); `opened`: the replacement `newRef` is up; `switched`: the record points at it and only the old close is left.
 */
export type MigrateJournal = {
  readonly name: string;
  readonly kind: "lane" | "role";
  readonly phase: "hold" | "creating" | "opened" | "switched";
  readonly from: SessionRef;
  readonly to: RuntimeKind;
  readonly newRef?: SessionRef;
  readonly at: number;
  readonly briefPath?: string;
  /** omp's session file the replacement resumes (`seori migrate --resume`), instead of a kickoff on the handoff brief. */
  readonly resume?: string;
};

const dir = (root: string): string => join(root, "migrate");
const pathOf = (root: string, name: string): string => join(dir(root), `${name}.json`);
export const journalPath = pathOf;

/** A journal file that does not parse: it names the file, which only an owner can judge (inspect or delete). */
export class JournalUnreadable extends Error {}

export function readJournal(root: string, name: string): MigrateJournal | undefined {
  const path = pathOf(root, name);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MigrateJournal;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new JournalUnreadable(`migration journal ${path} is unreadable (${e.message}); inspect it, or delete it if no seori migrate of ${name} is running`);
  }
}

export function writeJournal(root: string, journal: MigrateJournal): void {
  mkdirSync(dir(root), { recursive: true });
  const path = pathOf(root, journal.name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The first journal of a run, written to a temp file and hard-linked into place: a second migration that raced to the
 * same name is refused (EEXIST), and a crash mid-write never leaves a partial journal under the real name.
 */
export function createJournal(root: string, journal: MigrateJournal): boolean {
  mkdirSync(dir(root), { recursive: true });
  const path = pathOf(root, journal.name);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`);
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export const removeJournal = (root: string, name: string): void => rmSync(pathOf(root, name), { force: true });

/** One live run per name, with the inbox lock's rules (a dead holder on this host frees it). Undefined while held. */
export function lockMigration(root: string, name: string, now: number): (() => void) | undefined {
  mkdirSync(dir(root), { recursive: true });
  return lockFile(join(dir(root), `${name}.lock`), now);
}

/** True while a migration journal names `ref` as its source or its replacement: its inbox is held, not flushed. */
export function migrating(root: string, ref: SessionRef): boolean {
  if (!existsSync(dir(root))) return false;
  return readdirSync(dir(root))
    .filter((f) => f.endsWith(".json"))
    .some((f) => {
      // An unreadable journal names no session we can tell: it must not stop every other inbox from flushing.
      let j: MigrateJournal | undefined;
      try {
        j = readJournal(root, f.slice(0, -".json".length));
      } catch (e) {
        if (!(e instanceof JournalUnreadable)) throw e;
        return false;
      }
      return j !== undefined && (sameSession(j.from, ref) || (j.newRef !== undefined && sameSession(j.newRef, ref)));
    });
}
