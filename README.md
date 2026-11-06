# seori (서리)

A multi-session coding-agent harness running on [omp](https://github.com/can1357/oh-my-pi) and [herdr](https://github.com/herdrdev/herdr).

English | [한국어](README.ko.md)

seori's design is based on [dori-superagent](https://github.com/sisyphuslabs/dori-superagent). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What it is

One lead session talks to you. Each task runs as a lane: its own omp session in its own herdr tab, started from a written brief in omp goal mode and finished with a READY that must carry evidence. A duty loop nudges lanes that go quiet, escalates to the lead, and holds messages for a busy lead or duty pane until it can read them. An hourly loop starts the next backlog item when a lane slot is free. Merges pass through a gate that requires a CLEAR review receipt at the exact head plus green checks.

Roles:

- Lead: an omp session with `prompts/lead.md` appended to its system prompt. The only session that talks to you. It writes briefs, opens lanes, reads what they send back, and merges.
- Lane: an omp session in its own herdr tab, one per task, with the brief and the lane rules (`prompts/lane-footer.md`).
- Duty: an omp session with `prompts/duty.md`, next to the duty loop process (`seori duty`), which flushes inboxes, nudges lanes that stop reporting, escalates and detects lost lanes.
- Hourly loop: `seori loop`, a process that syncs the backlog, audits missed work, starts the next item and asks open questions through the lead. Design: [docs/hourly-loop.md](docs/hourly-loop.md).

herdr provides the workspaces, tabs and panes, and reports each omp session's state (idle, working, blocked) over its CLI. seori reads that state before it does anything to a pane.

## Requirements

- Bun 1.3 or newer.
- herdr 0.9.5 or newer, with its omp integration installed: `herdr integration install omp`. This is required. Without it herdr reports omp as idle at all times, so seori could not tell a busy lane from an idle one, and it refuses to start lanes. Check it with `herdr integration status` (the `omp:` line must not say `not installed`).
- omp (oh-my-pi), the `omp` binary on PATH.
- The GitHub CLI `gh`, for PR head SHAs, checks, reviews and the merge.

## Quick start

```sh
bun install
bun link   # puts `seori` on your PATH; or write `bun src/cli.ts` wherever `seori` appears below
```

Start herdr, then from a shell:

```sh
seori up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.seori
```

That opens a herdr workspace with a lead pane, a duty pane, the duty loop and the hourly loop. Talk to the lead pane. It writes a brief and opens lanes itself, and you can do the same from the shell:

```sh
seori start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.seori/briefs/fix-flaky-login.md
seori status
```

A brief states the goal, inputs, deliverable, an observable exit condition and constraints; see [examples/brief.md](examples/brief.md). Do not write "complete the goal" in a brief: in goal mode that wording makes models stop early. A lane key matches `^[a-z][a-z0-9-]{1,40}$`, and a key that is already open is refused.

Inside a lane, omp reports and finishes with the commands the lane rules give it:

```sh
seori report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
seori report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
seori ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

The lead, on `[READY fix-flaky-login]`:

```sh
seori review owner/repo#12            # fresh isolated omp reviewer pinned to the head SHA; writes a receipt
seori merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why>
seori merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
seori done fix-flaky-login            # closes the lane's pane; only a READY lane can be closed
```

## Commands

```
seori up [--cwd DIR]                         open lead, duty, duty loop and hourly loop panes
seori role <lead|duty> [PANE]                register a pane as lead or duty (default: this pane)
seori start <key> --brief FILE [--cwd DIR]   open a lane: new tab, omp session, brief + lane rules
seori report <key> --text T [--status working|waiting]
seori ready <key> --text T --evidence LINK [--evidence LINK ...]
seori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                [--to-shell]                operator only: type this one message into a pane with no agent
seori inbox list <pane|role|key>             queued entries: index, state (queued|typed|held), sender, time, first 60 chars
seori inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
seori inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
seori duty [--once] [--interval SECONDS]     flush inboxes, nudge silent lanes, escalate, detect lost lanes
seori duty stop [--text WHY] | resume | status   kill switch
seori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                            hourly: sync backlog, audit missed work, start the next item, ask decisions
seori loop stop [--text WHY] | resume | status   kill switch and last run
seori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
seori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
seori backlog import <owner/repo> [--label seori] [--cwd DIR]   open labelled issues -> items
seori review <owner/repo#N> [--model M]      fresh omp reviewer at the exact head -> receipt
seori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
seori done <key>                             lead closes a READY lane
seori status
```

`--text` may be left off to read the message from stdin. `send`, `report` and `ready` exit 3 and print `HELD <target>` when a delivery may or may not have reached the pane; a held message is never resent, so check the pane, then `seori inbox ack` or `seori inbox resend` it. `QUEUED` (exit 0) means it waits in the pane's inbox. The commands the agents see are rendered with the full path to `src/cli.ts` and `SEORI_HOME` set, so `seori` does not need to be on their PATH.

## How a lane starts

`seori start <key> --brief FILE` writes the brief plus the lane rules to `~/.seori/briefs/<key>.md` and opens a new tab with a plain shell. It then runs `herdr agent start` with `--kind omp` in that pane, which returns once omp is ready for input. No prompt is passed to `agent start`: with the integration, a start that carries a prompt waits for the whole first turn and times out. Next it sends the kickoff with `herdr agent prompt`: a `/goal` command whose objective points omp at the brief and the lane key. omp switches to goal mode and keeps working until the goal is done. The lane is recorded as `working` and the lead gets `[START <key>]`.

The lane rules tell omp to restate the deliverable and the exit condition in its first reply, and never to mark the goal complete before `seori ready` has succeeded. From there the lane sends `[REPORT <key>]` (or `[REPORT <key> WAITING]` when it is blocked outside its own pane) and ends with `[READY <key>]` plus its evidence links.

## What the harness enforces

One voice. The lead is the only session that talks to you. Lanes send every fact meant for the human to the lead, and the duty session never merges and never talks to the human. Everything a lane does reaches the lead pane as a prompt: `[START]`, `[REPORT]`, `[READY]`, `[LOST]`, `[ESCALATE]`.

READY needs evidence. `seori ready` refuses without at least one `--evidence` link and without final answer text. The text and links are stored on the lane record, and `seori done` refuses any lane that is not READY, so no lane closes without a recorded answer.

Lead and duty panes are not interrupted; lanes take messages mid-turn. `seori send` asks herdr for the pane's agent state first. An idle agent gets the message now. A lane in goal mode reads `working` until its goal ends, so an open lane's pane also gets the message while working: omp takes it as a steer, handles it and continues. A busy lead or duty pane, and any blocked pane (a dialog is open), has it queued in `~/.seori/inbox/`, and the duty loop delivers the queue as one message when the pane can read. A pane with no agent in front (omp exited, or was suspended with Ctrl+Z and left a shell in front) is never typed into, because text typed into a shell runs as a command; its messages stay queued until omp is back. `--to-shell` types one message into a plain shell on purpose and applies to that message only.

Nudges at 10, 20 and 40 minutes. A lane that has not reported for 10 minutes gets `prompts/nudge.md` in its pane, even while its pane reads working: a goal-mode lane reads working until its goal ends, so working is not taken as progress, and the nudge arrives as a steer. At 20 it gets it again. At 40 the duty loop stops nudging and sends the lead `[ESCALATE <key>]`. Lanes therefore report a milestone at least every 10 minutes. A lane that reported `--status waiting` or whose pane is blocked is left alone, a new report resets the nudge count, and a lane whose pane disappears before READY is reported as `[LOST <key>]`.

Merge needs a CLEAR receipt at the exact head and green checks. `seori merge` reads the PR's head SHA with `gh` and requires a receipt for that SHA in `~/.seori/receipts/` with verdict `CLEAR`. Only `seori review` writes receipts. It runs a fresh non-interactive omp reviewer (optionally with `--model`) on `prompts/review.md` pinned to that SHA. The reviewer runs isolated, without the repository's AGENTS.md, skills, rules or extensions, reads the PR with `gh`, and must end with exactly one `VERDICT: CLEAR` or `VERDICT: BLOCK` line; without one, no receipt is written. Then `gh pr checks` must return at least one check, every check must pass or be skipped, and at least one must pass: an empty check list is never green. The merge is `gh pr merge --squash --match-head-commit <sha>`, so a push after the review changes the head and the old receipt no longer applies.

## State

JSON on disk under `~/.seori` (or `$SEORI_HOME`): `lanes/`, `inbox/`, `briefs/`, `receipts/`, `backlog/` and `loop/` for the hourly loop, and `duty/` for the duty loop's stop file. Besides the omp sessions, the only long-running processes are the duty loop and the hourly loop. The only runtime dependency is Bun.

## Environment

| variable | meaning |
|---|---|
| `SEORI_HOME` | state directory, default `~/.seori` |
| `SEORI_AGENT_CMD` | the reviewer's omp command, default `omp` (lead, duty and lanes always start through `herdr agent start --kind omp`) |
| `SEORI_MODEL` | model for every omp seori starts (`--model`), and the reviewer's default model; unset = omp's default |
| `SEORI_CMD` | how the agents and loop panes call seori, default `SEORI_HOME=<home> [SEORI_HERDR_SESSION=…] [SEORI_MODEL=…] bun <path>/src/cli.ts` |
| `SEORI_HERDR_SESSION` | a named herdr session to talk to |
| `SEORI_MAX_LANES` | default for `seori loop --max-lanes` (3) |
| `SEORI_MAX_STARTS` | default for `seori loop --max-starts` (2) |
| `SEORI_MAX_LOAD` | default for `seori loop --max-load` |
| `SEORI_LANE` | set by seori in a lane's pane; the default sender of `seori send` |

## Testing

```sh
bun test         # unit tests against a fake herdr and gh; no model is called
bun run typecheck
```

The end-to-end tests in `test/e2e.test.ts` need a real herdr with the omp integration installed, omp on PATH, and `SEORI_E2E_OMP=1`. They call a real model, so they cost money. Without those they are skipped.

## Telemetry

None. seori sends nothing anywhere.

## Differences from dori-superagent

- Agent: omp instead of omo. The default agent command is `omp`.
- Lanes start with `herdr agent start --kind omp` and a `/goal` kickoff, so each lane runs in omp goal mode. Briefs carry an observable exit condition.
- herdr's omp integration is required; it is what lets herdr see whether omp is idle, working or blocked.
- The reviewer is a non-interactive omp run isolated from the repository's AGENTS.md, skills, rules and extensions.
- No telemetry.
- Names: command `seori`, state `~/.seori`, environment `SEORI_*`.
- The Dori mode skill is not included.

## License

MIT. See [LICENSE](LICENSE).
