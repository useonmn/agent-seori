CURRENT HEADS (2026-11-14 12:30 KST), superseding the frozen state below:
  #75 install.sh dev workflow — branch `home-split-docs`, head `c42c544` (all round-four findings fixed: one escape
      path q()/cat_words for every remedy; a metacharacter test that pastes all three remedies and proves nothing runs
      from the path; home/skills resolved; HOME/BUN_INSTALL carried. CI 3/3 green. NOT yet reviewed at this head.)
  #76 restart recovery       — branch `feat/restart-autorestart`, head `6367cdf` (WIP checkpoint; hc-start hook included)
  #77 progress posts off     — branch `progress-every-min-off`, head `575fde1` (WIP checkpoint + this handoff/ dir)
The owner stopped all three lanes and may continue on another machine. Lanes are paused, the duty and hourly loops are
stopped, and the messenger daemon is left running (it receives, nothing processes it). Resume with `seori resume <key>`
per lane, or start fresh lanes from these heads.


# progress-off landing runbook

Frozen state: branch `progress-every-min-off`, head `a519ab4`, PR #77, CI 3/3 SUCCESS,
typecheck exit 0, 818 pass/31 skip/0 fail on branch, 849 pass/0 fail on the re-rehearsed merge.

Blocked on: the lead's explicit go. Do NOT commit or push before it.

## Facts verified (do not re-derive)

- Queue: #75 (head e828457) and #76 (head 14d92cd) were OPEN at the last check; `origin/main`
  was `0e2923f`. Re-check before acting.
- Rehearsed twice (latest against those exact heads): #75 then #76 onto main, then this
  branch's 3 commits cherry-picked => ZERO conflicts, all auto-merged.
- Files where both sides touch the same region, and the expected resolution:
  - `README.md` / `README.ko.md`: #75 adds a "Working on seori itself" section and rewrites
    the install bullet; #76 adds restart docs. Keep their prose and my
    "It is off by default" / "기본은 꺼짐입니다" paragraph plus my `threadReply` table row.
  - `prompts/lead.md`: my edit is line 33 (thread/progressEveryMin); #76's are the two lines
    after the worklog bullet (~43-45, restart + new-pane announcement). Both survive.
  - `skills/seori-mode/references/setup.md`: #75 edits the install steps; I edit the config
    block (`"progressEveryMin": null`) and the field list. Both survive.
- No branch protection on `main`; local == remote == a519ab4, so
  `git push --force-with-lease` is safe and cannot clobber another lane.

## Sequence on go

