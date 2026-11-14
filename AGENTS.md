# AGENTS.md

seori is a harness that runs omp coding agents in hc terminals: a lead that takes the owner's messenger requests, a duty loop that supervises lanes, and lanes that do the work. Bun + TypeScript, no build step: the `seori` command runs `src/cli.ts` directly.

## The checkout you edit is the install

`install.sh` links `seori` on PATH (`bun link`) and the omp skill `~/.omp/agent/skills/seori-mode` into the checkout at `SEORI_SRC` (default `~/.seori/src`). That one checkout is both the running seori and the place it is developed, committed and pushed; README.md "Working on seori itself" describes the layout.

- An edit is live for the next `seori` command. The daemon, duty loop and hourly loop keep the code they started with until the home restarts (`seori restart`). Finish a change and run the tests before the running seori needs it.
- Commit and push each change when it is done. `install.sh` will not pull over local work when upstream has commits the checkout does not; it prints the three ways out and stops.
- Every tracked change is a change to every user's default. Personal settings stay out of git: `$SEORI_HOME` (`~/.seori`: `config.json`, `secrets.json`, `messengers.json`) and `~/.omp/agent/AGENTS.md` for tone and persona.
- A throwaway install (tests, experiments) sets `HOME`, `BUN_INSTALL`, `SEORI_HOME` and `SKILLS_DIR` inside its own temp directory; otherwise it repoints the machine-wide `seori`.

## Structure

```
src/cli.ts           # `seori` entry: command dispatch, up/down, lead and duty startup
src/harness.ts       # lanes: start, kickoff, nudges, review; prompt rendering (prompts/*.md, {{var}})
src/adopt-sync.ts    # seori adopt and seori sync
src/restart.ts       # seori restart: the detached worker that runs down, then up
src/agent/profile.ts # omp launch command, PI_CONFIG_FILES, DEFAULT_HOME
src/config.ts        # $SEORI_HOME/config.json schema; unknown fields are errors
src/store.ts         # state files under $SEORI_HOME
src/install.ts       # skill link and `seori uninstall`
src/messenger/       # telegram, slack, discord, fake
src/runtime/hc/      # hc runtime
src/watch/           # watches run by the daemon
prompts/             # lead, duty, lane footer, nudge, review prompts
skills/seori-mode/   # omp skill, linked into ~/.omp/agent/skills by install
extensions/          # omp extension loaded by the lead (lead-channel.ts)
test/                # bun tests; helpers/ and fixtures/ hold the fakes
```

## Commands

```sh
bun install --frozen-lockfile
bun run typecheck
bun test ./test/ --timeout 60000
```

- Unit tests run against fake hc, fake systemctl and fake gh, and call no model. `test/helpers/preload.ts` (bunfig.toml) gives every run a temp systemd unit dir and a systemctl that always fails.
- hc e2e: `SEORI_E2E_HC=1 bun test test/e2e-hc.test.ts test/e2e-hc-cli.test.ts --timeout 120000` (hc on PATH).
- Real-omp e2e calls a model and costs money; it is not in CI. See the Testing section of README.md.
- CI (`.github/workflows/ci.yml`) runs typecheck and tests on Ubuntu and macOS, plus hc e2e on Ubuntu.

## Conventions

- Imports carry the `.ts` extension; tsconfig is strict with `noUncheckedIndexedAccess`.
- README.md and README.ko.md describe the same behavior; change both in the same commit.
- Files adapted from dori-superagent carry the Sustainable Use License header in their first lines, and THIRD_PARTY_NOTICES.md lists exactly those files. `test/third-party-notices.test.ts` fails when the two disagree.
- A malformed config field is an error naming the field, never a silent default.
- Commits use the noreply email `291612675+useonmn@users.noreply.github.com`.
