# Runtimes and the agent

seori never draws its own terminals. A runtime opens them, runs the agent inside, and tells seori what state the agent is in. seori supports two runtimes, hc (herdr-core, the default) and herdr, and one agent, omp.

Every record seori keeps names its session with a ref that says which runtime it lives in: `hc:t7` on hc, `herdr:w1:p3` (or the bare `w1:p3`, kept for older records) on herdr. That's why a home can hold lanes from both runtimes, and commands such as `seori adopt --ref` and `seori role` take either form.

## How the runtime is picked

The first rule that gives an answer wins:

1. `SEORI_RUNTIME=hc|herdr` in the environment.
2. `"runtime": "hc"` or `"herdr"` in `$SEORI_HOME/config.json`.
3. The terminal seori runs in: `HC_TERMINAL_ID` means hc, `HERDR_PANE_ID` means herdr.
4. What is on PATH: hc first, then herdr.

When none of them answers, the command stops with one line that names the fix. A bad value in the environment or the config is an error, never a silent fallback. `seori status` prints the result on its own line, for example `RUNTIME hc (from detect:HC_TERMINAL_ID)`.

## The agent

The agent is always omp. `SEORI_AGENT` and `"agent"` in `config.json` may name it; any other value refuses every command with one line (`seori: agent "<x>" is not supported; seori runs omp only`) and exit 2. `SEORI_AGENT_CMD` replaces the command seori types (default `omp`), for example a path to another omp install or a wrapper; its basename must be `omp`, and any other command is refused the same way (`seori: SEORI_AGENT_CMD "<x>" is not omp; seori runs omp only`). The hc e2e suite's fake omp is admitted only by a test-only environment switch that config.json and the systemd units never carry.

On hc, omp reports its own state to hc over OSC 7501 (`{"app":"omp","state":"idle|working|..."}`); seori reads that word as is.

## hc and herdr side by side

| what seori does | hc | herdr |
|---|---|---|
| group an instance's sessions | label `seori.group=<name>` on each terminal | a workspace named `<name>` |
| open a lane | new terminal in the group, type the agent command, wait for its first status | new tab, `herdr agent start --kind omp` |
| read the agent's state | `hc get` (status reported by the agent over OSC 7501) | herdr's agent state, from its omp integration |
| deliver a message | `hc send`, which pastes and presses Enter in one step, only while the status still matches | `herdr agent prompt` |
| read the screen | `hc read` | herdr's CLI |
| close a session | kill and remove the terminal | close the pane |
| run daemon and loops after `seori up` | `systemd --user` units on Linux, hc terminals on macOS | panes in the workspace |

A few rules hold on hc:

- seori never types into a terminal whose foreground program is a shell. That session's messages wait in its inbox until the agent is back.
- A delivery is skipped, and nothing is typed, when the agent turned blocked or its status changed between the read and the send. The message stays queued.
- Set `notes = false` in hc's `config.toml`. Otherwise hc types its own notes into agents, and seori counts on its inbox being the only writer.

herdr needs its omp integration (`herdr integration install omp`). Without it herdr reports omp as idle at all times and seori refuses to start lanes.

## Migrating sessions

```
seori migrate [--to hc|herdr] (--lane K | --role lead|duty | --all) [--dry-run] [--wait-minutes N] [--resume]
```

`--to` defaults to the selected runtime (see above). `--all` takes every open lane, then lead and duty. For each session the steps are:

