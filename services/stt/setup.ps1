<#
.SYNOPSIS
  Idempotent setup for the DEAD AIR speech-to-text sidecar (faster-whisper large-v3-turbo on CUDA).

.DESCRIPTION
  1. Creates services/stt/.venv with Python 3.13 (py -3.13 -m venv), if it is missing.
  2. Installs the pinned packages from requirements.txt (a no-op when they are already installed).
  3. Puts mobiuslabsgmbh/faster-whisper-large-v3-turbo (about 1.6 GB) into services/stt/models
     (used as HF_HOME). When -SeedHfHome points at an existing HF_HOME that already holds the
     model, the files are copied from there instead of downloaded.
  4. Runs a CUDA smoke test (server.py --check). A failure is only a warning: the server falls
     back to int8_float16 and then to CPU int8 at runtime.
  Every step is skipped when it is already done, so re-running is cheap.

.PARAMETER SeedHfHome
  Optional HF_HOME directory to copy the model from (it must contain
  hub\models--mobiuslabsgmbh--faster-whisper-large-v3-turbo). Defaults to $env:STT_SEED_HF_HOME.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File services\stt\setup.ps1
#>
param(
  [string]$SeedHfHome = $env:STT_SEED_HF_HOME
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$venv = Join-Path $here '.venv'
$py = Join-Path $venv 'Scripts\python.exe'
$models = Join-Path $here 'models'
$repoDir = 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo'

function Step([string]$msg) { Write-Host "[stt-setup] $msg" }

# Runs a native command with a relaxed error preference (native stderr must not throw in PS 5.1)
# and fails on a non-zero exit code.
function Invoke-Native([string]$what, [scriptblock]$cmd) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $cmd } finally { $ErrorActionPreference = $old }
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

function Test-ModelPresent {
  $snap = Join-Path $models "hub\$repoDir\snapshots"
  if (-not (Test-Path $snap)) { return $false }
  $bin = Get-ChildItem -Path $snap -Recurse -Filter 'model.bin' -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 1GB }
  return [bool]$bin
}

# --- 1. model files (copy from a seed cache first: it is the slowest step otherwise) -------------
New-Item -ItemType Directory -Force $models | Out-Null
if (-not (Test-ModelPresent) -and $SeedHfHome) {
  $src = Join-Path $SeedHfHome "hub\$repoDir"
  if (Test-Path (Join-Path $src 'snapshots')) {
    Step "copying model cache from seed HF_HOME ($src)"
    $dst = Join-Path $models "hub\$repoDir"
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null } finally { $ErrorActionPreference = $old }
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit code $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
  } else {
    Step "seed HF_HOME has no $repoDir; the model will be downloaded"
  }
}

# --- 2. venv -------------------------------------------------------------------------------------
if (-not (Test-Path $py)) {
  Step "creating venv with Python 3.13 at $venv"
  Invoke-Native 'venv creation (is Python 3.13 installed? see: py -0p)' { py -3.13 -m venv $venv }
} else {
  Step 'venv exists'
}
$ver = (& $py -c "import sys; print('%d.%d' % sys.version_info[:2])").Trim()
if ($ver -ne '3.13') { Write-Warning "services/stt/.venv uses Python $ver, expected 3.13 (delete .venv and re-run)" }

# --- 3. packages ---------------------------------------------------------------------------------
Step 'installing pinned requirements (no-op when already satisfied)'
Invoke-Native 'pip install' {
  & $py -m pip install --disable-pip-version-check --no-input -q -r (Join-Path $here 'requirements.txt')
}

# --- 4. model: verify or download into HF_HOME=services/stt/models -------------------------------
$env:HF_HOME = $models
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
if (Test-ModelPresent) {
  Step 'model present in services/stt/models'
} else {
  Step 'downloading mobiuslabsgmbh/faster-whisper-large-v3-turbo (about 1.6 GB)'
}
Invoke-Native 'model download/verify' { & $py (Join-Path $here 'server.py') --download }

# --- 5. CUDA smoke test (DLL search path + device count; no model load) ---------------------------
$old = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { & $py (Join-Path $here 'server.py') --check } finally { $ErrorActionPreference = $old }
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'CUDA check failed: the sidecar will fall back to CPU int8 (slower). See the output above.'
}
$global:LASTEXITCODE = 0
Step 'done. Start the sidecar with: powershell -NoProfile -ExecutionPolicy Bypass -File services\stt\run.ps1'
