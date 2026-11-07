import { Channel } from "../channel.ts";
import { send, type Deps } from "../harness.ts";
import type { Watch } from "./store.ts";

// Where a watch event goes. The lead reads the lead channel (its extension delivers rows into its omp session, even
// mid-turn as an aside), so a lead event becomes a channel row instead of a pane message that would wait for idle.
// A lane takes pane messages while working (see readyToRead in src/harness.ts), so its events go through `send`.

/**
 * Delivers one event text to the watch's owner. Throws when the event did not or may not have arrived (an unknown or
 * closed lane, a HELD pane delivery); the engine logs it, and never resends, since a HELD event may be in the pane.
 */
export async function deliverWatchEvent(d: Deps, w: Watch, text: string): Promise<void> {
  if (w.owner.kind === "lane") {
    const result = await send(d, w.owner.key, text, "watch");
    if (result === "HELD") throw new Error(`HELD: watch event to lane ${w.owner.key} may or may not have reached its pane`);
    return;
  }
  const channel = new Channel(d.store.root);
  let seq = channel.inbound().filter((r) => r.kind === "watch" && r.watchId === w.id).length + 1;
  // appendInbound refuses an id already stored, so a concurrent writer that took this seq moves us to the next one.
  while (!channel.appendInbound({ id: `watch:${w.id}:${seq}`, kind: "watch", watchId: w.id, name: w.name, at: d.now(), text })) seq++;
}
