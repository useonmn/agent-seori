#!/usr/bin/env bash
# Installs seori (the `seori` CLI) and the seori-mode skill for omp.
# Usage: curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh | bash
# Uninstall: bash install.sh --uninstall [--purge]   (or: seori uninstall [--purge]); --purge also deletes SEORI_HOME
# Needs: git, bun 1.3+. Checks (never installs): hc (herdr-core) and its notes = false setting, omp, systemctl (Linux).
# Optional env:
#   SEORI_SRC     where the checkout lives (default ~/.seori/src). Point it at the clone you develop in, e.g.
#                 ~/src/agent-seori, and keep that clone outside SEORI_HOME; see "Working on seori itself" in README.md
#   SEORI_HOME    seori's state directory (default ~/.seori)
#   SKILLS_DIR    where omp loads user skills (default ~/.omp/agent/skills)
#   SEORI_NO_PULL 1, true or yes: install the existing checkout as it is, without pulling (what you want while
#                 developing: a checkout with local work *and* commits waiting upstream is not pulled, and this says so)
#   BUN_INSTALL   where bun keeps its global bin and its package links (default ~/.bun). A throwaway install must set
#                 this, HOME, SEORI_HOME and SKILLS_DIR: `bun link` below writes the machine's global `seori` otherwise.
set -euo pipefail

