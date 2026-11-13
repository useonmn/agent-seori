# The runtime and the agent

seori never draws its own terminals. hc (herdr-core) opens them, runs the agent inside, and tells seori what state the agent is in. seori runs on hc only, with one agent, omp.

Every record seori keeps names its session with an hc ref such as `hc:t7`. Commands that take a session (`seori adopt --ref`, `seori role`, `seori send`) take that form. Records an older seori wrote on herdr (a bare pane id such as `w1:p3`) are handled by whether they are still live. A done or lost lane is history and is skipped. So is an empty inbox file. A live one is refused with one line that names the file: an open lane, a role, or an inbox that still holds messages. Close that pane and remove the file. For an inbox, read its queued messages first: they are dropped with the file. While such a record is there, each duty pass skips it, prints that line as `DUTY ERROR`, and keeps supervising every hc lane. A pane watch saved with a herdr pane id is stopped.

## The agent

The agent is always omp. `SEORI_AGENT` and `"agent"` in `config.json` may name it; any other value refuses every command with one line (`seori: agent "<x>" is not supported; seori runs omp only`) and exit 2. `SEORI_AGENT_CMD` replaces the command seori types (default `omp`), for example a path to another omp install or a wrapper; its basename must be `omp`, and any other command is refused the same way (`seori: SEORI_AGENT_CMD "<x>" is not omp; seori runs omp only`). The hc e2e suite's fake omp is admitted only by a test-only environment switch that config.json and the systemd units never carry.

omp reports its own state to hc over OSC 7501 (`{"app":"omp","state":"idle|working|..."}`); seori reads that word as is.

## What seori does on hc

| what seori does | how |
|---|---|
| group an instance's sessions | label `seori.group=<name>` on each terminal |
| open a lane | new terminal in the group, type the agent command, wait for its first status |
| read the agent's state | `hc get` (status reported by the agent over OSC 7501) |
| deliver a message | `hc send`, which pastes and presses Enter in one step, only while the status still matches |
| read the screen | `hc read` |
| close a session | kill and remove the terminal |
| run daemon and loops after `seori up` | `systemd --user` units on Linux, hc terminals on macOS |

A few rules hold:

- seori never types into a terminal whose foreground program is a shell. That session's messages wait in its inbox until the agent is back.
- A delivery is skipped, and nothing is typed, when the agent turned blocked or its status changed between the read and the send. The message stays queued.
- Set `notes = false` in hc's `config.toml`. Otherwise hc types its own notes into agents, and seori counts on its inbox being the only writer.

## Testing against an isolated hc core

The unit tests use a fake hc and a fake systemctl, so they need neither. `bun test` also preloads `test/helpers/preload.ts`, which points the systemd unit directory at a temp dir and `SEORI_SYSTEMCTL` at `false`, so no test can touch your real user units.

The hc end-to-end tests (`test/e2e-hc.test.ts`, `test/e2e-hc-cli.test.ts`) start a real hc core of their own:

```sh
SEORI_E2E_HC=1 bun test test/e2e-hc.test.ts test/e2e-hc-cli.test.ts --timeout 120000
```

`test/e2e-hc-setup.ts` gives that core its own session name (`HC_SESSION=e2e-<pid>`) and temp `XDG_RUNTIME_DIR`, config and state dirs with `notes = false`. It drops every inherited `HC_*` and `SEORI_*` variable first, so a test run inside an hc terminal can't reach the core it is running in. When the tests finish it removes their terminals, stops only that core and checks that its process exited and its runtime dir is empty. Copy that pattern for any new hc experiment, and never stop or restart the core your own terminals run on.