1. `git fetch origin && git status --porcelain` (must be clean).
2. Confirm `origin/main` actually advanced; if #75/#76 are not merged, STOP and report.
3. `git rebase origin/main`; resolve only the three regions above per the expected resolution.
   `git diff --name-only` must still list exactly the 11 files (no lane-owned file:
   install.sh, src/cli.ts, src/restart.ts, src/systemd.ts, test/instance|up-hc|restart.test.ts,
   src/messenger/**, src/daemon.ts, src/msg.ts).
4. `bun run typecheck` (exit 0) and `bun test ./test/` (every test passes) on the rebased tree.
5. Copy the resulting SHAs and counts over `work/progress-off.log` (head=<new>).
6. `git push --force-with-lease` — ONE push.
7. `seori watch add --checks useonmn/agent-seori#77 --name pr77-rebased`, then wait for
   checks. Do not poll; the watch wakes this lane.
8. Only when checks are green at the NEW head:
   `SEORI_HOME=/home/jinsung/.seori bun /home/jinsung/.seori/src/src/cli.ts review useonmn/agent-seori#77`
   A receipt at a519ab4 does NOT satisfy the gate; it must be at the post-rebase head.
9. `SEORI_HOME=/home/jinsung/.seori bun /home/jinsung/.seori/src/src/cli.ts ready progress-off \
     --text '<what changed + how verified>' \
     --evidence https://github.com/useonmn/agent-seori/pull/77 \
     --evidence /home/jinsung/src/progress-off/work/progress-off.log`
10. Do not merge. The lead merges.

## Watches armed

- `main-moved` (wmwfrnepr50, persistent 7d): runs `work/watch-main.sh`, prints
  `MAIN-MOVED <old> -> <new>` when origin/main moves. Verified silent-when-unmoved and
  firing-when-moved. This is the wake signal for step 1.

## Pending fixes, NOT committed (work/pre-review-fixes.patch)

From an independent pre-review against the repo rubric (prompts/review.md), which returned BLOCK with
two MEDIUM findings; both were reproduced, fixed, and verified here. Apply with
`git apply work/pre-review-fixes.patch` when the lead decides.

**MEDIUM 1 — the "0 is refused" test never tested 0.** `setup({progressEveryMin: 0})` wrote the config,
then the very next loop overwrote the file with `-1` before any `loadConfig` call, so the PR's headline
contract had no coverage. Fixed by asserting the `0` config before the loop. Mutation-checked: swapping
`minutes()` back to `num()` (which accepts 0) now FAILS this test; before the fix it passed silently.

**MEDIUM 2 — `hooks.threadReply` ran with no deadline inside the awaited duty tick.** A sender that
never returns stalled every later stage of the pass (inbox flushing, nudges, autoclose, supervision,
guard). Reproduced: a `sleep 600` hook hung the tick indefinitely. Fixed with
`THREAD_REPLY_TIMEOUT_MS = 30_000` via the Exec `onSpawn` kill, cleared in `finally`; a killed run is a
definite `post-failed`, recording nothing so the report retries. Reproduced after the fix: the tick
returns in 30 s with `hooks.threadReply: exit 143`.

**LOW fixes taken** — README en/ko now say the failure event is `post-failed` with
`hooks.threadReply: <first error line>` (not `via hooks.threadReply`, which is success only); the
`hooks.threadReply` bullet moved to the end of the field list with the blank line restored before
"Write it only with the owner's go"; the scrubForOwner docstring no longer claims `~`/`$SEORI_HOME`
spellings are masked (it states the literal root).

**Also in this patch** (found by my own rubric audit, earlier):
- quoted state path swallowed its closing quote (`see "(state path) here`); `"` added to the stop set.
- `stateRoot` now defaults to `~/.seori` instead of printing `~/.seori/secrets.json` when omitted
  (unreachable in production; the one call site passes `d.store.root`).

Verified with the patch applied: `progress.test.ts` 22/22, full suite 821 pass / 0 fail, typecheck
exit 0. Reverted afterwards: branch is exactly a519ab4, tree clean, 19/19.

## Deliberate tradeoff a reviewer may raise (do not "fix" blindly)

A `hooks.threadReply` that posts successfully but exits non-zero causes one duplicate post on the next
tick, because nothing is recorded (progress.ts, the `res.code !== 0` branch). This is brief-mandated,
not an oversight: the brief says a failing hook must not lose the report. The messenger path has
`SendUncertain` to distinguish the case; an argv hook has no such signal, so the two options are
"never lose, may duplicate on a broken hook" (chosen) or "never duplicate, may lose" (what dori does —
`freshness.ts` never checks the hook's exit code and records lastAutoReplyAt regardless). The brief
picks the first. Wording already says "a failing hook must not lose the report".

## Landing risk closed (2026-11-14)

Re-checked in a detached worktree: apply #75 (03de45d) then #76 (14d92cd) to origin/main, cherry-pick
this branch's 3 commits, then `git apply --check work/pre-review-fixes.patch` => applies cleanly.
So the plan "rebase, fold in the pre-review fixes as one commit, push once, review at the new head"
has no patch conflict waiting. Worktree removed, no refs touched.

NOTE for future rehearsals: use `git worktree add --detach <path> origin/main`. A plain
`git worktree add <path> main` attaches HEAD to the BRANCH main and rehearsal commits then advance the
local main ref (this happened once and produced a false "conflict" reading; origin/main was never hit).
