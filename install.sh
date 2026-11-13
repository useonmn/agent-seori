#!/usr/bin/env bash
# Installs seori (the `seori` CLI) and the seori-mode skill for omp.
# Usage: curl -fsSL https://raw.githubusercontent.com/useonmn/agent-seori/main/install.sh | bash
# Uninstall: bash install.sh --uninstall [--purge]   (or: seori uninstall [--purge]); --purge also deletes SEORI_HOME
# Needs: git, bun 1.3+. Checks (never installs): hc (herdr-core) and its notes = false setting, omp, systemctl (Linux).
# Optional env:
#   SEORI_SRC     where the checkout lives (default ~/.seori/src)
#   SEORI_HOME    seori's state directory (default ~/.seori)
#   SKILLS_DIR    where omp loads user skills (default ~/.omp/agent/skills)
#   SEORI_NO_PULL 1, true or yes: install the existing checkout as it is, without pulling
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

# Absolute, so the skill symlink resolves from the skills directory whatever SEORI_SRC was relative to.
mkdir -p "$src"
src="$(cd "$src" && pwd -P)"

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
elif ! git -C "$src" merge --ff-only --quiet '@{u}'; then
  # Only local work (edits, or commits upstream lacks) is ours to explain; anything else is git's message above.
  if git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null &&
    [ -n "$(git -C "$src" status --porcelain)$(git -C "$src" rev-list '@{u}..HEAD')" ]; then
    echo "Could not update $src. Local work in that checkout:" >&2
    git -C "$src" status --short --branch >&2
    git -C "$src" log --oneline '@{u}..HEAD' >&2
    echo "To keep it and install the checkout as it is, run install.sh again with SEORI_NO_PULL=1." >&2
    echo "To drop it and update: git -C \"$src\" reset --hard '@{u}', then run install.sh again." >&2
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
