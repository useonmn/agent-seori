import type { MessengerAdapter, MessengerConfig } from "./adapter.ts";
import { FakeAdapter } from "./fake.ts";

/** The adapter for one configured messenger. Only `fake` exists in this stage; real platform adapters come later. */
export function adapterFor(config: MessengerConfig, root: string): MessengerAdapter {
  switch (config.source) {
    case "fake": {
      const pollMs = config.options?.["pollMs"];
      return new FakeAdapter(root, typeof pollMs === "number" ? { pollMs } : {});
    }
    default:
      throw new Error(`messenger ${config.source} is not supported yet (real adapters come in a later stage)`);
  }
}
