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
#                 developing: a checkout with local work is never pulled, and this says so instead of asking you)
#   BUN_INSTALL   where bun keeps its global bin and its package links (default ~/.bun). A throwaway install must set
#                 this, HOME, SEORI_HOME and SKILLS_DIR: `bun link` below writes the machine's global `seori` otherwise.
set -euo pipefail

repo="https://github.com/useonmn/agent-seori.git"
home="${SEORI_HOME:-$HOME/.seori}"
src="${SEORI_SRC:-$home/src}"
skills="${SKILLS_DIR:-$HOME/.omp/agent/skills}"

# How the remedies below tell the user to run this script again. Through `curl | bash` there is no file to name, so the
# one-liner is the way back; run from a file, name that file, since the user's shell may be anywhere.
if [ -f "${BASH_SOURCE[0]:-}" ]; then
  self="bash \"$(readlink -f "${BASH_SOURCE[0]}")\""
else
  self="bash <(curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh)"
fi
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

# Absolute, so the skill symlink resolves from the skills directory whatever SEORI_SRC was relative to.
mkdir -p "$src"
src="$(cd "$src" && pwd -P)"

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
  echo "  install this checkout as it is:  SEORI_NO_PULL=1 $self" >&2
  echo "  update it and keep the work:     git -C \"$src\" pull --rebase --autostash" >&2
  echo "  update it and drop the work:     git -C \"$src\" reset --hard '@{u}' && $self" >&2
  exit 1
elif ! git -C "$src" merge --ff-only --quiet '@{u}'; then
  echo "Could not update $src; git's message above says why." >&2
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
