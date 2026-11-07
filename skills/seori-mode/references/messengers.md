# Messengers

seori talks to its owner through one bot on Telegram, Slack or Discord. Ask the owner which one and wait for the answer. Only the owner's messages reach the lead; messages from anyone else, and from bots, are dropped.

Do every login and every click in the browser with the owner; never ask them to paste a password into this session. agent-messenger (github.com/agent-messenger/agent-messenger) can drive bot creation if it is already installed; it is optional, and seori does not need it at runtime.

## 1. Create the bot

### Telegram

1. Open a chat with @BotFather, send `/newbot`, give it the name chosen in setup and a username ending in `bot`.
2. BotFather answers with the token (`123456:ABC...`). That is the secret.
3. Optional: `/setuserpic` for an avatar, `/setdescription`.
4. For groups or forum topics only: `/setprivacy` → Disable. A private chat with the bot needs nothing more.

One program per bot token: two programs reading the same bot make Telegram answer 409. Do not run another bot program on this token.

### Slack

seori uses a bot app in Socket Mode: no public URL, no user token, no paid seat. It only sees DMs with the bot and channels it is invited to.

1. https://api.slack.com/apps → Create New App → From a manifest → pick the workspace → paste:

   ```json
   {
     "display_information": { "name": "<name>" },
     "features": {
       "bot_user": { "display_name": "<name>", "always_online": true },
       "app_home": { "messages_tab_enabled": true, "messages_tab_read_only_enabled": false }
     },
     "oauth_config": {
       "scopes": { "bot": ["chat:write", "im:history", "app_mentions:read", "channels:history"] }
     },
     "settings": {
       "event_subscriptions": { "bot_events": ["message.im", "app_mention", "message.channels"] },
       "socket_mode_enabled": true
     }
   }
   ```

   `app_mentions:read`, `channels:history`, `app_mention` and `message.channels` are only for channels; drop them if the owner wants DMs only.
2. Basic Information → App-Level Tokens → Generate, scope `connections:write`. That is the app token (`xapp-...`).
3. Install App → Install to Workspace → allow. That gives the bot token (`xoxb-...`).
4. The owner opens the app in Slack (Apps → the app → Messages tab) so the DM exists.

### Discord

1. https://discord.com/developers/applications → New Application, with the chosen name.
2. Bot → Reset Token → copy it. That is the secret. On the same page turn on MESSAGE CONTENT INTENT (without it seori reads DMs only, and only after removing that intent from `options.intents`).
3. OAuth2 → URL Generator → scope `bot`, permissions Send Messages, Read Message History, Send Messages in Threads → open the URL and add the bot to a server the owner is in. Discord lets a user DM a bot only when they share a server.
4. The owner DMs the bot once.

## 2. Write the secrets

`~/.seori/secrets.json`, mode 600 (seori refuses a file others can read). Keep only the platform in use:

```json
{ "telegram": { "token": "123456:ABC..." } }
{ "slack": { "botToken": "xoxb-...", "appToken": "xapp-..." } }
{ "discord": { "token": "..." } }
```

```sh
chmod 600 ~/.seori/secrets.json
```

Write the file with a file tool, never through a shell string or `echo`, and never print a token back. Environment variables win over the file if set: `SEORI_TELEGRAM_TOKEN`, `SEORI_SLACK_BOT_TOKEN`, `SEORI_SLACK_APP_TOKEN`, `SEORI_DISCORD_TOKEN`.

## 3. Pair the owner

```sh
seori msg pair <telegram|slack|discord> --write
```

Tell the owner: "send the bot any message now". seori waits (10 minutes by default, `--minutes N`), prints

```
CANDIDATE <source> id=<sender id> chat=<chat> text="<first 40 chars>"
```

for the first non-bot sender, and with `--write` records that sender as `owner` for that source in `~/.seori/messengers.json` (creating it if needed and keeping other entries). Check the text matches what the owner sent before trusting it; if someone else wrote first, run it again without `--write` and with `--all` to see every sender, then pair again. Keep the `chat=` value for the greeting.

Pairing refuses while the daemon is running with that source already configured (two readers on one bot would fight); it is meant for setup, before `seori up`, or to replace the owner after stopping the daemon. Pairing never moves the daemon's own cursor. For Telegram, replacing an owner that is already configured also needs `--force`: Telegram confirms updates on its side once pairing reads past them, so messages queued for the daemon while it was stopped are dropped. Let the daemon deliver them first when they matter.

## 4. Check and greet

```sh
seori msg check
# OK <source>: <who the bot is>
```

A `FAIL` line names what is wrong (a rejected token, a missing intent). Fix it and check again.

Then greet the owner through the bot, in their language, as yourself by the chosen name, in one or two short lines: who you are and that you are getting set up.

```sh
seori msg send --to <source>:<chat> --text '...'
```

`SENT` means it arrived. `HELD` (exit 3) means it may or may not have: ask the owner whether it came through before sending it again (a `--to` notice keeps no ledger, so sending it again simply sends a second copy).

After `seori up`, the daemon receives the owner's messages into the lead pane and the lead answers them with `seori msg send --reply-to <id>`.