repo="https://github.com/useonmn/agent-seori.git"
home="${SEORI_HOME:-$HOME/.seori}"
src="${SEORI_SRC:-$home/src}"
skills="${SKILLS_DIR:-$HOME/.omp/agent/skills}"
command -v bun >/dev/null || { echo "bun 1.3 or newer is required: https://bun.sh" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  shift
  [ -f "$src/src/cli.ts" ] || { echo "no seori checkout at $src (set SEORI_SRC)" >&2; exit 1; }
  SEORI_HOME="$home" exec bun "$src/src/cli.ts" uninstall --skills-dir "$skills" "$@"
fi
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

# seori's state holds secrets.json and the owner's messages: only this user may read it.
mkdir -p "$home"
chmod 700 "$home"

# All three are resolved to absolute paths here, and only then compared with their defaults and carried into a remedy: a
# relative SEORI_HOME or SKILLS_DIR pasted back from another directory would name a different place (an empty home, a
# skill link nobody loads), and the default comparisons below would be cwd-dependent.
home="$(cd "$home" && pwd -P)"
mkdir -p "$src"
src="$(cd "$src" && pwd -P)"
mkdir -p "$skills"
skills="$(cd "$skills" && pwd -P)"

# Remedy construction, in one place. A remedy is a line the user pastes, so every value in it must survive a shell
# re-read, and every value here is already an absolute path (SEORI_SRC, SEORI_HOME and SKILLS_DIR went through
# `cd … pwd -P` above). Two rules keep that true, and no remedy below may bypass them:
#   q VALUE        escapes one value for pasting (printf %q, so a quote, `$` or backtick in a path cannot become syntax)
#   cat_words …    joins already-escaped words with single spaces; a value reaches a remedy only through q
q() { printf '%q' "$1"; }
cat_words() { local out="" w; for w in "$@"; do out="$out $w"; done; printf '%s' "${out# }"; }

# The command that re-runs this script. From a file it names that file; through a pipe or a redirect there is no file to
# name, so it re-fetches the current script — a different revision than the one that refused, which the refusal says.
if [ -f "${BASH_SOURCE[0]:-}" ]; then
  selfdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  self="bash $(q "$selfdir/$(basename "${BASH_SOURCE[0]}")")"
else
  self="bash <(curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh)"
fi

# The environment that reproduces *this* install, carried only where it differs from the defaults: SEORI_SRC whenever it is
# not the default checkout, SEORI_HOME and SKILLS_DIR when they are not theirs, and HOME and BUN_INSTALL when they are not
# the login values — those last two decide where `bun link` writes the machine's global `seori`, so a throwaway refusal
# pasted into a normal shell would otherwise repoint it.
env_prefix=""
[ "$src" = "$home/src" ] || env_prefix="$(cat_words "SEORI_SRC=$(q "$src")" "$env_prefix")"
[ "$home" = "$HOME/.seori" ] || env_prefix="$(cat_words "SEORI_HOME=$(q "$home")" "$env_prefix")"
[ "$skills" = "$HOME/.omp/agent/skills" ] || env_prefix="$(cat_words "SKILLS_DIR=$(q "$skills")" "$env_prefix")"
# `~$(id -un)` is expanded from the passwd entry, so it stays the login home even when HOME is the variable overridden.
login_home="$(eval printf '%s' "~$(id -un)")"
[ "$login_home" = "~$(id -un)" ] || [ "$HOME" = "$login_home" ] || env_prefix="$(cat_words "HOME=$(q "$HOME")" "$env_prefix")"
[ -z "${BUN_INSTALL:-}" ] || env_prefix="$(cat_words "BUN_INSTALL=$(q "$BUN_INSTALL")" "$env_prefix")"

# The remedy that installs this checkout as it is: the one line every refusal offers.
remedy_install_as_is="$(cat_words "SEORI_NO_PULL=1" "$env_prefix" "$self")"

# Local work: edits to tracked files, or commits upstream does not have. Untracked files never count (a test log, or
# anything else `bun test` leaves behind, does not block a fast-forward), so they are filtered out here.
local_work() {
  [ -n "$(git -C "$src" status --porcelain --untracked-files=no)" ] && return 0
  git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null || return 1
  [ -n "$(git -C "$src" rev-list '@{u}..HEAD')" ]
}

# An update is waiting: upstream has commits this checkout does not. Read after the fetch. Both helpers are only
# meaningful with an upstream branch; without one they say nothing and git's own message from the merge explains it.
update_waits() {
  git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null || return 1
  [ -n "$(git -C "$src" rev-list 'HEAD..@{u}')" ]
}

# -e, not -d: a git worktree has a .git file.
if [ ! -e "$src/.git" ]; then
  if [ -e "$src" ] && [ -n "$(ls -A "$src" 2>/dev/null)" ]; then
    echo "$src exists, is not empty and is not a git checkout; set SEORI_SRC to another directory" >&2
    exit 1
  fi
  git clone --quiet --depth 1 "$repo" "$src"
elif [[ "${SEORI_NO_PULL:-}" =~ ^(1|true|yes)$ ]]; then
  echo "SEORI_NO_PULL=$SEORI_NO_PULL: installing $src as it is, without pulling" >&2
elif ! git -C "$src" fetch --quiet; then
  echo "Could not fetch updates for $src; git's message above says why." >&2
  exit 1
elif local_work && update_waits; then
  # Refuse only when a pull would actually move this tree: with nothing upstream to take, local work changes nothing and
  # a reinstall stays idempotent. The check is before the merge, not after it fails, so a clean fast-forward over edits
  # meant to be run as they are never happens silently.
  echo "$src has local work and upstream has commits it does not, so install.sh did not pull:" >&2
  git -C "$src" status --short --branch --untracked-files=no >&2
  if ahead="$(git -C "$src" log --oneline '@{u}..HEAD')" && [ -n "$ahead" ]; then
    echo "Commits upstream does not have:" >&2
    printf '%s\n' "$ahead" >&2
  fi
  echo "This is a checkout you develop in; see \"Working on seori itself\" in README.md." >&2
  echo "  install this checkout as it is:  $remedy_install_as_is" >&2
  # The git remedies are built the same way: the path goes through `q`, the rest are literal words. Hand-quoting `"$src"`
  # would still expand `$(…)`, a backtick or a quote from a directory name the moment the line is pasted.
  echo "  update it and keep the work:     $(cat_words "git -C $(q "$src") pull --rebase --autostash &&" "$self")" >&2
  echo "  update it and drop the work:     $(cat_words "git -C $(q "$src") reset --hard '@{u}' &&" "$self")" >&2
  echo "If the autostash stops on a conflict, resolve it and commit before installing again." >&2
  exit 1
elif ! git -C "$src" merge --ff-only --quiet '@{u}'; then
  # Three states land here: no upstream at all (a scratch branch, a detached HEAD), local work a remedy left behind, or
  # something only git can explain. Name the one it is instead of blaming local work by default.
  if ! git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null; then
    echo "Could not update $src: its branch has no upstream to merge from (git's message above names the branch)." >&2
    echo "Set one with $(cat_words "git -C $(q "$src") branch --set-upstream-to=origin/main,") or install it as it is with $remedy_install_as_is." >&2
  elif local_work; then
    echo "Could not update $src: it has local work (listed below), so nothing was merged." >&2
    git -C "$src" status --short --branch --untracked-files=no >&2
    echo "Install it as it is with $remedy_install_as_is, or commit or stash the work first." >&2
  else
    echo "Could not update $src; git's message above says why." >&2
  fi
  exit 1
fi

[ -f "$src/package.json" ] && [ -d "$src/skills/seori-mode" ] || {
  echo "$src is not a seori checkout (no package.json or skills/seori-mode)" >&2
  exit 1
}

# `bun link` in the checkout puts the package's bin (`seori` -> src/cli.ts) on PATH through bun's global bin directory.
(cd "$src" && bun install --silent && bun link --silent)

warnings=0
warn() {
  echo "WARNING: $*" >&2
  warnings=$((warnings + 1))
}

# The skill link is made by seori itself (src/install.ts): a symlink, and an old link or seori copy is replaced so a reinstall never keeps a stale skill.
if skill_out="$(bun "$src/src/cli.ts" install-skill --skills-dir "$skills")"; then
  skill_note="${skill_out#SKILL }"
else
  warn "${skill_out#WARNING }"
  skill_note="NOT linked (see the warning above)"
fi

# secrets.json, messengers.json and config.json are the owner's: never created or overwritten here.

# seori runs its agents in hc (herdr-core) terminals and its daemon and loops as systemd --user units (seori up).
if ! command -v hc >/dev/null; then
  warn "hc (herdr-core) is not on PATH; install it first (seori up opens its lead and duty terminals in hc)"
fi
# hc types notes into parent agents unless told not to; seori's inbox is the only delivery path. Checked, never rewritten.
hc_config="${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/config.toml"
if ! grep -Eq '^[[:space:]]*notes[[:space:]]*=[[:space:]]*false[[:space:]]*(#.*)?$' "$hc_config" 2>/dev/null; then
  warn "$hc_config does not set notes = false; add that line so hc types nothing into seori's agents on its own"
fi
command -v omp >/dev/null || warn "omp is not on PATH; install oh-my-pi: https://github.com/can1357/oh-my-pi"
# Linux only: on macOS seori up runs its daemon and loops in hc terminals instead.
if [ "$(uname -s)" = Linux ]; then
  command -v systemctl >/dev/null || warn "systemctl is not on PATH; seori up runs its daemon and loops as systemd --user units"
fi
command -v gh >/dev/null || warn "the GitHub CLI gh is not on PATH; reviews, merges and Done signals on PRs need it"
if command -v seori >/dev/null; then
  cli_note="$(command -v seori)"
else
  bin="$(bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin")"
  warn "seori is linked into $bin, which is not on PATH; add it to PATH, or run bun $src/src/cli.ts"
  cli_note="$bin/seori (not on PATH)"
fi

echo "Installed seori from $src"
echo "  CLI:   $cli_note"
echo "  Skill: $skill_note"
echo "  Home:  $home"
[ "$warnings" -eq 0 ] || echo "Fix the $warnings warning(s) above first."
echo "Next: seori up (lead and duty in hc terminals, daemon and loops as systemd --user units); seori down stops them"
