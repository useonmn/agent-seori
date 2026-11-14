# seori (서리)

A multi-session coding-agent harness. Its agent is [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi), the only one it runs. It runs on [hc](https://herdr.dev) (herdr-core). Linux is the primary platform and macOS is supported; Windows is not.

English | [한국어](README.ko.md)

seori's design is based on [dori-superagent](https://github.com/sisyphuslabs/dori-superagent). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Quick start with seori mode

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh | bash
```

Then open an hc terminal, run omp in it and say `seori mode` (or `서리 모드`). The seori-mode skill walks you through the rest and stops wherever it needs your choice or your hand: a name for the bot, the install, which messenger (Telegram, Slack or Discord), creating the bot with you in the browser, `secrets.json` and `seori msg check`, pairing you as the owner with `seori msg pair`, a first greeting through the bot, `seori up`, and an onboarding that, with your consent, reads your tools read-only into the agent's memory. Once seori is set up, saying `seori mode` again runs `seori boot` and reports what it lists. See [seori mode skill](#seori-mode-skill).

## What it is

One lead session talks to you. Each task runs as a lane: its own agent session in its own terminal, started from a written brief in goal mode and finished with a READY that must carry evidence. A lane started with a Done line is closed by seori a few minutes after its READY, once every signal in the line reads back live, unless the lead objects. A duty loop nudges lanes that go quiet, escalates to the lead, holds messages for a busy lead or duty session until it can read them, reports lanes that reach a ceiling or stall, guards the host, and posts lane progress into the owner's messenger thread. An hourly loop starts the next backlog item when a lane slot is free. Merges pass through a gate that requires a CLEAR review receipt at the exact head, green checks and a passing verify-pr.

Roles:

- Lead: an agent session with `prompts/lead.md` appended to its system prompt. The only session that talks to you. It writes briefs, opens lanes, reads what they send back, and merges.
- Lane: an agent session in its own terminal, one per task, with the brief and the lane rules (`prompts/lane-footer.md`).
- Duty: an agent session with `prompts/duty.md`, next to the duty loop process (`seori duty`), which flushes inboxes, nudges lanes that stop reporting, escalates, detects lost lanes, closes lanes whose Done line reads back live, reports ceilings, stalls and host guard crossings to the lead, and, when `progressEveryMin` is set, posts progress to the owner's thread.
- Hourly loop: `seori loop`, a process that syncs the backlog, audits missed work, starts the next item and asks open questions through the lead. Design: [docs/hourly-loop.md](docs/hourly-loop.md).
- Daemon: `seori daemon`, a process that receives your messenger messages and stores them for the lead, and runs the watches agents arm. See [Messenger channel](#messenger-channel) and [Watches](#watches).

How the lead talks to you: seori puts the eyes reaction on each of your messages the moment it reaches the lead, and swaps it for a check mark once the lead has answered (see [Reactions](#reactions)); the lead reads the message you replied to first (on Telegram a bot cannot fetch an older message, so it sees only the text of your reply). It answers where you wrote: in your thread or topic when you wrote in one, otherwise in the same DM or channel (on Slack as a top-level message, never in a new thread; on Discord and Telegram as a reply to your message). Each job keeps one status message there that it edits in place (⏳ while working, ✅ when done), and a job in a thread gets a status emoji at the start of the thread name (🔄 working, ⏸ waiting, ✅ done); when the job is done its result reply sets the check mark and the lead closes the thread, and if you write there again it reopens the thread and the job's lane. A reply is one message that grows by editing, not a burst of messages. seori itself sends and edits messages and sets those two reactions; reading a replied-to message, thread names and closing, and finished files go through the optional agent-messenger's bot commands (otherwise the lead skips them, and posts a file's path or link). Apart from those status markers it writes no emojis, and it sends as the bot.

The runtime gives every session a terminal and reports the agent's state in it (idle, working, blocked). seori reads that state before it does anything to a session. The runtime is hc (herdr-core) and the agent is always omp. [docs/runtime.md](docs/runtime.md) explains what seori does on hc. For a home last used with herdr, it also says which leftover records are skipped. Live ones are named on every duty pass as a `DUTY ERROR` line until the file is removed.

The examples below show hc refs (`hc:t7`).

## Requirements

- Linux (primary) or macOS.
- Bun 1.3 or newer.
- hc (herdr-core) on PATH. Put `notes = false` in hc's `config.toml` (`~/.config/herdr-core/config.toml`, or under `$XDG_CONFIG_HOME`). Without it hc types its own notes into the agents' input, and seori's inbox is meant to be the only thing that types there. `install.sh` checks this line and warns, but never edits the file.
- omp (oh-my-pi) on PATH, logged in to a model provider.
- On Linux, a running systemd user session (`systemctl --user`): `seori up` runs the daemon and both loops as `systemd --user` units. macOS needs no systemd; there they run in hc terminals.
- The GitHub CLI `gh`, for PR head SHAs, checks, reviews and the merge.

## Quick start by hand

```sh
bun install
bun link   # puts `seori` on your PATH; or write `bun src/cli.ts` wherever `seori` appears below
```

From a shell, with hc running:

```sh
seori up
# UP lead=hc:t1 duty=hc:t2 units=seori-seori-1a2b3c4d-daemon.service,seori-seori-1a2b3c4d-duty.service,seori-seori-1a2b3c4d-hourly.service home=~/.seori name=seori
```

`seori up` opens two terminals, the lead (named after the instance, `seori` by default) and the duty session (`seori-duty`), both labelled `seori.group=<name>`. Their working directory is `$SEORI_HOME` unless you pass `--cwd`. On Linux the daemon, the duty loop and the hourly loop run as `systemd --user` units named `seori-<name>-<hash>-daemon`, `seori-<name>-<hash>-duty` and `seori-<name>-<hash>-hourly` (`<hash>` is 8 hex digits of `$SEORI_HOME`'s path); they are enabled, so they come back after a reboot or a WSL restart. On macOS the same three processes run in hc terminals of the group. `seori up` waits for the daemon's heartbeat before it starts the loops.

`seori up` is safe to run again at any time, and what it does depends on what is missing. With both the lead and the duty pane live it prints `ALREADY UP ... nothing opened` and opens nothing, however much else is running. When either pane is gone while the home is still there (its units, or the other pane; after a reboot, an hc core restart, or a closed pane), it reopens exactly the missing panes and prints `REOPENED lead,duty lead=hc:t9 duty=hc:t10 running=...` (or `REOPENED duty ...` when only the duty pane was gone); the units are left alone, never restarted. That is the case that used to print `nothing opened` and leave you with no lead until you ran `seori down` and then `seori up`. Two `seori up` of one home at the same time (the logon hook and one typed by hand) never both open: the second prints `UP BUSY ... nothing opened` and exits 0.

Every pane is an hc terminal without `keep`, so a reboot or an hc restart ends it: on Linux only the systemd units come back, and on macOS nothing does. The panes come back only when something runs `seori up` at logon. `seori autostart install` is that something:

```sh
seori autostart install
# AUTOSTART seori-seori-1a2b3c4d-boot.service enabled in ~/.config/systemd/user: it runs `seori up --wait-hc` once at logon
```

It writes a `systemd --user` oneshot (`Type=oneshot`, no `Restart=`; enabled, not started) that runs `seori up --wait-hc --cwd DIR` once per logon, where DIR is the install's `--cwd` (default: the cwd this home's units already run in, else `$SEORI_HOME`), so the agents come back where you started them. `--wait-hc` polls `hc server status` until the core answers (no fixed sleep, up to 10 minutes). hc 0.1.20 starts a core on demand even for `status`, so a plain poll usually brings one up; when a poll still finds none, the hook runs `hc server start` once and keeps polling, which covers an hc whose on-demand start is unavailable (an older hc without the subcommand, or a state dir it cannot write). It never starts a core that already answers, and never more than once. If no core answers in time it prints one `HC UNAVAILABLE` line naming what it waited for and what it tried — `hc server status` exited 5 with hc's own reason, and `hc server start` succeeded or failed with its reason — and exits 0, so the boot is reported rather than retried in a loop; the daemon and loops keep running either way. That line separates a broken seori from an hc that never came up. When even `hc server start` cannot bring a core back, the line carries hc's own message (for example `cannot start core: Permission denied (os error 13)`), which is the next thing to fix. Re-running the install is harmless, `seori autostart status` shows whether the hook is there, `seori down all` removes it, and `seori restart` keeps it. Lane agents are never reopened at logon: their records stay, so a closed lane starts again by key with `seori start`.

`seori restart` is the way a lead or duty session restarts the home from inside its own pane:

```sh
seori restart --follow
# RESTARTING detached; this pane is closed by the down. The new refs and every step land in /home/you/.seori/restart.log (seori restart --follow prints them as they come)
# RESTART_PID 41233
# RESTART_BEGIN home=/home/you/.seori cwd=/home/you/src
# STOPPED duty pid=41221
# ...
# UP lead=hc:t28 duty=hc:t29 units=...,... home=/home/you/.seori name=seori
# RESTART_DONE
# RESTART_EXIT=0
```

`seori down all` closes the terminal the command runs in, so a restart cannot be its own pane's child: the command starts a detached worker that survives the pane being closed, then reports where that worker writes. It tries `setsid --fork`, then `systemd-run --user` (with `PATH` and the caller's `SEORI_*` and `HC_*` variables passed on, since a transient unit gets the user manager's environment; the messenger tokens never are), then `nohup` with SIGHUP ignored, and takes the first that starts. On macOS, which has no `setsid`, that is `nohup`: the worker stays in the pane's session and process group, so it outlives a close that hangs the pane up (SIGHUP) but not one that kills the whole process group; no test closes a real hc pane, so if a restart from a macOS pane dies with it, run `seori restart` from a shell outside the group. One restart of a home runs at a time: the worker holds `$SEORI_HOME/run/restart.pid`, and a second `seori restart` is refused while it runs. The worker checks that hc answers, runs `seori down all --keep-autostart` (a restart keeps the logon hook), and runs the up only once the down has finished; every step and the final exit code go to `$SEORI_HOME/restart.log`, because the pane that asked is gone by then. Without `--cwd` the up opens the agents where the home's units run (the cwd its last `seori up` or `autostart install` was given), else in `$SEORI_HOME`. `--follow` prints that log until the worker ends. Without any way to detach (no `setsid`, `systemd-run` or `nohup`) it refuses, non-zero, before stopping anything. A restart closes every lane pane of the home, so it is refused while a lane is `working` or `waiting`; `--force` goes ahead and names the lanes it ended, whose records stay and can be started again. Never hand-roll a restart script: this is the only supported way, because it is the only one that handles its own pane closing.

`down all` closes every lane pane, so the restart names every lane whose pane it closes (working, waiting, ready, paused), with the command that resumes it, both in its own output and in `restart.log`. A lane whose pane is already gone (a waiting lane whose pane died before duty marked it lost, a ready lane an earlier restart closed) is left out: the restart closes nothing of it, so it neither blocks the restart nor is named again. A working or waiting lane still owes work: a waiting one is live work blocked outside its pane (CI, a review), and the watches it armed end once it is lost. So either refuses the restart unless `--force` is given, and is then named as `ENDED`. Ready and paused lanes do not block it, and are named as `CLOSED`; the refusal lists both kinds:

```
ENDED api status=waiting: the down closes its pane (record and brief stay); it was waiting on something outside its pane (CI, a review), and the watches it armed end once it is lost; resume it with: seori start api --brief '/home/you/.seori/briefs/api.md' --cwd '/home/you/src/api' --workflow none
CLOSED docs status=paused: the down closes its pane (record and brief stay); it was paused, not failed; resume it with: seori start docs --brief '/home/you/.seori/briefs/docs.md' --cwd '/home/you/src/docs' --workflow none
```

After the up, the first duty pass finds a working, waiting or paused lane's pane gone and marks the lane lost, and the new lead gets `[LOST <key>] pane hc:t5 closed without a final answer while the lane was waiting ...` (or paused, or working), saying what that meant and ending with the same `seori start` command, so the lead knows what the lane was doing and can bring it back. That command works before the pass too (while duty is stopped, say): `seori start` takes back the key of any open lane whose pane is gone, and stops the watches its old session armed. A ready lane is not marked lost: its final answer and evidence stay, `seori merge` and `seori done` need no pane, and if it needs more work its command starts it again at once, because `seori start` takes back the key of a ready lane whose pane is gone (it records that session's spend and stops the watches it armed). A ready lane with a Done line whose signals do not read back yet is not objected to once its pane is gone (an objection could not reach it, and `seori object` refuses it with the start command): it stays ready, the lead gets `[NOT-DONE <key>]` once with the start command, and the done window reads its signals again every `closeAfterMin` minutes and closes it once every one reads back live. A `seori boot` that runs before that pass shows each such lane as `VANISHED <key> ... status=<status>` with the same explanation and command. The command carries every launch setting in the lane's record (`--thread`, `--done`, the ceilings, `--activity-path`, `--model`, and `--workflow`, `none` when it had none), so the lane comes back as it was started, not on today's config defaults.

After `seori up` or `seori restart` opens a new lead, seori hands it a start-up line: run `seori boot`, then post one short line to the owner (the thread of the oldest open worklog item, else the owner's direct message) saying seori is back, with the open item count and the lanes still open. The line goes out last, once the duty pane is recorded and the daemon and loops run, so the boot finds the whole home instead of reporting a duty pane or daemon that is still starting; an up that fails after the lead opened still hands it the line, so its boot reports what is missing. The owner therefore hears from a restarted seori without typing anything; `prompts/lead.md` says the same, so a lead started by hand does it too.

`seori down` stops the processes, disables and removes the units and closes every terminal in the group, lanes included. Run it from a shell outside the group: run from inside the lead's terminal, it closes that terminal last and its own output stops there. `down all` also removes the logon hook, unless given `--keep-autostart` (what `seori restart` runs); `down duty`, `down loop` and `down daemon` leave it in place.

Talk to the lead. It writes a brief and opens lanes itself, and you can do the same from the shell:

```sh
seori start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=hc:t3 brief=~/.seori/briefs/fix-flaky-login.md
# STARTUP_OK fix-flaky-login hc:t3
seori status
```

A brief states the goal, inputs, deliverable, an observable exit condition and constraints; see [examples/brief.md](examples/brief.md). Do not write "complete the goal" in a brief: in goal mode that wording makes models stop early. A lane key matches `^[a-z][a-z0-9-]{1,40}$`, and a key that is already open is refused, except one whose pane is gone (a restart closed it, or it died before duty marked it lost), which starting again takes back. One start or close of a key runs at a time: a second `seori start` of the key, or a `seori done` or done-window close while a start takes it back, is refused until the first has finished, and a start that fails writes back the `briefs/<key>.md` it replaced, so the record that stays keeps its own brief.

Inside a lane, the agent reports and finishes with the commands the lane rules give it:

```sh
seori report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
seori report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
seori ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

The lead, on `[READY fix-flaky-login]`:

```sh
seori review owner/repo#12            # fresh isolated reviewer pinned to the head SHA; writes a receipt
seori merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why>
seori merge owner/repo#12             # receipt, checks and verify-pr, then gh pr merge --squash --match-head-commit <sha>
seori done fix-flaky-login            # closes the lane's terminal; only a READY lane can be closed
```

A lane started with `--done` closes on its own; see [Done lines and auto-close](#done-lines-and-auto-close).

A session you started yourself can join seori too. `seori adopt <key> --ref hc:t9 [--brief FILE]` registers a running agent session as a lane without typing anything into it, and `seori sync` compares the lane records with the live sessions of the group (`--write` marks a vanished lane lost; no session is ever closed).

## Commands

```
seori up [--cwd DIR] [--wait-hc]             start this home's lead, duty, duty loop, hourly loop and daemon (once per home):
                                            lead and duty terminals labelled seori.group=<name> (cwd default $SEORI_HOME);
                                            daemon, duty loop and hourly loop as systemd --user units
                                            seori-<name>-<hash>-<daemon|duty|hourly> on Linux, as hc terminals on macOS.
                                            ALREADY UP (nothing opened) while the lead and duty panes are live; when either
                                            is gone (a reboot, an hc restart) it reopens exactly the missing panes and leaves
                                            the running units alone; UP BUSY (exit 0, nothing opened) while another up of
                                            this home is opening it; --wait-hc waits for hc first (the logon hook)
seori restart [--cwd DIR] [--force] [--follow]
                                            down then up for this home, safe from inside the lead or duty pane: the
                                            work runs in a detached child (setsid/systemd-run/nohup), because down closes the
                                            caller's pane. Refused while a lane is working or waiting unless --force,
                                            and while another restart of this home runs; every lane whose pane it
                                            closes (working, waiting, ready, paused) is named with the command that
                                            resumes it (ENDED, CLOSED); keeps the logon hook; DIR defaults to the cwd
                                            this home's units run in, else $SEORI_HOME; new refs go to
                                            $SEORI_HOME/restart.log, --follow prints them
seori autostart install [--cwd DIR]          write and enable the logon hook (a systemd --user oneshot running
                                            seori up --wait-hc --cwd DIR), so the lead and duty panes come back after a
                                            reboot; DIR defaults to the cwd this home's units run in, else $SEORI_HOME
seori autostart status                       whether that hook is installed
seori role <lead|duty> [REF]                 register a session (hc:t7) as lead or duty (default: this one)
seori start <key> --brief FILE [--cwd DIR]   open a lane: new terminal, agent session, lessons + brief + lane rules
            [--done "SIGNALS"] [--thread ID] [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--force]
            [--activity-path PATH ...] [--model M] [--workflow W|none]
                                            Done line read back live before close; ID = lead channel id for progress posts;
                                            ceilings block (report to lead); exits 4 with HOLD when the host is full;
                                            a DIR in the checkout seori runs from opens the lane in its own worktree
                                            $SEORI_HOME/work/<key> (branch <key> from origin/main, or the one already there)
seori adopt <key> --ref <hc:tN> [--brief FILE] [--cwd DIR]
                                            register an already-running session as a lane (types nothing into it)
seori sync [--write]                         lane registry vs live sessions in the seori.group group; with --write a
                                            vanished lane is marked lost (no session is ever closed)
seori transcribe <audio-file>                run hooks.transcribe (config.json, argv template with {file}) and print the text
seori report <key> --text T [--status working|waiting]
seori ready <key> --text T --evidence LINK [--evidence LINK ...]
seori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                [--to-shell]                operator only: type this one message into a pane with no agent
seori inbox list <pane|role|key>             queued entries: index, state (queued|held), sender, time, first 60 chars
seori inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
seori inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
seori duty [--once] [--interval SECONDS]     flush inboxes, nudge silent lanes, escalate, detect lost lanes, close Done lanes,
                                            ceilings and stalls, host guard, progress posts to the owner's thread,
                                            dead agents and agent sessions nothing owns
seori duty stop [--text WHY] | resume | status   kill switch
seori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                            hourly: sync backlog, audit missed work, start the next item, ask decisions
seori loop stop [--text WHY] | resume | status   kill switch and last run
seori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
seori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
seori backlog import <owner/repo> [--label seori] [--cwd DIR]   open labelled issues -> items
seori review <owner/repo#N> [--model M]      fresh isolated agent reviewer at the exact head -> receipt
seori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks + verify-pr -> squash merge
seori verify-pr <owner/repo#N>               commit identities (config repoIdentities) + fix-needs-a-test rule; exit 2 on FAIL
seori done <key> [--lesson T [--evidence P]] lead closes a READY lane (a Done line must read back live); optional lesson
seori object <key> --reason T [--reason T]   the lead objects to a READY claim: back to working with the reasons
seori pause <key> [--note T] | resume <key> [--note T]   pause/resume a lane's agent goal (exit 3 if unconfirmed)
seori checkpoint <key> --step ID --result T --evidence P [--remote-effect R ...] | checkpoints <key>
seori lesson add <key|--cwd DIR> --rule T --evidence P | lesson list [--cwd DIR] | lesson mark <id> --outcome O
                                            O = helped|no-effect|harmful|encoded; new lanes get a repo's pending/helped lessons
seori lesson add --global --rule T --evidence P   the lead's rule for every lane (refused from a lane's terminal)
seori worklog add <title> --source REF | next <id> <text> | note <id> <text> | close <id> --result T | list [--open]
seori boot                                   read-only check after a restart or compaction (exit 1 if unreadable or drifted)
seori can-launch | guard                     room for a lane? (exit 4 HOLD) | host reading and guard state
seori heavy <label> -- <cmd...>              run a heavy command when load is low and a heavy slot is free
seori status
seori daemon                                 receive messengers into the lead channel and run watches (seori up runs it)
seori daemon-loop                            run the daemon and restart it when it crashes (seori up's daemon unit or pane)
seori down [duty|loop|daemon|all] [--keep-autostart]
                                            stop the duty loop, hourly loop and daemon (default all); all also disables
                                            the systemd units and the logon hook (kept with --keep-autostart, as seori
                                            restart does) and closes the seori.group terminals; exit 1 if a process
                                            still runs after 30 s
seori install-skill [--skills-dir DIR]       link the seori-mode skill into the agent's skills dir; install.sh runs it
seori uninstall [--skills-dir DIR] [--purge] remove the skill link and the seori command; --purge also deletes $SEORI_HOME
seori msg send (--reply-to ID[,ID...] | --to SOURCE:CHAT[:THREAD]) --text T [--again] [--ack [--title T]]
                                            answer messenger messages (one reply per id) or send a notice; it goes out
                                            at once, so answer as soon as you have written it; --again sends another
                                            reply to an id already answered (a correction, a job's result); the eyes
                                            seori put on the message become a check mark, except with --ack (a job's
                                            acknowledgement, its status message, which keeps the eyes); on Discord the
                                            first --ack to a server channel message opens the job's thread on it, named
                                            "🔄 <title>" (prints thread=ID), and every later reply and edit goes there
seori msg edit (--reply-of ID | --to SOURCE:CHAT[:THREAD] --message MID) --text T
                                            edit a message seori sent: --reply-of edits seori's first reply to that
                                            lead channel message; MID is the message= send printed
seori msg thread <id> [--status working|waiting|done] [--title T] [--archive]
                                            rename the job's thread (its emoji 🔄, ⏸ or ✅ and its title) and archive it,
                                            or keep it open (reopens an archived one); the thread is the one seori opened
                                            for the id or the one the message was written in (Discord)
seori msg close <id> --why T                 close a lead channel message (messenger message or watch event) that needs no
                                            reply; a messenger message gets the check mark
seori msg list [--all]                       open lead channel messages (messenger messages and watch events; --all: every one)
                                            columns: id  state  age  kind  sender-or-watch-name  text
seori msg check [SOURCE]                     verify messengers' tokens (prints who the bot is); SOURCE works before pairing
seori msg pair <SOURCE> [--minutes N] [--write] [--all] [--force]
                                            setup: print the sender of the next DM to the bot; --write makes them the owner;
                                            --force re-pairs a configured Telegram owner (drops updates queued for the daemon)
seori presence discord                       keep the Discord bot shown online until stopped (see Presence)
seori watch add (--command CMD [--filter RE] [--cwd DIR] | --file PATH | --checks OWNER/REPO#N
                 | --pane PANE --status idle|working|blocked|gone)
                 [--name N] [--persistent] [--timeout DUR] [--for lead|KEY]
                                            wake the lead or a lane when it fires (DUR: 90s, 30m, 2h)
seori watch list [--all]                     active and muted watches (--all: every one)
seori watch stop <id|name>                   end a watch
seori watch rearm <id|name>                  unmute a watch that used up its wake budget
seori watch log <id|name> [-n N]             the watch's last events
```

`--text` may be left off to read the message from stdin. `send`, `report` and `ready` exit 3 and print `HELD <target>` when a delivery may or may not have reached the pane; a held message is never resent, so check the pane, then `seori inbox ack` or `seori inbox resend` it. `QUEUED` (exit 0) means it waits in the pane's inbox. `object` prints `OBJECTED <key>` and reports its message to the lane the same way. `msg send` exits 0 with `SENT`, 3 with `HELD` when the messenger may or may not have the reply (check the chat, then pass `--again` to send it anyway), and 2 when it refuses, for example a second reply to an id that is already answered. A notice (`msg send --to`) is HELD (exit 3) the same way when it may have arrived, but it has no ledger: sending it again sends a second copy, and `--again` is for replies only. `start` and `can-launch` exit 4 with `HOLD <reasons>` when the host has no room for a lane; `pause` and `resume` exit 3 when the pane did not confirm; `verify-pr` exits 2 on FAIL; `boot` exits 1 when something could not be read or the registry drifted. `transcribe` exits 2 when no `hooks.transcribe` is set, the file is missing or the hook failed. Refusals, including a broken `config.json` for the commands that read it, exit 2. The commands the agents see are rendered with the full path to `src/cli.ts` and `SEORI_HOME` set, so `seori` does not need to be on their PATH.

## How a lane starts

`seori start <key> --brief FILE` first checks that the host has room for a lane (see [Host guard](#host-guard-can-launch-and-heavy-slots); `--force` skips the room check) and refuses a Done line (`--done`) it cannot parse. It writes the lessons for the lane's directory (see [Lessons](#lessons)), the brief and the lane rules to `~/.seori/briefs/<key>.md` and opens a new terminal with a plain shell.

A lane's directory is `--cwd`, else `defaultCwd`, else the folder the command runs in. When that directory is the checkout seori itself runs from (the install checkout: `SEORI_SRC`, default `~/.seori/src`, the checkout `seori` on PATH links into) or a folder inside it, seori does not open the lane there. The one exception is a `$SEORI_HOME` that itself lies inside the install checkout: a folder in that home holds seori's state, not its code, so it does not count (the default layout is the other way round, with the checkout at `$SEORI_HOME/src`). seori gives the lane a git worktree of its own at `$SEORI_HOME/work/<key>` and opens the pane at that worktree's root. A new worktree gets a new branch `<key>` from `origin/main`, which seori fetches first (`git fetch origin main` in the install checkout). If `$SEORI_HOME/work/<key>` is already a worktree of that repository (a lane started again: a restart resume, more work for a ready lane, a reopened job), it is reused as it is; if branch `<key>` exists without a worktree, the worktree checks that branch out. Neither of those fetches. A directory at that path that is not a worktree of the install's repository, a failed fetch or a failed `git worktree add` refuses the start, naming the cause, and nothing is opened. The lane record keeps `cwd` as the directory asked for (the install checkout) and the worktree in its own `worktree` field, so lessons stay keyed by the checkout and the resume command printed by restart, `[LOST]` and VANISHED still says `--cwd <install checkout>`, which reuses the worktree. From here on, the lane's working directory means its worktree when it has one, else its cwd.
The brief file is read before any worktree is made or reused, so a missing or unreadable brief refuses the start with nothing created. seori's git runs here with `GIT_TERMINAL_PROMPT=0` and in a session of its own with no terminal, so it never waits on a credential prompt and ssh cannot ask for a passphrase or a host key either; the fetch is killed with everything it started after 60 s, which refuses the start naming the timeout. A folder already at `$SEORI_HOME/work/<key>` is reused only when it is a worktree of the install checkout on branch `<key>`; on another branch or a detached HEAD the start is refused, naming what it is on. A worktree deleted by hand that git still has registered loses that one record (`git worktree remove --force <dir>`; other lanes' records are left alone) and is made again from branch `<key>`. Starting again a lane whose record has a worktree with a directory outside the install checkout is refused before any pane opens: its work is in that worktree, so start it again in the install checkout (the resume command seori prints does) or close it first.

The terminal joins the instance's group (`seori.group=<name>`, with `seori.role` and `seori.name` labels). seori types the agent command into it and waits for the agent to report its first status. It then sends the kickoff: a `/goal` command whose objective points the agent at the brief and the lane key. seori then waits for omp to report `working` on the kickoff (see the startup verdict below for what happens when it does not).

The lane is recorded as `working` (with its Done line, `--thread` and ceilings, when given) and the lead gets `[START <key>]`.

`seori start` then prints `STARTED <key> pane=<ref> brief=<path>` (followed by ` worktree=<dir>` when seori made or reused a worktree for the lane) and watches the new lane before it returns. It reads the lane's screen (unwrapped: a line the terminal wrapped over several rows reads as one) and its status 20 s after the kickoff, then every 10 s for up to `startupWaitSeconds` (default 180; a slow host can take minutes before omp's first turn runs), and prints one more line:

- `STARTUP_ERROR <key> <ref>: <phrase>` (exit 3): a known failure is on the screen, such as `No API key`, `429 Too Many Requests`, `Rate limit reached` or `exceeded your current quota`. After the first check, the screen is checked only while omp is not working, since a working lane's own output may quote such a line.
- `STARTUP_UNCONFIRMED <key> <ref>: <why>; last lines: ...` (exit 3): omp reported no ready status in time, is behind a dialog, left a shell in front or is gone, a status or screen read failed, or omp never started on the kickoff (it never reported working).
- `STARTUP_DONE <key>` (exit 0): the lane sent READY during the wait.
- `STARTUP_OK <key> <ref>` (exit 0): omp started on the kickoff and is running, with no failure on its screen.

On exit 3 the lane record and its terminal stay, so the lead can look at the pane, fix the cause and send the lane on. Lanes the hourly loop starts from the backlog skip this wait; for them a kickoff omp has not started on is only a warning on stderr.

The lane rules tell the agent to restate the deliverable and the exit condition in its first reply, and never to mark the goal complete before `seori ready` has succeeded. From there the lane sends `[REPORT <key>]` (or `[REPORT <key> WAITING]` when it is blocked outside its own terminal) and ends with `[READY <key>]` plus its evidence links. The rules also tell it to record a checkpoint after each completed step and read them back with `seori checkpoints <key>` after a restart or compaction, to start nothing while the owner has paused it, and who closes the lane: the lead by hand or, for a lane with a Done line, seori after the close window.

## What the harness enforces

One voice. The lead is the only session that talks to you. Lanes send every fact meant for the human to the lead, and the duty session never merges and never talks to the human. Everything a lane does reaches the lead pane as a prompt: `[START]`, `[REPORT]`, `[READY]`, `[LOST]`, `[ESCALATE]`.

READY needs evidence. `seori ready` refuses without at least one `--evidence` link and without final answer text. The text and links are stored on the lane record, and `seori done` refuses any lane that is not READY, so no lane closes without a recorded answer. For a lane with a Done line, READY is a claim that seori reads back live before the lane closes; see [Done lines and auto-close](#done-lines-and-auto-close).

Lead and duty panes are not interrupted; lanes take messages mid-turn. `seori send` asks the runtime for the session's agent state first. An idle agent gets the message now. A lane in goal mode reads `working` until its goal ends, so an open lane's pane also gets the message while working: the agent takes it as a steer, handles it and continues. A busy lead or duty pane, and any blocked pane (a dialog is open), has it queued in `~/.seori/inbox/`, and the duty loop delivers the queue as one message when the pane can read. A pane with no agent in front (the agent exited, or was suspended with Ctrl+Z and left a shell in front) is never typed into, because text typed into a shell runs as a command; its messages stay queued until the agent is back. `--to-shell` types one message into a plain shell on purpose and applies to that message only.

Nudges at 10, 20 and 40 minutes. A lane that has not reported for 10 minutes gets `prompts/nudge.md` in its pane, even while its pane reads working: a goal-mode lane reads working until its goal ends, so working is not taken as progress, and the nudge arrives as a steer. At 20 it gets it again. At 40 the duty loop stops nudging and sends the lead `[ESCALATE <key>]`. Lanes therefore report a milestone at least every 10 minutes. A lane that reported `--status waiting` or whose pane is blocked is left alone, a new report resets the nudge count, and a lane whose pane disappears before READY is reported as `[LOST <key>]`. A lane whose pane stays blocked (a tool approval or question waits) for `blockedPromptMin` minutes (default 10) is told to the lead once per dialog as `[BLOCKED-PROMPT <key>]`; nothing is typed into that pane.

Merge needs a CLEAR receipt at the exact head, green checks and a passing verify-pr. `seori merge` reads the PR's head SHA with `gh` and requires a receipt for that SHA in `~/.seori/receipts/` with verdict `CLEAR`. Only `seori review` writes receipts. It runs a fresh non-interactive omp reviewer (optionally with `--model`) on `prompts/review.md` pinned to that SHA. The reviewer runs isolated, without the repository's AGENTS.md, skills, rules or extensions, reads the PR with `gh`, and must end with exactly one `VERDICT: CLEAR` or `VERDICT: BLOCK` line; without one, no receipt is written. Then `gh pr checks` must return at least one check, every check must pass or be skipped, and at least one must pass: an empty check list is never green. Last, verify-pr must pass (see [verify-pr and the merge gate](#verify-pr-and-the-merge-gate)). The merge is `gh pr merge --squash --match-head-commit <sha>`, so a push after the review changes the head and the old receipt no longer applies.

## Done lines and auto-close

A lane can be started with a Done line: signals seori reads back live before the lane may close, so a lane's "done" is never taken on its word.

```sh
seori start fix-flaky-login --brief brief.md --done 'merged owner/repo#12; command ["bun","test"] stdout~"0 fail"'
```

Signals are joined by `;` (a `;` inside quotes, brackets or braces belongs to its signal), and a leading `Done =` is dropped. `seori start` refuses a Done line it cannot parse (exit 2) and names each bad signal.

| signal | holds when |
|---|---|
| `merged owner/repo#N` | `gh pr view` reports the PR MERGED with a merge commit |
| `closed owner/repo#N` | `gh issue view` reports the issue CLOSED |
| `published pkg@version` | `npm view` finds that version in the registry |
| `command ["argv",...] [stdout~"regex"]` | the command exits 0 (and its stdout matches); it runs without a shell in the lane's working directory (its worktree when seori made one, else its cwd), for 2 minutes at most |
| `file <path> [sha256=<hex>] [json:.a.b=<json>]` | the file exists (relative to the lane's working directory, `~` expanded), with that SHA-256 and that JSON field value when given |
| `url <http(s) url> [status=N] [body~"regex"]` | a GET (redirects followed) answers that status (default 200) within 15 seconds, and the body matches when given |

`merged` and `closed` also take `owner/repo/pull/N` and `owner/repo/issues/N`. `command ["true"]` parses but proves nothing: a Done line should name the outcome itself (a merged PR, a file).

With a Done line, the lane's READY is a claim:

1. On `seori ready`, the lane is told `[LEAD] claim recorded; the lane closes in N min unless the lead objects`, and the lead's `[READY <key>]` carries an extra line with the `seori object` command.
2. Until the window ends the lead may refuse the claim: `seori object <key> --reason T [--reason T]` puts the lane back to working with the reasons and sends it `[LEAD] not done: <reasons>; keep working and send ready again when fixed`. Only a READY lane can be objected to, and each reason must say something. A new READY clears the objection and starts a fresh wait.
3. `closeAfterMin` minutes after the claim (default 5, see [Configuration](#configuration-configjson)), the duty loop checks the lane: every signal read back live, then the unpushed-work rule. A pane still working or behind a dialog is left for a later pass, and so is a lane whose claim changed while its signals were read (an objection, a pause or a new READY); both show as a `close-deferred` duty event. If everything holds, the pane closes and the lead gets `[CLOSED <key>]`. If not, the claim is objected to with the failures (each as `<signal> -> <why>`), exactly as if the lead had objected, and the lead gets `[NOT-DONE <key>] <reasons>`.

Unpushed-work rule: closing must not lose tracked work. seori checks the lane's own git worktrees (those whose branch or directory is named `<key>` or `<key>-...`, which includes the worktree seori makes at `$SEORI_HOME/work/<key>`), or else the lane's cwd when it is a git checkout. Uncommitted changes to tracked files fail (untracked files do not count), and so do commits that are on no remote. A repository with no remote at all has only its uncommitted changes checked. Git state that cannot be read is a failure, never a pass.
A worktree recorded on the lane always counts as one of its own, even when `git worktree list` no longer lists it (removed and pruned); missing on disk, it fails the close as `(worktree missing)` instead of falling back to the lane's cwd. Worktree paths are compared with symlinks resolved.

Install checkout hold: a lane started in the install checkout (its record has a worktree, or its cwd is the install checkout or a folder in it) does not close while the install checkout itself has uncommitted changes to tracked files, whatever worktree the lane owns, and git state there that cannot be read holds it too. That checkout is the code seori runs, not a human's checkout to ignore, and an edit there by absolute path would otherwise leave the lane's worktree clean and close it. Untracked files there do not count, and commits on no remote there are not checked. Nothing shows which lane made those changes, or whether the owner did while developing in that checkout, so the hold is never sent to the lane as an objection (it would be tempted to discard someone else's work): the duty loop keeps the claim (a `close-deferred` event), tells the lead once per claim `[NOT-DONE <key>] uncommitted tracked changes in the install checkout <dir>, which this lane was started in: <files>` with what to do about them, reads it again every `closeAfterMin`, and closes the lane once the checkout is clean.

`seori done <key>` on a lane with a Done line runs the same checks and refuses with the list of reasons. A lane without a Done line is checked and closed by the lead by hand. `seori done` refuses any lane whose pane is still working or blocked, and refuses with `lane <key> changed while it was being checked ...; run done again` when the lane changed (an objection, a pause, a new READY) while its pane and signals were read. A paused lane is not closed on its own.
`seori done` applies the install checkout hold to every lane started there, with or without a Done line, and names the changed files.

## verify-pr and the merge gate

`seori verify-pr owner/repo#N` reads the PR back from GitHub (`gh api`) and checks two rules:

- Commit identities: every commit's author and committer email must be the email of the repo's `repoIdentities` entry in `config.json` (compared without case). `noreply@github.com` is accepted only as the committer of a merge commit, which is how GitHub commits merges made in its UI. A repo with no entry is not identity-checked: the output says `IDENTITY skipped (no repoIdentities entry for owner/repo)` and only the test rule applies.
- Fix needs a test: when a `fix:` commit (also `fix(scope):` or `fix!:`) changes source files, the PR must add or change a test file, or its body must have a `No test: <reason>` line, which turns the failure into a warning. A fix commit without a test of its own is only a warning; coverage is judged across the PR.

A test file is a `*.test.*` or `*.spec.*` file, `test_*.py`, `*_test.go` or `*_test.py`, or a code file under `test/`, `tests/` or `__tests__/`; fixtures, helpers, fakes, mocks, `setup`, `conftest` and `test-utils` files do not count. A source file is a code or style file outside tests, docs and fixtures.

The PR is read before and after the commit walk; when its head, body or commit count changed in between, or GitHub could not be read completely, the result is FAIL, never a verdict on a half-read PR. Output: `PASS|FAIL owner/repo#N at <sha>`, then `- <failure>` lines, `IDENTITY skipped (...)` and `WARNING <note>` lines. Exit 0 on PASS, 2 on FAIL.

`seori merge` runs verify-pr after the receipt and check gates. A FAIL refuses the merge with `MERGE_REFUSED verify-pr failed:` followed by verify-pr's lines.

## Lessons

A lesson is a one-line rule a lane leaves for the next lane in the same repository.

```sh
seori done fix-flaky-login --lesson 'run the login tests 20 times before calling a flake fixed'
seori lesson add fix-flaky-login --rule '...' --evidence https://github.com/owner/repo/pull/12
seori lesson add --cwd ~/src/app --rule '...' --evidence '...'
seori lesson add --global --rule '...' --evidence '...'
seori lesson list [--cwd DIR]
seori lesson mark <id> --outcome helped|no-effect|harmful|encoded
```

- A lesson belongs to one directory: the lane's cwd (`lesson add <key>`, `done --lesson`), or `--cwd DIR` (recorded with lane `lead`). The path is resolved to its real path and matched exactly.
- `seori start` puts up to 8 of the newest `pending` or `helped` lessons for the lane's cwd at the top of the brief, under `## Lessons for this repo`.
- A `--global` lesson is the lead's standing rule for every lane, whatever its repo: it has no cwd and is recorded with lane `lead`. `seori start` puts up to 4 of the newest pending or helped global lessons above the repo's, under `## Lessons for every lane`; the cap is separate, so global rules never push repo lessons out. `--global` and `lesson mark` on a global lesson are refused from a lane's terminal (the terminal of an open lane, found from `HC_TERMINAL_ID`). That check is a convenience against accidents, not a security boundary.
- A new lesson is `pending`; `lesson mark` records its outcome. Lessons marked `no-effect`, `harmful` or `encoded` no longer go into briefs.
- `done --lesson` never blocks the close. Its evidence is `--evidence`, else the lane's READY evidence, else its Done line. A lesson that is refused prints `LESSON_WARNING <why>` after `DONE`.
- The rule is one line of at most 400 characters, the evidence one line of at most 2000.
- Output: `LESSON <id> pending <lane> <cwd>` for an add, `MARKED <id> <outcome>` for a mark; `lesson list` prints per lesson `<id> <outcome> <added> <lane> <cwd>` with indented rule and evidence lines, or `EMPTY`.

`$SEORI_HOME/lessons.jsonl` is append-only: a mark appends the record again with its new outcome, and the last record for an id wins. A damaged line is skipped and named as `LESSON_WARNING <path>:<line>: <reason>`, so one bad line never hides the rest.

## Checkpoints

A checkpoint journal lists a lane's completed steps, so a lane resumed after a crash, a restart or a compaction knows what is done and never repeats a remote side effect (a push, a merge, a publish).

```sh
seori checkpoint fix-flaky-login --step push-fix --result 'pushed the fix branch' --evidence https://github.com/owner/repo/pull/12 --remote-effect push:fix-flaky-login@abc1234
# CHECKPOINT fix-flaky-login push-fix recorded
seori checkpoints fix-flaky-login
```

- The lane rules tell each lane to record a checkpoint after every completed step, and to run `seori checkpoints <key>` before resuming after a restart or a compaction.
- `--evidence` (at least one) and `--remote-effect` may repeat; every value is one line. A remote effect is the receipt of one completed side effect.
- Recording a step again with the same data changes nothing (`CHECKPOINT <key> <step> unchanged (recorded <at>)`). The same step with different data is refused, and so is a remote effect already recorded under another step.
- `seori checkpoints <key>` prints each step as `<at> <step>: <result>` with indented evidence and remote-effect lines, or `EMPTY <key>`. A damaged journal line stops it with an error naming the line, since a journal that cannot be read in full must stop a resume.
- The key must belong to a lane seori knows (open or closed). The journal is `$SEORI_HOME/checkpoints/<key>.jsonl`, written under a lock and synced to disk before the command answers.

## Pause and resume

```sh
seori pause fix-flaky-login --note 'owner said wait'
# PAUSED fix-flaky-login goal paused
seori resume fix-flaky-login
# RESUMED fix-flaky-login as working, goal resumed
```

`seori pause <key>` delivers `/goal pause` to the lane's agent and marks the lane `paused` only once the pane shows it (`Goal mode paused.` or `Warning: No active goal to pause.`; either way nothing can continue the goal on its own). After that, seori watches the pane for about 3 seconds and presses Escape once if a turn is running or starts, so a turn that was just starting is interrupted too. A working, waiting or ready lane can be paused; a paused one prints `PAUSED <key> already`. `seori resume <key>` delivers `/goal resume`, waits for `Goal mode resumed.` (or `Warning: No paused goal to resume.`), restores the status the lane had before the pause and restarts its quiet time, so a long pause does not turn into an instant nudge or stall report. `--note` goes into the lane log.

When the pane does not confirm within about 6 seconds, the command prints `PAUSE_UNVERIFIED <key> ...` or `RESUME_UNVERIFIED <key> ...`, exits 3 and leaves the lane as it was: the lane may still be running, so check its pane and retry.

A paused lane gets no nudges and no ceiling or stall reports. A report from a paused lane (woken by a watch or a message) is passed to the lead but never ends the pause; only `seori resume` does. If its pane reads working on two duty passes in a row, the lead gets `[WORKING-WHILE-PAUSED <key>]`, once per working stretch, and the lane stays paused. A paused lane whose pane disappears is marked lost and the lead gets `[LOST <key>]`, like any other lane. The lead's rules tell it to pause in the same turn when the owner says wait, stop or hold on (잠깐, 멈춰, 기다려). Pausing a lane that runs an omp-ulw workflow is safe the same way; resume continues from the workflow's own ledger, but subagents already running finish their current step.

## Supervision (ceilings, stalls and pane health)

The duty loop watches every open lane for the things below and tells the lead once each. seori never messages, pauses or kills a lane for them; the lead decides.

Ceilings. A lane can have a wall-clock, a token and a cost ceiling. `seori start --wall-minutes N --token-limit N --cost-limit N` sets them for one lane; `none` switches one off, and a flag left out takes the config default. A lane started with none of these flags follows `supervision.defaults` in `config.json`, which are all off by default. Wall-clock time counts from the lane's start. Tokens and cost are summed over the assistant messages in the lane's agent session file, whose path comes from the runtime. hc reports no such path today, so the totals read as unknown and only the wall-clock ceiling applies; a total that cannot be read never reaches a ceiling and is shown once as a `usage-unknown` duty event. A reached ceiling is told as `[BLOCKED <key>] <which> ceiling reached (<reading>, limit <limit>); the lane keeps running until you decide`, once per ceiling and limit (a raised limit is told again once reached), and logged on the lane.

Cost record. When a lane closes (`seori done`, or seori's own close after a Done line), what it spent is read from its agent session file before the session closes and appended to `$SEORI_HOME/cost.jsonl` as one line: `{ "key", "closeKey": "<key>@<createdAt>", "tokens", "costUsd", "at" }`. A total that cannot be read (hc reports none today) is `null`, never 0. A retried close adds no second line. The file stays local; nothing is sent anywhere unless you set `hooks.recordCost`, which then runs once with the reading. A failure here is one stderr line and never keeps a lane open.

Stalls. A working lane that the runtime reads working but that has sent no report and changed no file for `supervision.hungAfterMin` minutes (default 20) is told as `[STALLED <key>] ...`, once per stall. A file change is a new HEAD or a change in the paths `git status` lists in the lane's working directory (its worktree when it has one, else its cwd; `node_modules` left out), with their times and sizes. Paths given with `seori start --activity-path PATH` (repeatable) or in `supervision.activityPaths`, relative to the lane's working directory, count too, git checkout or not: a file counts when it is written (a symlink's target is read), a directory only when an entry in it is added, removed or renamed, so list a file itself to catch rewrites inside a directory. A lane writing a log outside its checkout is then not reported stalled while it writes; outside a git checkout and without activity paths only reports count. A waiting lane said it waits, so its quiet is no stall. The change history is kept in `duty/supervision.json`.

Dead agents. A working, waiting or paused lane whose pane shows a shell in front (its agent exited, crashed or was suspended with Ctrl+Z) on two duty passes in a row is told as `[DEAD <key>] ...`, once per spell; the duty pane is watched the same way and told as `[DEAD duty] ...`. Such a lane gets no nudges, since nothing can be typed into a shell; its record stays, so the lead can close the pane and start the lane again. A READY lane is left alone.

Agent sessions nothing owns. An agent session (a terminal whose program reports a status; a plain shell is none, although hc lists its command as `agent`) in the instance's group that no role and no open lane owns for 5 minutes is told as `[UNREGISTERED <pane>] ...`, once, with the `seori adopt` command that makes it a lane. The wait covers a lane's start, when its terminal runs before its record is written. `seori boot` lists the same sessions on demand.

For both, a pass less than 30 seconds after the last one (a `seori duty --once` beside the loop) does not count again, a lane record naming a terminal outside the group (an id reused after an hc restart) is not reported, and nothing is marked told while no lead is recorded, so a lead recorded later still hears of it. The messages give the hc commands with the bare terminal id (`hc read t5`). Spells are kept in `duty/panes.json`.

## Worklog

The worklog is the lead's record of owner requests, so a lead that was compacted or restarted resumes from the record and not from memory.

```sh
seori worklog add 'Fix the flaky login test' --source telegram:123:456
seori worklog next 1a2b3c4d 'open a lane once CI is green'
seori worklog note 1a2b3c4d 'lane fix-flaky-login started'
seori worklog close 1a2b3c4d --result 'merged owner/repo#12'
seori worklog list --open
```

- `add` gives the item an id of 8 hex digits. `next` replaces the item's next step, `note` adds a note, and `close` ends it with a result. Each prints the item as saved, as one JSON line. Changing an unknown or closed item is refused (exit 2).
- The title (at most 200 characters), the source (400) and each next, note or result text (1000) are one line.
- `list` prints the items oldest first as indented JSON (`--open`: only the open ones), with a `WORKLOG_WARNING <text>` line on stderr for each damaged line.
- `$SEORI_HOME/worklog.jsonl` is the record: append-only, one write per change, so writers at the same time never lose each other's lines. `$SEORI_HOME/worklog.md` is rendered from it after every change, open items first. seori only replaces a `worklog.md` it wrote itself (its first line is a marker); when another file is there, the command refuses until you move it aside.

The lead's rules: `add` the moment a request arrives, `next` and `note` as it moves, `close --result` with what came of it.

## Boot

`seori boot` is the read-only check the lead runs after a restart, a `/new` or a compaction, before acting on what it remembers. It changes nothing: no lane or role is written, nothing is relaunched, no watch is stopped, no message is closed, and no lane, role, watch or message record is written (an unused home only gets its empty state directories). Its lines, in order:

- `CONFIG` (ok, defaults or invalid) and `MESSENGERS`;
- `LEAD` and `DUTY` with their pane and status;
- `PANES` (a summary), `VANISHED` for an open lane whose pane is gone (its record is kept, nothing is relaunched), `UNREGISTERED` for an agent pane that no role and no open lane owns;
- for each open lane, `READY` (since when, minutes waiting, `done=signals` or `done=by-hand`) and `PAUSED` when they apply, then `REPORT` with its last report or `NO-REPORT`;
- `WORKLOG open=N` and an `OPEN` line per open worklog item;
- `CHANNEL open=N` and a `MSG` line per open lead channel message;
- `WATCHES` and `ORPHAN-WATCH` for a live watch whose owner lane is closed (with the command that stops it);
- `INSTALL` for the install checkout: `INSTALL clean <dir>`, `INSTALL dirty <dir> N uncommitted tracked file(s): <up to 5 paths>[ ...]; a lane started there may have edited the code seori runs`, `INSTALL not-a-checkout <dir>`, or `INSTALL unreadable <dir> (<why>)`;
- `DAEMON` heartbeat age (fresh or stale) and a `MESSENGER` health line per source;
- `BOOT checked`, `BOOT incomplete`, or `BOOT failed (N drift)`.

A stale heartbeat is not a failure. `boot` exits 1 when an input could not be read (each such input has its own line) or when the registry drifted from the runtime: one `DRIFT` line per problem, either `DRIFT lane <key> has no session <ref>` (an open lane whose session the runtime reports gone) or `DRIFT session <ref> is in group <name> but has no lane or role record` (an agent session in this home's `seori.group` with no lane or role record; shells such as the loop panes are not flagged). Nothing is relaunched or closed.
`INSTALL dirty` is reported, not a failure; `INSTALL unreadable` is an input that could not be read, so the boot is incomplete and exits 1.

## Host guard, can-launch and heavy slots

The host guard takes one reading of the machine: the 1-minute load per core in percent (100 = every core busy), free memory, free disk on the volumes lanes work on (`df -k -P` of each open lane's working directory, else of `$HOME`; `$SEORI_HOME` itself is not measured, it may sit on a small tmpfs, but a lane worktree under it is) and the number of live sessions hc lists (`hc ls`).

- `seori can-launch` prints `CAN_LAUNCH` (exit 0) or `HOLD <reason> | <reason>` (exit 4). It holds a new lane when free memory is under `guard.memFreeMinPct`, free disk under `guard.diskFreeMinGb`, or there are more panes than `guard.panesMax`. CPU load never holds a launch: it moves too fast to plan around (heavy commands wait for it instead). A figure that cannot be read holds nothing and raises no alert, so a flaky `df` or runtime call does not stop all work; `seori guard` shows it as `unknown`.
- `seori start` runs the same check: when the host is full it prints the `HOLD` line and `lane <key> not started; queue it (seori backlog add) or pass --force`, and exits 4. `--force` skips the check. The lead's rules tell it to run `seori can-launch` before opening a lane and to queue the work on HOLD.
- `seori guard` prints `HOST load N% per core, memory free N%, disk free N GB, panes N` and then `HOST_GUARD OK` or `HOST_GUARD ALERT <reasons>`. It is read-only.
- The duty loop tells the lead `[HOST-GUARD ALERT] <reasons>` when the host crosses a threshold and `[HOST-GUARD CLEAR] <figures>` when every threshold is fine again, once per crossing (state in `duty/guard.json`). Load alerts above `guard.loadAlertPct` and stays high until it falls under `guard.loadOkPct`, so a load hovering at the threshold does not flap. Memory, disk and panes alert at the same thresholds that hold launches. A raised alert is cleared only by figures read as fine: while a figure cannot be read, the alert stays as it was, so there is no false CLEAR followed by a second ALERT.

`seori heavy <label> -- <cmd...>` runs a full build or test suite only when the load per core is under `heavy.maxLoadPct` and one of `heavy.slots` slots is free, so parallel lanes do not all compile at once. While it waits it prints `HEAVY <label> waiting: <why>` on stderr each time the reason changes, and it checks again every 15 seconds. A slot is a lock file `$SEORI_HOME/heavy/<n>.lock`; a slot whose holder died is taken over. The command runs without a shell, on seori's terminal, and seori exits with its status (128 + the signal number when a signal ended it). SIGTERM and SIGHUP are passed on to it, and Ctrl-C reaches the command without ending seori first, so the slot is freed only when the command is done. The duty prompt tells duty to run heavy commands this way.

`seori heavy <label>` without `--` and a command after it is refused (exit 2).

## Progress posts to the owner's thread

A lane started for a messenger message can carry that message's lead channel id: `seori start <key> --brief FILE --thread <id>`. The id is the one the lead sees for the message, `<source>:<chat>:<message id>` (as in `seori msg list`). The duty loop then posts the lane's newest report attached to that message, as `Progress (from the lane's last report): <report text>`: in its thread or topic, else as a reply to it (on Slack, which has no inline reply, in a thread under it). It posts at most every `progressEveryMin` minutes (counted from the lane's start or its last post), only when the report changed and only while the lane is working or waiting.

**It is off by default.** With no `progressEveryMin` in config.json nothing is posted; turn it on with `{"progressEveryMin": 15}` (a positive number of minutes). `null` is the one way to say off; `0` is refused as a config error, since an empty period is not a period. The switch turns only the post off: `seori report`, the `[REPORT]` line the lead gets, and the nudges work the same either way.

Before a post goes out, the home directory is shown as `~`, a path under `$SEORI_HOME` (where `secrets.json`, `messengers.json` and the lane records live) as `(state path)`, and pane ids as `<pane>`. Every other absolute path stays as the lane wrote it, because a report cites its evidence (a test log, a clone path, a PR) and hiding that would make the post useless. The post goes out through `hooks.threadReply` when that hook is set (see [Hooks](#hooks)); otherwise through the configured messenger.

A post that may or may not have arrived counts as posted and is never sent twice. A definite failure, a source with no configured messenger, or a thread id that is not of that shape is a `post-failed` duty event and is tried again on the next pass. Each post is logged on the lane, and each event names the path it took (`via hooks.threadReply` or `via messenger`).

## Messenger channel

The lead can take your requests from a messenger as well as from its terminal. Configure messengers in `$SEORI_HOME/messengers.json`:

```json
{ "messengers": [ { "source": "fake", "owner": "u1" } ] }
```

`source` picks the adapter (`telegram`, `slack`, `discord`, or `fake` for tests) and `owner` is the sender id of the one person seori works for. `seori msg pair` finds that id for you (see [Owner pairing](#owner-pairing)). Messages from bots, the bot's own included, are always dropped, and so are messages from anyone else unless the messenger has `"others": true`. Outside DMs a message reaches the lead only when it is addressed to the bot: on Slack a mention of the bot, or a reply in a thread the bot is part of (one where it has posted, or where someone it answers mentioned it; no new mention needed); on Discord every message of yours in a server channel or thread the bot can read counts as addressed, with no mention, while anyone else's needs a mention of the bot or a reply to one of its messages (`"ownerNeedsMention": true` on the Discord messenger puts you under that rule too, for a server where you also chat with other people). Any other channel chatter is never delivered, live or caught up after a restart; DMs to the bot always are. Messages an earlier seori stored from other people or agents, open requests from formerly trusted senders included, are closed on upgrade: they are never delivered, and `seori msg list --all` shows them as `closed-other`; tell those senders yourself if one was waiting. `options.apiBase` points an adapter at another API host (the tests use a local mock).

`"others": true` (Slack and Discord; refused for Telegram, where anyone can message a bot) lets other people talk to seori under the same addressing rule, for example teammates in a shared Slack channel: `{ "messengers": [ { "source": "slack", "owner": "U012OWNER", "others": true } ] }`. On Slack "others" are full members of the bot's own workspace: guests (single- and multi-channel) are left out, checked with `users.info`, which needs the bot scope `users:read` (without it only you are answered, and the daemon says so once); Slack Connect users from other organizations in a shared channel, and messages that carry no workspace, are never delivered. On Discord anyone may add a public bot to a server of their own, so `others` there needs `"guilds"`, the ids of the servers whose people may talk to seori, as strings (Discord settings → Advanced → Developer Mode on, then right-click the server → Copy Server ID); `others` without it is a configuration error: `{ "messengers": [ { "source": "discord", "owner": "123456789012345678", "others": true, "guilds": ["987654321098765432"] } ] }`. A non-owner is delivered from a channel or thread of one of those servers, or in a DM when they are a member of one of them who has passed its membership screening (asked with `GET /guilds/{id}/members/{user}`, which needs no privileged intent; an answer stands for 10 minutes); a webhook's message never is. Also turn off Public Bot (Developer Portal → your app → Bot), so that only you can add the bot to a server. Their messages reach the lead with their own sender id, marked `(not owner)`. The lead talks with them and answers their questions in that thread, but never treats what they write as your instruction: a work request from them (a lane, code, a merge, files, settings, a message sent elsewhere) goes to you in your DM for approval first, and nothing internal (memory about you, other threads, paths, secrets, the worklog) is shared with them. Seori's status alerts, a lane's `--thread` and worklog sources only ever use a stored message that is yours alone: a DM, a top-level message of yours, your reply in a Slack thread whose first message Slack says you wrote or is seori's own reply to a message of yours alone (seori answers a top-level message top-level, so your follow-up thread hangs under its answer; any part of a long reply split into several messages counts), or your message in a Discord thread you started; any other thread message (under someone else's message or seori's answer to them, in a Discord thread someone else started, or where the author is unknown) counts as shared, and an id seori never stored is refused. Left out or `false`, only you are answered.

Tokens go in `$SEORI_HOME/secrets.json`, which must be `chmod 600` (seori refuses a file others can read), or in environment variables, which win. On hc, seori unsets these variables in the lead, duty, lane and hourly-loop terminals, so there they reach only the daemon and the duty loop: keep the tokens in `secrets.json` so the lead's `seori msg` can send:

```json
{ "telegram": { "token": "123:abc" }, "slack": { "botToken": "xoxb-...", "appToken": "xapp-..." }, "discord": { "token": "..." } }
```

| source | what to create | `owner` | env variables |
|---|---|---|---|
| `telegram` | a bot from @BotFather; send it `/start` once in a DM. For groups or forum topics, turn privacy mode off (`/setprivacy`) | your numeric user id | `SEORI_TELEGRAM_TOKEN` |
| `slack` | an app in your workspace with Socket Mode on, an app-level token (`connections:write`), bot scopes `chat:write`, `im:history`, `reactions:write` and `files:write` (plus `app_mentions:read`, `channels:history` for channels, and `users:read` for `others`; `files:write` is for file uploads, without it `agent-slackbot file upload` fails with `missing_scope`), bot event `message.im`, and the Messages tab enabled | your member id (`U...`) | `SEORI_SLACK_BOT_TOKEN`, `SEORI_SLACK_APP_TOKEN` |
| `discord` | an application with a bot; enable the MESSAGE CONTENT intent (or drop it from `options.intents` to read DMs only), turn off Public Bot (needed for `others`), invite it with Add Reactions and Read Message History (seori's reactions in server channels) and Create Public Threads, Send Messages in Threads and Manage Threads (job threads), and DM the bot once | your user id | `SEORI_DISCORD_TOKEN` |

`seori msg check` asks each configured messenger who its bot is, which proves the tokens work: it prints `OK <source>: <who the bot is>` or `FAIL <source>: <why>` per messenger and exits 1 when any fails. `seori msg check <source>` checks that one source, and works before `messengers.json` has an entry for it: only its token matters.

### Owner pairing

`seori msg pair <source>` finds the owner's sender id during setup, for `telegram`, `slack`, `discord` or `fake`:

```sh
seori msg pair telegram --write
# PAIRING telegram: send the bot any direct message now (waiting up to 10 min)
# CANDIDATE telegram id=123456789 chat=123456789 text="hi"
# PAIRED telegram owner=123456789 in ~/.seori/messengers.json; a running seori daemon restarts on the change
```

- seori runs the messenger's own receive in pairing mode, where any non-bot sender's new direct message passes, and prints one `CANDIDATE` line per sender (with the first 40 characters of the text). It stops at the first sender; `--all` listens for the whole window and lists every sender. `--minutes N` sets the window (default 10).
- Pairing reads with a throwaway copy of the daemon's cursor, so it never moves the position the daemon resumes from: messages pairing passed over still reach the lead later.
- `--write` records the first sender as that source's `owner` in `messengers.json`, adding the entry (or the file) when it is missing and keeping every other entry and field. `--write` together with `--all` is refused. Check that the CANDIDATE text is what the owner sent before trusting it.
- Messages sent more than 2 minutes before pairing started, and edits, are ignored, so a stranger's old message still queued at the platform never becomes the owner.
- Pairing mode is an option only `msg pair` passes to the adapter; `messengers.json` cannot ask for it, so the daemon never accepts strangers.
- Pairing is refused while the daemon is running (a heartbeat under 30 seconds old) and the source is already in `messengers.json`, because two readers on one bot conflict (Telegram answers 409): pair before adding the entry, or stop the daemon first.
- A `telegram` entry that already names an owner is refused unless `--force`. Telegram confirms updates on its server once a later one is read, so pairing would drop the messages queued for the daemon (sent while it was stopped). Let the daemon deliver them first, or pass `--force` to pair anyway.
- No message within the window is a refusal (exit 2). Ctrl-C ends the wait early.

### Presence

`seori presence discord` keeps the Discord bot shown online until Ctrl-C or SIGTERM (exit 0), the way upstream dori does. A missing token is a refusal (exit 2) naming the `secrets.json` key. It prints `PRESENCE_READY discord` once it starts.

- Discord: the bot (`"discord": { "token": ... }` in `secrets.json`, or `SEORI_DISCORD_TOKEN`). A gateway connection identifies with status online and heartbeats. When it ends (the socket closed, or Discord sent op 7 or op 9), it prints `PRESENCE_RECONNECT discord code=<why> retry_in=<n>s` and identifies again on a new connection after a backoff that starts at 5 s, doubles up to 300 s, and is back at 5 s once a connection held for 10 minutes. Identifies are capped at 200 per rolling 24 hours (counted in `$SEORI_HOME/presence/discord-identify.json`, well under the 1,000 a day past which Discord resets the token); when the budget is spent it prints `PRESENCE_WAIT discord identify budget spent; next identify in <n>s` and waits. A rejected token (close 4004) or a refused setup (close 4010-4014) prints `PRESENCE_FAILED discord: <why>` and exits 1 instead of identifying again.

### Receiving

Each adapter keeps a cursor under `$SEORI_HOME/messenger/<source>/` and commits it only after a message is stored, so a crash replays instead of losing it:

- Telegram long-polls `getUpdates` (one program per bot token; a second one makes Telegram answer 409, which seori reports). Telegram keeps unread updates for 24 hours.
- Slack uses Socket Mode (no public URL) and acknowledges an event only after storing it. After every reconnect it reads each chat it has seen with `conversations.history` from its cursor, and with `conversations.replies` the threads that got a reply since, among those started after the cursor and its recent threads, so messages and thread replies sent while it was disconnected are not lost. The history read reaches back to the oldest recent thread (up to three pages of 200), so a parent's latest reply shows which of them need reading: a quiet recent thread costs no call, and an older thread it does not follow is never read. A chat the bot lacks the history scope for is skipped, and a socket that stops answering pings is reconnected. Slack has no inline reply, so seori answers a message where it was written: a reply in a thread in that thread, a top-level message (in a DM or a channel) top-level in the same DM or channel, never in a new thread under it. A thread someone opens under that message or under seori's answer is followed without a new mention; a new top-level message in a channel needs a new mention.
- Discord uses the gateway and resumes its session after a restart; when a session cannot be resumed it reads each chat it has seen from its cursor over REST.

An edited message reaches the lead as a new message starting with `(edited)`. Attachments are listed as `[attachment: name (type, size) ref]` lines and never downloaded, with one exception: when `hooks.transcribe` is set, a Telegram voice note is downloaded to `messenger/telegram/voice/` (and kept there), run through the hook, and its transcript follows the attachment line (see [Hooks](#hooks)). Long replies are split at the platform limit (4096, 3900 and 2000 characters) on paragraph, line or word breaks; every part goes where your message was written, and on Telegram and Discord the first part replies to your message. A reply that fails after its first part went out is recorded as uncertain, like any send that may have arrived.

The `fake` adapter is made of files under `$SEORI_HOME/messenger/fake/`: append a line `{"msgId":"1","chat":"c1","from":"u1","text":"..."}` to `in.jsonl` to send the lead a message, read the replies in `out.jsonl`, and write `ok`, `timeout` or `error` to `send-mode` to make sends succeed, end uncertain, or fail.

How a message travels:

1. The daemon (a systemd unit on Linux, an hc terminal of `seori up` on macOS) receives it and, if it is from the owner (or, with `others`, from someone else), stores it in `$SEORI_HOME/lead/` (synced to disk) before acknowledging it to the messenger. A message received twice is stored once. The daemon writes a heartbeat every few seconds; `seori daemon-loop` restarts it, so a crashed daemon is back within about a second (on Linux systemd restarts the loop itself if it fails). When `messengers.json` changes (created, edited or removed), the daemon exits and the loop starts it again with the new file, so you can configure messengers after `seori up`. A `messengers.json` that cannot be read is logged in that pane and the daemon runs without messengers (heartbeat and watches keep going) until the file changes. Ctrl-C in that pane (status 130), or `kill` of the daemon process (143), stops the daemon and the loop. SIGHUP (129, also what closing the pane sends) stops the daemon cleanly, its watch commands included; the loop starts it again if the loop is still running. Only one daemon runs per `$SEORI_HOME` (`messenger/daemon.lock`).
2. The lead's omp loads `extensions/lead-channel.ts` (only the lead: duty, lanes and the reviewer never load it). It delivers each stored message into the lead's conversation with its id, and records each delivery in a ledger next to it. A message stays open across an agent restart, `/new`, `/resume` or `/fork`.
3. The lead answers with `seori msg send --reply-to <id> --text '...'`, or `seori msg close <id> --why '...'` when no answer is needed. The reply goes out at once, as soon as the lead has written it. Only a reply the messenger accepted, or a close, ends an id. A second reply to the same id is refused unless it passes `--again`; a reply that may or may not have arrived (a timeout after sending) is recorded and not retried until you check the chat and pass `--again`.
4. An id that is still unanswered is delivered again, up to 3 deliveries in total; after that it is given up. Only a reply the messenger accepted, or a close, answers an id, so it is not delivered again.
5. The lead's omp runs omp's advisor, which is opt-in and off by default; seori turns it on for its own lead (`advisor.enabled: true` in `$SEORI_HOME/prompts/lead-omp.yml`). The lead does not wait for it: the reply is already out when the advisor reviews the turn, and when it raises a concern the lead sends the correction at once as its own message with `--again`.

### Reactions

seori shows on the message itself where it stands. The moment the daemon has stored a message for the lead, it puts the eyes reaction on it; messages it drops get none, and a message received again, or an edit of a message already stored, gets no second one. When the lead answers, the eyes are replaced by a check mark: a reply with `seori msg send --reply-to`, or `seori msg close`. A job's first reply is only its acknowledgement (the status message the lead keeps editing), so the lead sends it with `--ack`, which leaves the eyes in place; the job's result reply (`--again`, without `--ack`) sets the check mark. Editing a message never changes a reaction.

| platform | eyes | check mark | needs |
|---|---|---|---|
| Slack | `eyes` | `white_check_mark` (added, then the eyes removed) | bot scope `reactions:write` |
| Discord | 👀 | ✅ (added, then the eyes removed) | Add Reactions and Read Message History in server channels |
| Telegram | 👀 | 👌, replacing the eyes: ✅ is not among Telegram's allowed reactions | nothing more |

A reaction that fails (a missing scope or permission, a rate limit) is logged, in the daemon's log for the eyes and on stderr of `seori msg` for the check mark, and never holds up the message or the reply.

### Discord job threads

On Discord, the lead's first `--ack` to a message written in a server channel (not in a thread or a DM) makes seori open a thread on that message, named "🔄 <title>" (`--title`, else the ack's first line, cut to 100 characters), and post the ack there; the `SENT` line ends with `thread=<id>`. Every later reply and `msg edit --reply-of` for that id, and seori's own progress posts about it, go into the thread. The lead renames it as the job moves with `seori msg thread <id> --status working|waiting|done` (🔄, ⏸, ✅) and archives it when done with `--archive`; the same command without `--archive` reopens an archived thread. A thread hides on its own after a week without messages. If Discord refuses the thread (a missing Create Public Threads permission), seori warns on stderr and the ack goes where the message was written, as before. Slack and Telegram keep answering in place.

### Corrections

A correction is an ordinary second reply to the same id: `seori msg send --reply-to <id> --again --text '...'`. The lead sends it the moment it is written, so the owner gets the answer first and the corrected text as its own message, instead of the answer arriving late because it was held back.

The duty loop watches the channel when a messenger is configured. It tells the lead once when `messengers.json` cannot be read (the daemon then receives no messengers until it is fixed), once when the daemon's heartbeat is older than 90 seconds, and once when a messenger has not been able to receive for 3 minutes (a rejected token, a second program on the same Telegram bot, a missing Discord intent, or the platform not answering for 2 minutes), with the adapter's error. The daemon writes `messenger/<source>/health.json` while receive keeps failing, restarts a failing messenger less and less often (5 seconds doubling up to 10 minutes, so a setup error does not burn Discord's daily identify limit), and removes the file once a message gets through or a run stays up 3 minutes; editing `messengers.json` starts a fresh attempt. It tells you in the chat, once per message and attached to that message like a progress post, when the lead is offline (no lead agent consuming) or stuck for more than 2 minutes (the runtime reports it blocked: a question in its terminal, or a turn that ended in a model error), or when it gave up on a message after 3 tries. A message whose reply may already have arrived (send-uncertain), or that was given up, gets no offline or stuck notice: it is never delivered again.

## Watches

An agent that waits on something outside its terminal (CI, a dev server, a file, another session) arms a watch instead of polling or sleeping, and ends its turn. The daemon watches for it and wakes it when something happens.

```sh
seori watch add --checks owner/repo#12 --name ci
# WATCH wmhk2x1a0b ci for fix-flaky-login until 2026-11-07T14:00:00.000Z
seori watch add --command 'bun run dev' --filter 'error|ready' --name dev
seori watch list
seori watch stop dev
```

Kinds:

- `--command CMD [--filter RE] [--cwd DIR]`: a long-running shell command. Each output line matching the regex (every line without `--filter`) is an event; lines arriving together become one event (at most 40 lines per event; a line longer than 64 KiB is cut). A command that exits 0 ends the watch as done. One that crashes (non-zero exit or a signal) is restarted with backoff up to 3 times in a row, then the watch is stopped; a run that lasted longer than the last backoff resets that count. If the daemon itself died without cleaning up, the restarted daemon kills the command it left behind before starting it again.
- `--file PATH`: a file or directory; every change (created, modified, deleted) is an event, including one made while the daemon was down. A directory is checked as a whole tree (newest change, total size and entry count; up to 10,000 entries and 8 levels deep, symlinks not followed).
- `--checks OWNER/REPO#N`: a PR's checks; one event when every check has finished (pass or fail), then the watch is done.
- `--pane PANE --status idle|working|blocked|gone`: a session's agent state (`hc:tN`); one event when it gets there (`idle` also matches `done`), then the watch is done.

A muted watch only counts what it misses, and each watch's event log is kept to about 1 MiB (the older part moves to `<id>.events.jsonl.1`).

Owner: the watch wakes the lane in `SEORI_LANE` (set in every lane's pane) or, outside a lane, the lead. `--for lead` or `--for <lane key>` picks another owner. Any agent may arm a watch; there are no confirmations. Every event starts with `[watch <name> <id>]` and needs no reply. The lead gets it through its channel (delivered even mid-turn) as a row of kind `watch` with id `watch:<watch id>:<n>`, closed automatically once seen; `seori msg list --all` shows it next to messenger messages, and `seori msg send --reply-to` refuses a watch id. A lane gets it in its pane, mid-turn like any lane message. A lane's watches stop when the lane closes.

Limits:

- A watch lives 2 hours; `--timeout` sets 1 second to 24 hours.
- `--persistent` keeps it 7 days instead, at most 5 per owner (a 6th is refused).
- Wake budget: after 6 events within an hour the watch is muted. It keeps counting events without delivering them; `seori watch rearm` unmutes it, resets the budget and says how many events were missed. The count is saved every 30 seconds, so a rearm within half a minute of the last events reports fewer than were missed.
- Refusals (a timeout over 24 hours, a 6th persistent watch, a bad `--filter` regex, a name already in use) exit 2.

`seori watch list` shows each watch's id, name, owner, status, what it watches, age, time left, wakes in the last hour and muted events; `seori watch log <id|name> [-n N]` shows the last N (default 20) things it saw and delivered. `stop`, `rearm` and `log` look a name up only among the live watches of the owner `add` would pick (`--for`, else `SEORI_LANE`, else the lead), so two lanes can each have a watch named `ci`; when several of that owner's watches share the name (unnamed watches are named after their kind) they are refused with their ids. An id works for any owner's watch.

Watches cover the usual sources with coalescing, a wake budget and up to 5 standing watches for 7 days. They live in seori, one file each under `$SEORI_HOME/watches/`, not in the agent's session. They survive `/new`, an agent restart and a daemon restart (the restarted daemon resumes them), `seori watch list` shows them all in one place, a crashed command is restarted on its own, and PR checks and session state are watch kinds of their own.

## Workflows

A lane runs in omp goal mode: its kickoff is `/goal Read your brief at ...`. A host that has the optional [omp-ulw](https://github.com/dbc-hbin/omp-ulw) extension can run a lane under one of its workflows instead: `seori start --workflow <W>` (or `"workflow": "<W>"` in config.json for every lane) makes the kickoff `/goal <W> <keyword> Read your brief at ...`. omp still holds the lane's native goal, so the startup verdict, `seori pause` and `seori resume` work as before. `--workflow none` starts one lane in plain goal mode whatever the config says.

| `--workflow` | kickoff starts with | for |
|---|---|---|
| `ulw` | `/goal ulw` | normal work, driven to the end with evidence |
| `mass-ulw` | `/goal mass-ulw workflowz` | work with a dependency graph of parallel tasks |
| `ulw-research` | `/goal ulw-research workflowz` | research with a cited result |
| `ulw-plan` | `/goal ulw-plan ultrathink` | a reviewed plan only, no code |
| `ulw-loop` | `/goal ulw-loop orchestrate` | a durable loop over several goals |
| `ulw-execute` | `/goal ulw-execute orchestrate` | carrying out an approved plan |

The keyword turns on the omp mode the workflow's own command (`/mass-ulw` and the like) would turn on; seori never sends those commands, because they run without omp's goal and seori could not track the lane. Each workflow keeps its own state files and closes the goal when they say it is done.

`ulw-plan` is the exception: it closes its goal once the reviewed plan is written, while the plan still waits for the owner's approval. Its READY means "plan delivered, approval needed": the lead shows the plan to the owner and asks before any `ulw-execute`.

Before it opens a pane, `seori start` checks `omp plugin list --json` and refuses `--workflow` when omp-ulw is not enabled, so a lane never gets a goal that starts with a word nothing understands. omp-ulw is a separate install that seori never bundles or installs; see the seori-mode skill's `references/setup.md`.

## Configuration (config.json)

`$SEORI_HOME/config.json` is optional, and so is every field in it; a missing file means every default. With every default written out:

```json
{
  "name": "seori",
  "repoIdentities": {},
  "closeAfterMin": 5,
  "progressEveryMin": null,
  "blockedPromptMin": 10,
  "startupWaitSeconds": 180,
  "supervision": { "defaults": { "wallMinutes": null, "tokens": null, "costUsd": null }, "hungAfterMin": 20, "activityPaths": [] },
  "guard": { "loadAlertPct": 150, "loadOkPct": 80, "memFreeMinPct": 10, "diskFreeMinGb": 20, "panesMax": 30 },
  "heavy": { "slots": 1, "maxLoadPct": 80 }
}
```

`"agent"` may only be `"omp"`, and any other value is refused; `hooks` is described under [Hooks](#hooks). A `"runtime": "hc"` left from an older seori is ignored; any other `"runtime"` is refused, since seori runs on hc only.

| field | default | meaning |
|---|---|---|
| `name` | `"seori"` | this instance's name: the `seori.group` label of its hc terminals; also part of the systemd unit names. 1-40 letters (any script), digits, `.`, `_` or `-`, starting with a letter or digit. Give every instance on a PC its own; see [Several instances on one PC](#several-instances-on-one-pc) |
| `repoIdentities` | `{}` | `"owner/repo": { "name": "...", "email": "..." }`: the Git identity a repo's commits must carry; verify-pr and the merge gate check the email. Repo keys match without case. A repo with no entry is not identity-checked |
| `closeAfterMin` | `5` | minutes after READY that a lane with a Done line closes on its own, unless the lead objects |
| `progressEveryMin` | `null` | a lane with `--thread` gets its newest report posted at most this often (minutes); `null` is off, `0` is refused |
| `blockedPromptMin` | `10` | minutes a lane's pane may show a dialog (`blocked`) before the lead gets one `[BLOCKED-PROMPT <key>]`; fractions work (`0.5` is 30 s) |
| `workflow` | unset | every lane's workflow unless `seori start --workflow` says otherwise: `"ulw"`, `"mass-ulw"`, `"ulw-research"`, `"ulw-plan"`, `"ulw-loop"` or `"ulw-execute"` runs lanes under that omp-ulw workflow; unset is plain omp goal mode. See [Workflows](#workflows) |
| `defaultCwd` | unset | where a lane starts when `seori start`, `seori backlog add` or `seori backlog import` gets no `--cwd` (so also the hourly loop's items): an absolute path, or `~/...` for one under your home. Unset: the folder the command runs in, which for the lead is the folder `seori up` opened it in (`$SEORI_HOME` unless `--cwd`) |
| `startupWaitSeconds` | `180` | how long `seori start` watches a new lane for a startup verdict (first check 20 s after the kickoff, then every 10 s); see [How a lane starts](#how-a-lane-starts) |
| `supervision.defaults.wallMinutes` | `null` | wall-clock ceiling per lane, in minutes; `null` is off |
| `supervision.defaults.tokens` | `null` | token ceiling per lane; `null` is off |
| `supervision.defaults.costUsd` | `null` | cost ceiling per lane, in US dollars; `null` is off |
| `supervision.hungAfterMin` | `20` | minutes with no report and no file change before a working lane is reported stalled |
| `supervision.activityPaths` | `[]` | files or directories (relative to each lane's working directory: its worktree when it has one, else its cwd) whose change counts as every lane's progress (a directory: an entry added, removed or renamed) |
| `guard.loadAlertPct` | `150` | 1-minute load per core (%) above which the guard alerts |
| `guard.loadOkPct` | `80` | load per core (%) it must fall under to clear |
| `guard.memFreeMinPct` | `10` | free memory (%) under which new lanes are held and the guard alerts |
| `guard.diskFreeMinGb` | `20` | free disk (GB) on the volumes lanes work on (open lane directories, else `$HOME`) under which new lanes are held and the guard alerts |
| `guard.panesMax` | `30` | more live sessions than this holds new lanes and the guard alerts |
| `heavy.slots` | `1` | how many `seori heavy` commands may run at once |
| `heavy.maxLoadPct` | `80` | load per core (%) a heavy command waits to fall under |

A malformed field is an error naming it, never a silent default, so a typo cannot switch a ceiling off without anyone noticing:

- a file that is not valid JSON, or not a JSON object, is an error;
- an unknown field at the top level or inside `supervision`, `supervision.defaults`, `guard` or `heavy` is an error naming the field and the known ones (`talkWithOthers`, `agentTurnLimit` and `trusted`, left from a removed feature, are accepted and ignored);
- `repoIdentities`, `supervision`, `supervision.defaults`, `guard` and `heavy` must be objects, and each `repoIdentities` entry needs a nonempty `name` and `email`;
- every number must be finite and not negative; a ceiling is such a number or `null`; `heavy.slots` must be a whole number of at least 1;
- `name` must match the rule in the table;

The commands that read the config (`start`, `ready` for a lane with a Done line, `merge`, `verify-pr`, `can-launch`, `guard`, `heavy`) exit 2 with the error. In the duty loop, each part that needs it reports it as an event (`autoclose-failed`, `supervise-failed`, `guard-failed`, `progress-failed`) and the rest of the pass goes on; `seori boot` shows `CONFIG invalid`. The file is read on every command and duty pass, so a change takes effect without a restart.

### Hooks

`hooks` in config.json takes argv templates (a non-empty array of strings; element 0 is the command, nothing is shell-expanded). Placeholders `{key}`, `{text}`, `{evidence}`, `{file}`, `{tokens}`, `{cost}`, `{closeKey}`, `{thread}` are substituted inside each element.

| hook | runs | placeholders |
|---|---|---|
| `onReport` | after `seori report` saved the lane | `key`, `text` |
| `onReady` | after `seori ready` saved the lane | `key`, `text`, `evidence` |
| `onLost` | when duty or supervision marks a lane lost | `key`, `text` |
| `recordCost` | once when a lane closes and its tokens or cost could be read (see Cost record) | `key`, `tokens`, `cost`, `closeKey` |
| `transcribe` | turns an audio file into text: `seori transcribe <file>`, and Telegram voice notes | `file` |
| `threadReply` | posts a lane's progress into its thread, in place of the built-in messenger send (see Progress posts) | `thread`, `text`, `key` |

The lifecycle hooks are fire-and-forget: a failure prints one `seori: hook <name> failed (...)` line on stderr and never changes the command's result; the CLI waits at most 2 s for hooks still running at exit. No hook replaces the reviewer: `seori review` always runs omp, and a `hooks.reviewCommand` key is refused. `transcribe` and `threadReply` run in the foreground and must exit 0: `transcribe` prints the transcript on stdout, and a `threadReply` that exits non-zero (or runs past 30 s, when it is killed) posts nothing, so the next duty pass tries the same report again and the event is `post-failed` with `hooks.threadReply: <the hook's first error line>` (`hooks.threadReply: timed out after 30 s` for a killed one). When `transcribe` is not set a voice note stays a plain attachment line; when `threadReply` is not set, progress posts go through the configured messenger. A malformed `hooks` value is a config error (exit 2).

```json
{ "hooks": { "transcribe": ["whisper-cli", "-f", "{file}", "--no-timestamps"], "threadReply": ["/path/to/thread-reply", "{thread}", "{text}"] } }
```

`{thread}` is the lane's whole thread id, `<source>:<chat>:<message id>`, so a `threadReply` command is usually a small wrapper script that splits it into the chat and message id its sender takes. Have the script `exec` its sender as the last step: the 30 s kill reaches only the process seori started, so a sender left running as a child of the script outlives it.

## seori mode skill

`skills/seori-mode/` is an agent skill that sets seori up and sums up how the lead works. The agent loads it when you say `seori mode`, `서리 모드`, or "<name> mode" for the name you gave seori. It is written in English and talks to you in your language. The steps are in `references/`: `setup.md`, `messengers.md`, `onboarding.md` and `writing.md`.

`install.sh` (the one-liner in [Quick start with seori mode](#quick-start-with-seori-mode)) needs git and Bun 1.3 or newer. It:

- clones the repository into `~/.seori/src` (`SEORI_SRC` picks another place: point it at the clone you develop in), or fast-forwards an existing checkout. A checkout with local work *and* commits upstream it does not have is not pulled: it lists the edits and unpushed commits, then stops with exit 1 and names the three ways out (`SEORI_NO_PULL=1 bash <script>` installs it as it is, `git pull --rebase --autostash` keeps the work, `git reset --hard` drops it). With nothing waiting upstream the reinstall goes through, and untracked files are never local work. See [Working on seori itself](#working-on-seori-itself);
- runs `bun install` and `bun link`, which puts `seori` on PATH through Bun's global bin directory;
- links the skill to `~/.omp/agent/skills/seori-mode` (`SKILLS_DIR` picks another place) with `seori install-skill`: a symlink; an older link or seori copy is replaced, and a real directory already there is left alone, with a warning;
- creates `~/.seori` (or `$SEORI_HOME`) with mode 700;
- warns when hc is missing, when hc's `config.toml` lacks `notes = false`, when omp, gh or `seori` on PATH is missing, and on Linux when `systemctl` is missing.

It never installs hc, omp or gh, never edits hc's config, and never creates or overwrites `secrets.json`, `messengers.json` or `config.json`.

To uninstall, run `seori down` (it stops the processes, removes the systemd units and closes the group's terminals), then `seori uninstall` (or `bash install.sh --uninstall`). It removes the skill link (or seori's own copy) and runs `bun unlink` for the `seori` command, and keeps `~/.seori` with your secrets and history unless you add `--purge`.

## State

JSON and JSONL files on disk under `~/.seori` (or `$SEORI_HOME`): `lanes/`, `inbox/`, `briefs/`, `receipts/`, `backlog/` and `loop/` for the hourly loop, `duty/` for the duty loop's stop file, the host guard state (`duty/guard.json`), the stall history (`duty/supervision.json`) and the pane-health spells (`duty/panes.json`), `lead/` for the lead channel (stored messenger messages, watch events for the lead, and their ledger), `messenger/` for the daemon's lock and heartbeat and each messenger's cursor and health file (and the fake messenger), `watches/` for the watches and their event logs, `checkpoints/` for each lane's checkpoint journal (`<key>.jsonl`), `heavy/` for the heavy slot locks (`<n>.lock`), `lessons.jsonl`, `worklog.jsonl` and the `worklog.md` rendered from it, `config.json`, `messengers.json`, and `secrets.json` (mode 600). Besides the omp sessions, the only long-running processes are the duty loop, the hourly loop and the daemon (with the commands of command watches). The only runtime dependency is Bun.

## Several instances on one PC

Each seori is one `$SEORI_HOME`. Its lanes, messages, daemon, loops, watches, worklog, secrets and messenger bot all live there, so two homes never see each other's state. To keep them apart in the runtime and the agent too:

- **Name.** `name` in the home's `config.json` is its `seori.group` label on hc and part of its systemd unit names. The first instance needs nothing (the default is `seori`); give every other one its own name.
- **Agent memory.** omp's memory is one database per machine, so every home other than `~/.seori` gets `mnemopi.dbPath` set to `$SEORI_HOME/omp/memories/mnemopi.db` in its `prompts/agent-omp.yml`, and `~/.seori` keeps omp's own database.
- **Once per home.** `seori up` in a home whose lead and duty panes are already live prints `ALREADY UP name=... home=... lead=hc:tN running=...; nothing opened` and exits 0. A home that lost a pane while the rest of it kept running gets the missing panes back (`REOPENED ...`), and a second `seori up` while one is opening the home prints `UP BUSY ...` and opens nothing; nothing of the home is ever opened twice. Stop one instance with `seori down` under that home's `SEORI_HOME`; the others keep running.

To add a second instance (here called `seori-two` in `~/seori-two`):

1. Make the home and name it:
   ```sh
   export SEORI_HOME=~/seori-two
   mkdir -m 700 "$SEORI_HOME"
   echo '{ "name": "seori-two" }' > "$SEORI_HOME/config.json"
   ```
2. Give it its own bot. Create a new bot or app for it ([messengers.md](skills/seori-mode/references/messengers.md)): one bot can't serve two daemons. Write its tokens into `$SEORI_HOME/secrets.json`, then, in the same shell, `seori msg check <source>` and `seori msg pair <source> --write`. Don't set `SEORI_*_TOKEN` variables for your whole account: they override every home's `secrets.json`.
3. Start it: `seori up --cwd ~/src` in that shell. Its terminals carry `seori.group=seori-two` and its units are named `seori-seori-two-<hash>-*`, where `<hash>` is 8 hex digits of the home's path, so two homes never share units. `seori down` also removes this home's units of the older `seori-<name>-*` naming.
4. Autostart. On Linux the units are enabled, so the daemon and loops come back on their own after a reboot, but the lead and duty panes do not: install the logon hook once, in that home's shell, with `seori autostart install --cwd ~/src` (a `systemd --user` oneshot running `seori up --wait-hc --cwd ~/src`, named `seori-seori-two-<hash>-boot.service`). From then on a reboot brings the panes back by itself, in the same cwd as step 3. The hook does not depend on something else having started hc: it polls `hc server status`, which on hc 0.1.20 starts a core on demand, and runs `hc server start` once if a poll still finds none. Where even that cannot bring a core up, it reports `HC UNAVAILABLE` in the journal with hc's own reason and opens nothing, so check `systemctl --user status` and `hc server status` there. `seori down all` removes the hook with the rest; `seori restart` keeps it. On macOS, put `seori up --wait-hc --cwd ~/src` in a login item; it waits for hc and starts it the same way rather than failing when hc is late.

Every `seori` command acts on the home in `SEORI_HOME`, so set it in each shell you use for that instance. Sessions and units that seori starts already have it.

## Environment

| variable | meaning |
|---|---|
| `SEORI_HOME` | state directory, default `~/.seori`; one per instance ([Several instances on one PC](#several-instances-on-one-pc)) |
| `SEORI_PROMPTS_DIR` | directory the reviewer prompt and the lead/duty/lane prompts are read from instead of the repo's `prompts/` (the rendered copies still go to `$SEORI_HOME/prompts`) |
| `SEORI_AGENT` | may only be `omp` (the default); any other value, here or as `"agent"` in `config.json`, refuses every command with exit 2 |
| `SEORI_AGENT_CMD` | the command seori runs for omp (lead, duty, lanes and the reviewer); default `omp`. Its basename must be `omp` (a path to omp or a wrapper named omp); anything else refuses every command with exit 2 |
| `SEORI_MODEL` | model for every agent seori starts (`--model`) except a lane started with `seori start --model M`, and the reviewer's default model; unset = the agent's default |
| `SEORI_CMD` | how the agents and loops call seori, default `SEORI_HOME=<home> [SEORI_MODEL=...] bun <path>/src/cli.ts` |
| `SEORI_SH` | the sh that runs watch commands, default `sh` on PATH |
| `HC_SESSION`, `HC_SOCKET`, `XDG_RUNTIME_DIR` | which hc core seori talks to (hc's own variables); `seori up` passes them on to its systemd units |
| `SEORI_SYSTEMD_DIR`, `SEORI_SYSTEMCTL` | where `seori up` writes its unit files (default `${XDG_CONFIG_HOME:-~/.config}/systemd/user`) and the systemctl it runs (default `systemctl`); the tests point both at fakes |
| `SEORI_MAX_LANES` | default for `seori loop --max-lanes` (3) |
| `SEORI_MAX_STARTS` | default for `seori loop --max-starts` (2) |
| `SEORI_MAX_LOAD` | default for `seori loop --max-load` |
| `SEORI_LANE` | set by seori in a lane's terminal; the default sender of `seori send` and the default owner of `seori watch add` |
| `PI_CONFIG_FILES` | omp only: omp settings files; seori appends `$SEORI_HOME/prompts/agent-omp.yml` (`startup.setupWizard: false`) for the lead, duty and lane omp, so an omp whose setup version is behind still starts at its prompt instead of the onboarding wizard (log in to a provider with `omp login` first), and `$SEORI_HOME/prompts/lead-omp.yml` (`advisor.enabled: true` and `advisor.syncBacklog: strict`; omp's advisor is opt-in and off by default and the lead turns it on for itself) for the lead's omp only. In a home other than `~/.seori`, `agent-omp.yml` also sets `mnemopi.dbPath` to `$SEORI_HOME/omp/memories/mnemopi.db` |
| `SEORI_TELEGRAM_TOKEN`, `SEORI_SLACK_BOT_TOKEN`, `SEORI_SLACK_APP_TOKEN`, `SEORI_DISCORD_TOKEN` | messenger tokens; override `secrets.json` (not in the lead, duty, lane or hourly-loop terminals) |

## Working on seori itself

Running the checkout you edit *is* the install: `seori` on PATH is a link into the checkout, the same way `npm link`, `pip install -e` or `cargo install --path` work. `install.sh` sets that up, so there is one tree to edit and nothing to reinstall after an edit. What must stay apart is the checkout, the state and your personal settings:

| | lives in | in git? |
|---|---|---|
| the checkout you edit, branch and open PRs from | a clone outside `SEORI_HOME`, e.g. `~/src/agent-seori` | it is the repository |
| state: lanes, inbox, worklog, `config.json`, `secrets.json`, `messengers.json` | `$SEORI_HOME` (`~/.seori`), mode 700 | no, and the repository's `.gitignore` lists `.seori/` |
| tone and persona | `~/.omp/agent/AGENTS.md`, which omp injects into every session of yours | no |

No personal setting is stored in a tracked file: `config.json` and `AGENTS.md` are user-level overrides documented here, not defaults. (`install.sh` does read one host-personal file, hc's `config.toml`, to warn when its `notes = false` line is missing; it never writes it.)

**The clone.** Clone anywhere outside `SEORI_HOME` and install from it, so the `seori` on PATH and the skill link point at the clone you edit:

```sh
git clone https://github.com/useonmn/agent-seori.git ~/src/agent-seori
cd ~/src/agent-seori
SEORI_SRC=~/src/agent-seori bash install.sh   # `seori` on PATH and the skill link, both pointing at this clone
bun test && bun run typecheck                 # the same two commands CI runs
```

One copy, two roles: it is both the running install and the checkout you develop in, which is what `SEORI_SRC` is for. If you would rather keep a read-only install copy, leave `install.sh` on its default (`~/.seori/src`) and develop in a separate clone, installing it with `SEORI_SRC=<clone> bash install.sh` when you want the CLI to run your code. Both work; pick one and keep `SEORI_SRC` the same in every shell, since it decides which tree `seori` resolves to (check with `readlink -f "$(command -v seori)"`).

**While you develop.** When a checkout has local work *and* upstream has commits it does not, `install.sh` will not pull: it lists the edits and the unpushed commits, names the three ways out, and stops with exit 1. That is the case worth catching, because a clean fast-forward would otherwise slip upstream in under edits you meant to run as they are. With nothing waiting upstream a reinstall still goes through, so running it while you have edits is harmless. The three ways out are printed as ready-to-paste commands that reproduce the install that refused: every path in them is shell-escaped, they name the script's own file (or `bash <(curl -fsSL …/install.sh)` when it came through a pipe or a redirect, which fetches the script from main again and says so), and they carry the resolved `SEORI_SRC`, `SEORI_HOME`, `SKILLS_DIR`, and `HOME`/`BUN_INSTALL` wherever those differ from their defaults. That matters twice over: without `SEORI_SRC` a remedy installs the *default* checkout instead of the one you are editing, and without `HOME`/`BUN_INSTALL` a remedy produced in a throwaway install repoints the machine-wide `seori` when pasted in your normal shell. The two git ways end with that same install without `SEORI_NO_PULL=1`, so it checks the tree again and refuses one an autostash left in conflict. Untracked files (a test log, say) are not local work and never stop an update. Pull by hand when you want upstream, with the edits stashed and restored around it: `git -C ~/src/agent-seori pull --rebase --autostash` (plain `pull --rebase` refuses the uncommitted edits that caused the refusal; if the autostash stops on a conflict, resolve and commit before installing again).

Running `install.sh` (or plainly `bun link`) from *any* checkout with your real `HOME` and `BUN_INSTALL` repoints the machine-wide `seori` at that checkout, because that is exactly what linking means: do it in a throwaway tree and the `seori` on your PATH starts running that tree, or stops resolving when the tree is deleted. A throwaway install therefore sets `HOME`, `BUN_INSTALL`, `SEORI_HOME` and `SKILLS_DIR` inside its own temp directory.

**Where tests run.** `bun test` and `bun run typecheck` from the clone; they need no model, no hc and no `SEORI_HOME`. The repository's `.gitignore` lists `.seori/`, so a state home at the default name inside a checkout stays out of git; a home with another name inside one would not, so keep it outside the checkout or add your own ignore rule.

**Lanes that work on seori.** A lane is never opened in the install checkout. Start it with `--cwd` set to the install checkout (or a folder in it) and seori gives it its own worktree at `$SEORI_HOME/work/<key>` on branch `<key>` from `origin/main` (see [How a lane starts](#how-a-lane-starts)). Lanes used to be started there and told to make a worktree themselves; an edit made before the `cd`, or through a relative path, then landed uncommitted in the code seori runs, and a later `git pull --ff-only` of the install would fail or mix those edits in. Every lane's rules footer also names the install checkout and forbids editing, committing, switching branches or pulling there; a lane with a worktree is told its path and branch.
The close check and `seori boot` also watch the install checkout itself, so an edit that lands there anyway is caught before such a lane closes (see [Done lines and auto-close](#done-lines-and-auto-close) and [Boot](#boot)).

## Testing

```sh
bun test         # unit tests against a fake hc, a fake systemctl and a fake gh; no model is called
bun run typecheck
```

GitHub Actions runs both on Ubuntu and macOS for every push and pull request (`.github/workflows/ci.yml`), plus an `e2e-hc` job on Ubuntu.

The hc end-to-end tests (`test/e2e-hc.test.ts`, `test/e2e-hc-cli.test.ts`) start their own isolated hc core and need `SEORI_E2E_HC=1` and hc on PATH; they call no model. See [docs/runtime.md](docs/runtime.md#testing-against-an-isolated-hc-core).

The real-omp end-to-end tests drive a real omp lead and real omp lanes on their own isolated hc core: the lead channel with the fake messenger (`test/e2e-hc-channel.test.ts`), watches (`test/e2e-hc-watch.test.ts`) and lanes with the hourly loop (`test/e2e-hc-lanes.test.ts`). They call a model, so they cost money and CI does not run them. They need Linux, hc and omp on PATH (omp logged in to a provider) and both opt-in variables; `SEORI_E2E_MODEL` picks the model (omp's default when unset) and `SEORI_E2E_ONLY=1,4,8` runs only those scenarios of the channel and watch files. They use a throwaway `SEORI_HOME` and a fake systemctl that runs the units as plain processes, and leave omp's own settings alone:

```sh
SEORI_E2E_HC=1 SEORI_E2E_OMP=1 bun test test/e2e-hc-channel.test.ts test/e2e-hc-watch.test.ts test/e2e-hc-lanes.test.ts --timeout 1800000
```

## Telemetry

None. seori sends nothing anywhere.

## Differences from dori-superagent

- Runtime: hc only. Sessions are grouped by the `seori.group` label (dori uses its own key), so seori and dori never claim each other's terminals.
- Agent: omp only. Any other agent value is refused.
- Linux runs the daemon and loops as `systemd --user` units; macOS keeps them in hc terminals.
- The duty loop also does what Dori mode's `dead-panes` monitor does: a lane or duty pane whose agent left it is told as `[DEAD ...]`, and an unowned agent session as `[UNREGISTERED ...]`.
- Lanes start with a `/goal` kickoff, so each lane runs in goal mode. Briefs carry an observable exit condition.
- The reviewer is a non-interactive agent run isolated from the repository's AGENTS.md, skills, rules and extensions.
- No telemetry.
- Names: command `seori`, state `~/.seori`, environment `SEORI_*`.
- The done claim is the lane's READY with its evidence; there is no separate claim command. For a lane with a Done line, seori closes it `closeAfterMin` after READY once every signal reads back live and no tracked work is uncommitted or unpushed.
- `seori merge` runs verify-pr after the review receipt and the checks, so commit identities and the fix-needs-a-test rule are part of the merge gate.
- A repository with no `repoIdentities` entry has its commit identities skipped, and the output says so; it is not a failure.
- A host figure that cannot be read (disk, sessions) holds no lane and raises no alert.
- The owner is paired with `seori msg pair`, from the sender of the next direct message to the bot.
- Slack runs as a bot app in Socket Mode (bot token only); an entry left from the removed user-token mode (`options.mode: "user"`, or `userToken`/`cookie` in `secrets.json` with no `botToken`) is refused with a message saying so.
- Voice: Telegram voice notes are transcribed only when you set `hooks.transcribe`.
- The seori mode skill (`skills/seori-mode`) takes the place of Dori mode.

## License

MIT. See [LICENSE](LICENSE). Some files contain code adapted from dori-superagent under the Sustainable Use License; [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists them.
