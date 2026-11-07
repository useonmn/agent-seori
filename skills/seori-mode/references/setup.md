# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand. Talk to the owner in their language.

## 1. herdr and its omp integration

herdr is the terminal multiplexer seori runs in. Every lane is a herdr tab; herdr lets seori read a pane, type into it and see whether its omp is idle, working or blocked.

```sh
command -v herdr || curl -fsSL https://herdr.dev/install.sh | sh
herdr integration status          # the omp: line must not say "not installed"
herdr integration install omp     # only if it does
```

The integration is required. Without it herdr reports omp as idle at all times, so seori cannot tell a busy lane from an idle one and refuses to start lanes. Ask the owner before installing herdr itself; the integration install is safe to run.

Also needed: bun 1.3+, git, omp on PATH, and the GitHub CLI `gh` logged in (`gh auth status`) for reviews, merges and Done signals on PRs.

## 2. Install seori

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh | bash
```

What it does:

- clones or fast-forwards the checkout in `~/.seori/src` (`SEORI_SRC` picks another place; `SEORI_NO_PULL=1` installs a checkout as it is);
- `bun install` and `bun link`, so `seori` is on PATH (bun's global bin directory, usually `~/.bun/bin`, must be on PATH);
- links this skill to `~/.omp/agent/skills/seori-mode` (`SKILLS_DIR` picks another place), and leaves a real directory there alone;
- creates `~/.seori` with mode 700;
- warns when herdr, its omp integration, omp or gh is missing.

It never creates or overwrites `secrets.json`, `messengers.json` or `config.json`. Read every `WARNING:` line it prints and fix it before going on.

Check: `seori --help` prints the command list.

## 3. Messenger, bot, secrets, owner

Follow `messengers.md`: pick the messenger with the owner, create the bot, write `~/.seori/secrets.json` (chmod 600), pair the owner with `seori msg pair <source> --write`, check with `seori msg check`, and greet the owner through the bot.

## 4. Start seori

From a shell inside herdr, in the directory lanes should start in by default:

```sh
seori up [--cwd DIR]
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 daemon=w1:p5 home=~/.seori
```

That opens a herdr workspace with the lead pane (omp with `prompts/lead.md`), the duty pane, the duty loop, the hourly loop and the messenger daemon. From now on the lead pane receives the owner's messages and answers them. If `messengers.json` changes later, the daemon restarts on its own.

Tell the owner the lead is up and which pane it is in.

## 5. Optional config

`~/.seori/config.json` is optional; a missing file means defaults. Every field is checked, and a typo is an error naming the field. Fields:

```json
{
  "repoIdentities": { "owner/repo": { "name": "Their Name", "email": "them@example.com" } },
  "closeAfterMin": 5,
  "progressEveryMin": 15,
  "supervision": { "defaults": { "wallMinutes": null, "tokens": null, "costUsd": null }, "hungAfterMin": 20 },
  "guard": { "loadAlertPct": 150, "loadOkPct": 80, "memFreeMinPct": 10, "diskFreeMinGb": 20, "panesMax": 30 },
  "heavy": { "slots": 1, "maxLoadPct": 80 }
}
```

- `repoIdentities`: the Git identity commits in that repo must carry; `seori verify-pr` and the merge gate check it. Ask the owner for it per repo they want checked.
- `closeAfterMin`: how long after READY a lane with a Done line closes on its own.
- `progressEveryMin`: how often a lane with a thread gets its newest report posted there.
- `supervision.defaults`: wall-clock, token and cost ceilings for every lane (`null` is off); `hungAfterMin`: when a working lane with no report and no file change is reported stalled.
- `guard`: host load, memory, disk and pane-count lines; `seori can-launch` holds new lanes past them.
- `heavy`: slots and load limit for `seori heavy`.

Write it only with the owner's go, and only the fields they want changed.

## 6. Onboarding

Unless it was done before, run `onboarding.md`.

## Restarting

After a reboot or a herdr restart: start herdr, run `seori up` again, then in the lead pane `seori boot`. Nothing in `~/.seori` is lost: lanes, messages, the worklog and watches are on disk.