1. Hold. A journal is created at `$SEORI_HOME/migrate/<name>.json` and the lane is marked as migrating, so the duty loop neither nudges it nor flushes its inbox (or the replacement's) while the journal exists.
2. Checkpoint. A checkpoint left by an earlier migration is removed first. omp is asked to write a handoff checkpoint (goal, open todos, last state) to `briefs/<name>.handoff.md` and stop. An idle agent gets the ask while it is idle, and a working one gets it while it is still working. seori then waits up to `--wait-minutes` (default 10) until omp has started on the ask (it reports working, or the checkpoint file appears) and stopped. If it never starts and writes nothing in that time, the capture goes on without a checkpoint. Only a checkpoint written after the ask is used. A `blocked` agent is asked nothing.
3. Capture. A handoff brief `briefs/<name>.migrate-<time>.md` is written: the original brief (for lead and duty, their prompt file), a `## Handoff` section with the last 20 lane log entries, the checkpoint, the last 80 screen lines and the queued messages, then the lane rules.
4. Open. The replacement opens on the target, a terminal labelled with this home's `seori.group` on hc or a new workspace on herdr, and omp starts the way `seori start` (a lane: `/goal` kickoff on the handoff brief) or `seori up` (lead and duty: the handoff brief as `--append-system-prompt`, in the directory `seori migrate` runs from) starts it.
5. Verify. The replacement must report `idle` or `working` within 3 minutes.
6. Move the inbox. A `.forward` marker on the old inbox names the new session, and the old entries are merged into the new inbox. Queued entries stay queued, held entries stay held, and an entry that was typed but never submitted becomes held.
7. Switch. The lane or role record points at the new session, and the lane keeps the old ref in `migratedFrom`.
8. Close. The old session is closed, messages late senders appended to the old inbox are moved over, the marker is removed, and the journal is deleted.

Each session ends with one line:

- `MIGRATED <name> <old> -> <new>`: done.
- `MIGRATE_ROLLBACK <name> <new> <why>`: the replacement did not start or did not verify. It is closed, and the inbox entries go back to the old inbox: queued entries go back queued, held entries stay held, and entries that were typed come back as ambiguous (held), never retyped. The hold is lifted, and the exit code is 3.
- `DEFERRED <name> blocked`: nothing moved, the blocked session got no message, and the hold is lifted.
- `DEFERRED <name> working past N min`: nothing moved and the hold is lifted, but the session already received the checkpoint ask. The duty loop nudges it back to its lane work as it nudges any lane that goes quiet.
- `SKIP <name> already on <runtime>`.
- `SKIP <name> is the session running seori migrate`: only under `--all`. Closing that session would end the run before it finishes, so run `seori migrate` for it from another session. Named with `--lane` or `--role`, it is refused (exit 2).

`--dry-run` prints `PLAN <name> <old> -> <runtime> (inbox entries: N)` and changes nothing. A run that was cut short resumes at the phase its journal recorded when it is started again, and a second `seori migrate` of the same session is refused while one runs.

`--resume` starts omp on the old session's own file (`omp --resume <path>`) instead of a kickoff on the handoff brief, and skips the checkpoint ask. It is accepted only when the old session is live and `idle` or `done` and its runtime reports omp's session path; herdr reports it through its omp integration, hc never does, so `--resume` from an hc session is refused and nothing moves.

The duty loop, the hourly loop and the daemon are not migrated, and `--role` accepts only `lead` and `duty`. seori does not record them as runtime sessions: on Linux they are `systemd --user` units, which belong to no runtime, and on macOS and herdr they are terminals or panes seori does not track. They hold no agent state and read the records, so after the lead and duty move they act on the new sessions as they are.

## Testing against an isolated hc core

The unit tests use a fake hc and a fake systemctl, so they need neither. `bun test` also preloads `test/helpers/preload.ts`, which points the systemd unit directory at a temp dir and `SEORI_SYSTEMCTL` at `false`, so no test can touch your real user units.

The hc end-to-end tests (`test/e2e-hc.test.ts`, `test/e2e-hc-cli.test.ts`, `test/e2e-migrate.test.ts`) start a real hc core of their own:

```sh
SEORI_E2E_HC=1 bun test test/e2e-hc.test.ts test/e2e-hc-cli.test.ts test/e2e-migrate.test.ts --timeout 120000
```

`test/e2e-hc-setup.ts` gives that core its own session name (`HC_SESSION=e2e-<pid>`) and temp `XDG_RUNTIME_DIR`, config and state dirs with `notes = false`. It drops every inherited `HC_*`, `HERDR_*` and `SEORI_*` variable first, so a test run inside an hc terminal can't reach the core it is running in. When the tests finish it removes their terminals, stops only that core and checks that its process exited and its runtime dir is empty. Copy that pattern for any new hc experiment, and never stop or restart the core your own terminals run on.
