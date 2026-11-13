import { ConfigError, loadConfig } from "./config.ts";
import { DeliveryUncertain, session, statusOf, ToolError } from "./runtime/index.ts";
import { Refusal, send, tellLead, type Deps, type DutyEvent, type SendResult } from "./harness.ts";
import { checkSignals, defaultSignalIo, type SignalIo } from "./signals.ts";
import { recordCloseCost } from "./supervision.ts";
import type { Lane } from "./store.ts";

// The done flow of a lane started with a Done line (`seori start --done`): the lane's READY is a claim; seori closes
// the lane `closeAfterMin` minutes later unless the lead objected meanwhile, and only after reading every Done
// signal back live and finding no uncommitted or unpushed tracked work. A failed check is an objection, sent to the
// lane like the lead's own. A lane without a Done line is closed by the lead by hand, as before.

/** Rule 8 of the lane footer: who closes the lane, and for a lane with a Done line how seori decides. */
export function closeRule(seori: string, key: string, done: string | undefined, closeAfterMin: number): string {
  if (done === undefined) return `8. Never close your own pane. The lead closes it with \`${seori} done ${key}\`.`;
  return [
    "8. Never close your own pane. This lane ends when its Done line reads back live:",
    `   \`Done = ${done}\``,
    "   Run every signal yourself before you send ready. After your READY, seori reads each signal back live and checks that " +
      "no tracked work in your checkout or worktrees is uncommitted or on no remote; it closes this lane " +
      `${closeAfterMin} min after READY unless the lead objects. Start no new work meanwhile. An objection (the lead's, ` +
      "or a failed check) arrives here as `[LEAD] not done: <reasons>`: fix every reason, then send ready again; " +
      "a new READY starts a fresh wait.",
  ].join("\n");
}

/** What the lane is told when its READY is recorded and it has a Done line. */
export const claimText = (closeAfterMin: number): string =>
  `[LEAD] claim recorded; the lane closes in ${closeAfterMin} min unless the lead objects`;

/** The extra line on the lead's READY message for a lane with a Done line. */
export const claimLeadLine = (seori: string, key: string, closeAfterMin: number): string =>
  `closes in ${closeAfterMin} min after its Done signals read back live, unless you object: ${seori} object ${key} --reason '<why>'`;

/** What the lane is told when its claim is refused. */
export const objectionText = (reasons: readonly string[]): string =>
  `[LEAD] not done: ${reasons.join("; ")}; keep working and send ready again when fixed`;

/**
 * Closes the lane's pane (unless already gone) and records the close with `note` in its log. What the lane spent is
 * recorded first, while its session can still be read; a failure there is one stderr line and never keeps it open.
 */
export async function closeLane(d: Deps, lane: Lane, note: string): Promise<void> {
  await recordCloseCost(d, lane).catch((e: unknown) => {
    process.stderr.write(`seori: lane ${lane.key}: cost not recorded (${e instanceof Error ? e.message : String(e)})\n`);
  });
  const { rt, ref } = session(d.runtimes, lane.sessionRef);
  if ((await rt.status(ref)) !== "gone") await rt.close(ref);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: note });
  d.store.saveLane(lane);
}

/**
 * The lane as stored now when it still holds the READY claim `lane` was read with (status ready, same final.at),
 * else undefined: the lead objected, paused or closed it, or a new READY came in while its signals were read.
 */
export function sameClaim(d: Deps, lane: Lane): Lane | undefined {
  const now = d.store.lane(lane.key);
  return now && now.status === "ready" && now.final?.at === lane.final?.at ? now : undefined;
}

/**
 * Refuses a READY claim: the lane goes back to working with the objection recorded, and is told the reasons. Only a
 * READY lane can be objected to; each reason must say something.
 */
export async function objectDone(d: Deps, key: string, reasons: readonly string[]): Promise<SendResult | undefined> {
  const why = reasons.map((r) => r.trim()).filter(Boolean);
  if (!why.length) throw new Refusal("an objection needs at least one --reason");
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: there is no claim to object to`);
  const now = d.now();
  lane.status = "working";
  lane.objection = { at: now, reasons: why };
  lane.lastActivityAt = now;
  lane.nudges = 0;
  lane.log.push({ at: now, kind: "object", text: why.join("; ") });
  d.store.saveLane(lane);
  return send(d, key, objectionText(why), "lead");
}

/** A short one-line reason for a duty event (the runtime's own output for a runtime failure, not its argv). */
function eventDetail(e: unknown): string {
  if (e instanceof DeliveryUncertain) e = e.failure;
  const raw = e instanceof ToolError ? e.result.stderr || e.result.stdout : e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

/**
 * The duty pass of the done flow: every READY lane with a Done line whose claim is at least `closeAfterMin` old is
 * checked (checkSignals). Pass: the lane closes and the lead hears `[CLOSED <key>]`. Fail: the claim is objected to
 * with the reasons and the lead hears `[NOT-DONE <key>]`. A pane still working or behind a dialog is left for a
 * later pass. READY lanes without a Done line are the lead's to close.
 */
export async function autoCloseTick(d: Deps, io: SignalIo = defaultSignalIo): Promise<DutyEvent[]> {
  // A lane being migrated (seori migrate) is left alone, as dutyTick and superviseTick leave it.
  const due = d.store.lanes().filter((l) => l.status === "ready" && l.done !== undefined && l.final && l.migration !== true);
  if (!due.length) return [];
  let closeAfterMin: number;
  try {
    closeAfterMin = loadConfig(d.store.root).closeAfterMin;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return [{ action: "autoclose-failed", detail: e.message }];
  }
  const events: DutyEvent[] = [];
  for (const lane of due) {
    if (d.now() - lane.final!.at < closeAfterMin * 60_000) continue;
    try {
      const st = await statusOf(d.runtimes, lane.sessionRef);
      if (st === "working" || st === "blocked") {
        events.push({ lane: lane.key, action: "close-deferred", detail: `pane is ${st}` });
        continue;
      }
      const failures = await checkSignals(d, lane, io);
      const fresh = sameClaim(d, lane);
      if (!fresh) {
        events.push({ lane: lane.key, action: "close-deferred", detail: "its claim changed while its signals were read" });
        continue;
      }
      if (failures.length) {
        await objectDone(d, lane.key, failures);
        events.push({ lane: lane.key, action: "not-done", detail: failures.join("; ") });
        await tellLead(d, `[NOT-DONE ${lane.key}] ${failures.join("; ")}`, "duty");
        continue;
      }
      await closeLane(d, fresh, `closed ${closeAfterMin} min after READY: every Done signal read back live`);
      events.push({ lane: lane.key, action: "closed" });
      await tellLead(d, `[CLOSED ${lane.key}] closed ${closeAfterMin} min after READY: every Done signal reads back live`, "duty");
    } catch (e) {
      // One lane's failed check, close or delivery must not stop the pass for the other lanes.
      events.push({ lane: lane.key, action: "autoclose-failed", detail: eventDetail(e) });
    }
  }
  return events;
}
