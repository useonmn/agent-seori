# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand. Talk to the owner in their language.

## 1. hc, omp and the rest

hc (herdr-core) is the terminal runtime seori runs in. Every lane is an hc terminal labelled with this home's `seori.group`; omp reports its state to hc (idle, working, blocked), and seori reads it, types into a terminal and reads its screen through hc.

```sh
command -v hc                                   # hc must be on PATH
grep -E '^\s*notes\s*=\s*false' "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/config.toml"
```

`notes = false` is required: without it hc types its own notes into the agents' input, and seori's inbox must be the only thing that types there. Ask the owner before installing hc or editing its config.

Also needed: bun 1.3+, git, omp on PATH (logged in to a model provider), the GitHub CLI `gh` logged in (`gh auth status`) for reviews, merges and Done signals on PRs, and on Linux a running systemd user session (`systemctl --user`). macOS works without systemd; Windows is not supported.

## 2. Install seori

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh | bash
```

What it does:

- clones or fast-forwards the checkout in `~/.seori/src` (`SEORI_SRC` picks another place; a checkout with local work whose upstream has moved is not pulled, and `SEORI_NO_PULL=1` installs it as it is);
- `bun install` and `bun link`, so `seori` is on PATH (bun's global bin directory, usually `~/.bun/bin`, must be on PATH);
- links this skill to `~/.omp/agent/skills/seori-mode` (`SKILLS_DIR` picks another place), and leaves a real directory there alone;
- creates `~/.seori` with mode 700;
- warns when hc, hc's `notes = false`, omp, gh or (on Linux) `systemctl` is missing.

It never creates or overwrites `secrets.json`, `messengers.json` or `config.json`. Read every `WARNING:` line it prints and fix it before going on.

Check: `seori --help` prints the command list.

## 3. Messenger, bot, secrets, owner

Follow `messengers.md`: pick the messenger with the owner, create the bot, write `~/.seori/secrets.json` (chmod 600), pair the owner with `seori msg pair <source> --write`, check with `seori msg check`, and greet the owner through the bot.

## 4. Start seori

From a shell, with hc running:

```sh
seori up [--cwd DIR]
# UP lead=hc:t1 duty=hc:t2 units=seori-seori-1a2b3c4d-daemon.service,seori-seori-1a2b3c4d-duty.service,seori-seori-1a2b3c4d-hourly.service home=~/.seori name=seori
```

That opens the lead terminal (omp with `prompts/lead.md`) and the duty terminal, labelled `seori.group=<name>`, and on Linux runs the duty loop, the hourly loop and the messenger daemon as `systemd --user` units (on macOS as hc terminals of the same group). From now on the lead receives the owner's messages and answers them. If `messengers.json` changes later, the daemon restarts on its own.

Tell the owner the lead is up and which terminal it is in.

## 5. Optional config

`~/.seori/config.json` is optional; a missing file means defaults. Every field is checked, and a typo is an error naming the field. Fields:

```json
{
  "name": "<name>",
  "repoIdentities": { "owner/repo": { "name": "Their Name", "email": "them@example.com" } },
  "closeAfterMin": 5,
  "progressEveryMin": null,
  "blockedPromptMin": 10,
  "supervision": { "defaults": { "wallMinutes": null, "tokens": null, "costUsd": null }, "hungAfterMin": 20, "activityPaths": [] },
  "guard": { "loadAlertPct": 150, "loadOkPct": 80, "memFreeMinPct": 10, "diskFreeMinGb": 20, "panesMax": 30 },
  "heavy": { "slots": 1, "maxLoadPct": 80 }
}
```

- `name`: this instance's name (1 to 40 letters, digits, `.`, `_` or `-`, starting with a letter or digit). Required in `$SEORI_HOME/config.json` for any instance other than the first, and different for each instance, so side-by-side instances don't collide.
- `repoIdentities`: the Git identity commits in that repo must carry; `seori verify-pr` and the merge gate check it. Ask the owner for it per repo they want checked.
- `closeAfterMin`: how long after READY a lane with a Done line closes on its own.
- `progressEveryMin`: how often a lane with a thread gets its newest report posted there, in minutes; `null` (the default) is off, so nothing is posted unless the owner asks for it. Set a positive number to turn it on; `0` is refused.
- `blockedPromptMin`: how long a lane may sit on a dialog (tool approval or question) before the lead gets one `[BLOCKED-PROMPT]`.
- `supervision.defaults`: wall-clock, token and cost ceilings for every lane (`null` is off); `hungAfterMin`: when a working lane with no report and no file change is reported stalled; `activityPaths`: files or directories (relative to each lane's working directory: its worktree when seori gave it one, else its cwd) whose change counts as progress besides git status (a file when written, a directory only when an entry is added, removed or renamed; per lane: `seori start --activity-path`).
- `guard`: host load, memory, disk and pane-count lines; `seori can-launch` holds new lanes past them.
- `heavy`: slots and load limit for `seori heavy`.
- `hooks.threadReply`: an argv template (`{thread}`, `{text}`, `{key}`) whose command posts a lane's progress into its thread, in place of the built-in messenger send; see `hooks` in `README.md`.

Write it only with the owner's go, and only the fields they want changed.

- `workflow`: `"ulw"`, `"mass-ulw"`, `"ulw-research"`, `"ulw-plan"`, `"ulw-loop"` or `"ulw-execute"` starts every lane under that omp-ulw workflow (below); leave it out for plain omp goal mode. `seori start --workflow <W>|none` picks it per lane.
- `defaultCwd`: the folder a lane starts in when `seori start`, `seori backlog add` or `seori backlog import` gets no `--cwd` (an absolute path or `~/...`); leave it out to start lanes where the command runs.

### Optional: omp-ulw

[omp-ulw](https://github.com/dbc-hbin/omp-ulw) is a separate omp extension that adds ULW: an intensive, evidence-driven way of working toward omp's goal, plus workflows (mass-ulw, ulw-plan, ulw-research and others) and specialist skills. seori never bundles, copies or installs it; the owner installs it into omp and updates it from its own repository, following its README. Ask the owner before installing it.

- It changes the system prompt of every omp session that loads it: seori's lead, duty and lanes included. seori's reviewer starts omp with `--no-extensions` (extension discovery off).
- With it enabled (`omp plugin list` shows `omp-ulw`), lanes can run under its workflows: `seori start --workflow ulw` (or mass-ulw, ulw-research, ulw-plan, ulw-loop, ulw-execute), or `"workflow"` in config.json for every lane. Without it, `seori start` refuses `--workflow ulw` and says why.
- omp-ulw follows specific omp versions. After updating omp or omp-ulw, restart the omp sessions (run `seori up` again) and check that a new lane still starts with `STARTUP_OK`. If lanes use a workflow other than `ulw`, also start one short lane with it and check that it runs that workflow (for mass-ulw, its graph file appears): the `/goal <workflow> <keyword>` form works with omp-ulw's code today but is not in its README, so an update could change it.

## 6. Onboarding

Unless it was done before, run `onboarding.md`.

## Restarting

After a reboot: on Linux the units come back on their own; run `seori up` again to reopen the lead and duty terminals, then in the lead `seori boot`. Nothing in `~/.seori` is lost: lanes, messages, the worklog and watches are on disk.
