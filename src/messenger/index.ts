import type { MessengerAdapter, MessengerConfig } from "./adapter.ts";
import { DiscordAdapter } from "./discord.ts";
import { FakeAdapter } from "./fake.ts";
import { SlackAdapter } from "./slack.ts";
import { TelegramAdapter } from "./telegram.ts";
import { voiceTranscriber } from "./voice.ts";

/** The adapter for one configured messenger; `source` names the platform. */
export function adapterFor(config: MessengerConfig, root: string): MessengerAdapter {
  switch (config.source) {
    case "fake": {
      const pollMs = config.options?.["pollMs"];
      return new FakeAdapter(root, typeof pollMs === "number" ? { pollMs } : {});
    }
    case "telegram":
      return new TelegramAdapter(config, root, { transcribe: voiceTranscriber(root) });
    case "slack":
      return new SlackAdapter(config, root);
    case "discord":
      return new DiscordAdapter(config, root);
    default:
      throw new Error(`messenger ${config.source} is not supported`);
  }
}
