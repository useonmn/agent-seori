// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
import type { Deps } from "./harness.ts";
import { POLL_MS, type MigrateOpts, type Subject } from "./migrate-capture.ts";
import { drainForward, moveBack, moveInbox } from "./migrate-inbox.ts";
import { journalPath, type MigrateJournal, removeJournal, writeJournal } from "./migrate-journal.ts";
import { refText } from "./refs.ts";
import { formatRef, type SessionRef } from "./runtime/types.ts";

export const VERIFY_MS = 3 * 60_000;

/** Step (5): the new session's status reaches idle or working within VERIFY_MS, polled every POLL_MS. */
async function verify(d: Deps, ref: SessionRef): Promise<string | undefined> {
  const rt = d.runtimes.for(ref);
  const deadline = d.now() + VERIFY_MS;
  for (;;) {
    const status = await rt.status(ref);
    if (status === "idle" || status === "working") return undefined;
    if (d.now() >= deadline) return `never reached idle or working within 3 min (last: ${status})`;
    await d.sleep(POLL_MS);
  }
}

async function closeQuietly(d: Deps, ref: SessionRef): Promise<void> {
  const rt = d.runtimes.for(ref);
  if ((await rt.status(ref).catch(() => undefined)) === "gone") return;
  await rt.close(ref);
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e)).trim().split("\n")[0] ?? "";

/**
 * Rollback: the replacement (if any) closed, the inbox put back, the record pointed back at the old session (a run
 * resumed after the switch), the journal removed, the hold lifted; exit 3.
 */
async function rollback(d: Deps, s: Subject, j: MigrateJournal, newRef: SessionRef | undefined, reason: string, opts: MigrateOpts) {
  let leftOpen = "";
  if (newRef !== undefined) {
    // Once the journal is gone nothing names the replacement: a close that failed is reported, not dropped.
    await closeQuietly(d, newRef).catch((e: unknown) => void (leftOpen = `; replacement ${formatRef(newRef)} NOT closed: ${why(e)}`));
    await moveBack(d, j.from, newRef);
    s.switchBack(j.from, newRef);
  }
  removeJournal(d.store.root, s.name);
  s.setHold(false);
  opts.log(`MIGRATE_ROLLBACK ${s.name} ${newRef === undefined ? `${j.to}:-` : formatRef(newRef)} ${reason}${leftOpen}`);
  return 3;
}

/**
 * Steps (4)-(8) for an agent session, resuming at the journal's phase: open the replacement on the target (the
 * journal records it before anything else moves), verify it (rollback on failure), move the inbox, switch the record,
 * close the old one, drain what late senders appended to the old inbox.
 */
export async function swapAgent(d: Deps, s: Subject, j: MigrateJournal, opts: MigrateOpts): Promise<number> {
  if (j.phase === "hold") {
    let opened: SessionRef;
    try {
      opened = await s.open(d.runtimes.for({ runtime: j.to, id: "" }), j.briefPath ?? "", j.resume);
    } catch (e) {
      return rollback(d, s, j, undefined, `did not open: ${why(e)}`, opts);
    }
    j = { ...j, phase: "opened", newRef: opened };
    writeJournal(d.store.root, j);
  }
  const newRef = j.newRef as SessionRef;
  if (j.phase === "opened") {
    const failed = await verify(d, newRef);
    if (failed !== undefined) return rollback(d, s, j, newRef, failed, opts);
    await moveInbox(d, j.from, newRef);
    s.switchTo(newRef);
    j = { ...j, phase: "switched" };
    writeJournal(d.store.root, j);
  }
  try {
    await closeQuietly(d, j.from);
    await drainForward(d, j.from, newRef);
  } catch (e) {
    throw new Error(
      `${s.name} switched to ${formatRef(newRef)}, but closing ${refText(j.from)} or draining its inbox failed: ${why(e)}; ` +
        `the journal ${journalPath(d.store.root, s.name)} keeps the run: re-run seori migrate --to ${j.to} to finish it`,
    );
  }
  removeJournal(d.store.root, s.name);
  s.setHold(false);
  opts.log(`MIGRATED ${s.name} ${refText(j.from)} -> ${formatRef(newRef)}`);
  return 0;
}
