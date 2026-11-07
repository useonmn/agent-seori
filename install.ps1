# Installs seori (the `seori` CLI) and the seori-mode skill for omp on Windows. install.sh is the macOS/Linux twin.
# Usage (PowerShell 5.1 or 7):
#   irm https://raw.githubusercontent.com/useonmn/agent-seori/main/install.ps1 | iex
#   .\install.ps1 [-NoLink]            install or update
#   .\install.ps1 -Uninstall [-Purge]  remove the skill link and the seori command (-Purge also deletes SEORI_HOME)
# Needs: git, bun 1.3+. Checks (never installs): herdr, herdr's omp integration, omp, gh.
# Optional env:
#   SEORI_SRC     where the checkout lives (default ~\.seori\src)
#   SEORI_HOME    seori's state directory (default ~\.seori)
#   SKILLS_DIR    where omp loads user skills (default ~\.omp\agent\skills)
#   SEORI_NO_PULL 1, true or yes: install the existing checkout as it is, without pulling
param([switch]$Uninstall, [switch]$Purge, [switch]$NoLink)
$ErrorActionPreference = "Stop"

$repo = "https://github.com/useonmn/agent-seori.git"
$home_ = if ($env:SEORI_HOME) { $env:SEORI_HOME } else { Join-Path $HOME ".seori" }
$src = if ($env:SEORI_SRC) { $env:SEORI_SRC } else { Join-Path $home_ "src" }
$skills = if ($env:SKILLS_DIR) { $env:SKILLS_DIR } else { Join-Path $HOME ".omp\agent\skills" }

function Need($cmd, $why) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Error $why; exit 1 } }
Need bun "bun 1.3 or newer is required: https://bun.sh"
Need git "git is required (Git for Windows: https://git-scm.com/download/win); seori's watch commands also run in its sh"

if ($Uninstall) {
  if (-not (Test-Path (Join-Path $src "src\cli.ts"))) { Write-Error "no seori checkout at $src (set SEORI_SRC)"; exit 1 }
  $env:SEORI_HOME = $home_
  $uninstallArgs = @("uninstall", "--skills-dir", $skills)
  if ($Purge) { $uninstallArgs += "--purge" }
  & bun (Join-Path $src "src\cli.ts") @uninstallArgs
  exit $LASTEXITCODE
}

# seori's state holds secrets.json and the owner's messages: only this user (and SYSTEM) may read it.
New-Item -ItemType Directory -Force -Path $home_ | Out-Null
& icacls $home_ /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning "could not restrict $home_ to $env:USERNAME (icacls exit $LASTEXITCODE)" }

New-Item -ItemType Directory -Force -Path $src | Out-Null
$src = (Resolve-Path $src).Path
if (-not (Test-Path (Join-Path $src ".git"))) {
  if (Get-ChildItem -Force $src | Select-Object -First 1) { Write-Error "$src exists, is not empty and is not a git checkout; set SEORI_SRC to another directory"; exit 1 }
  & git clone --quiet --depth 1 $repo $src
  if ($LASTEXITCODE -ne 0) { exit 1 }
} elseif ($env:SEORI_NO_PULL -match '^(1|true|yes)$') {
  Write-Host "SEORI_NO_PULL=${env:SEORI_NO_PULL}: installing $src as it is, without pulling"
} else {
  & git -C $src fetch --quiet
  if ($LASTEXITCODE -ne 0) { Write-Error "Could not fetch updates for $src; git's message above says why."; exit 1 }
  & git -C $src merge --ff-only --quiet '@{u}'
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Could not update $src (local work in that checkout?). Keep it: run again with SEORI_NO_PULL=1. Drop it: git -C `"$src`" reset --hard '@{u}', then run again."
    exit 1
  }
}
if (-not ((Test-Path (Join-Path $src "package.json")) -and (Test-Path (Join-Path $src "skills\seori-mode")))) {
  Write-Error "$src is not a seori checkout (no package.json or skills\seori-mode)"; exit 1
}

Push-Location $src
try {
  & bun install --silent
  if ($LASTEXITCODE -ne 0) { exit 1 }
  # `bun link` puts the package's bin (`seori` -> src/cli.ts) on PATH through bun's global bin directory.
  if (-not $NoLink) { & bun link --silent; if ($LASTEXITCODE -ne 0) { exit 1 } }
} finally { Pop-Location }

$warnings = 0
function Warn($m) { Write-Warning $m; $script:warnings++ }

# A directory junction (no admin rights or developer mode needed); an old link or seori copy is replaced.
$skillOut = & bun (Join-Path $src "src\cli.ts") install-skill --skills-dir $skills
if ($LASTEXITCODE -eq 0) { $skillNote = $skillOut -replace '^SKILL ', '' } else { Warn ($skillOut -replace '^WARNING ', ''); $skillNote = "NOT linked (see the warning above)" }

# secrets.json, messengers.json and config.json are the owner's: never created or overwritten here.

if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) {
  Warn "herdr is not on PATH; install it from https://herdr.dev"
} else {
  $status = & herdr integration status 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Warn "could not read herdr integration status: $status" }
  elseif (-not ($status -split "`n" | Where-Object { $_ -like "omp:*" -and $_ -notlike "*not installed*" })) {
    Warn "herdr's omp integration is not installed; run: herdr integration install omp (seori refuses to start lanes without it)"
  }
}
if (-not (Get-Command omp -ErrorAction SilentlyContinue)) { Warn "omp is not on PATH; install oh-my-pi: https://github.com/can1357/oh-my-pi" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Warn "the GitHub CLI gh is not on PATH; reviews, merges and Done signals on PRs need it" }
$seori = Get-Command seori -ErrorAction SilentlyContinue
if ($NoLink) { $cliNote = "bun `"$src\src\cli.ts`" (not linked: -NoLink)" }
elseif ($seori) { $cliNote = $seori.Source }
else {
  $bin = (& bun pm bin -g 2>$null); if (-not $bin) { $bin = Join-Path $HOME ".bun\bin" }
  Warn "seori is linked into $bin, which is not on PATH; add it to PATH, or run bun $src\src\cli.ts"
  $cliNote = "$bin\seori (not on PATH)"
}

Write-Host "Installed seori from $src"
Write-Host "  CLI:   $cliNote"
Write-Host "  Skill: $skillNote"
Write-Host "  Home:  $home_"
if ($warnings -gt 0) { Write-Host "Fix the $warnings warning(s) above first." }
Write-Host "Next: start herdr, run omp in a pane and say: seori mode (or 서리 모드)"
