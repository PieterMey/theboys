<#
.SYNOPSIS
  Starts the DEAD AIR speech-to-text sidecar (services/stt/server.py) with the venv Python.

.DESCRIPTION
  Listens on 127.0.0.1:$env:STT_PORT (default 3100). If a sidecar is already answering there,
  prints its health and exits 0 instead of starting a second one (so `npm run host` can re-attach).
  Runs in the foreground; stop it with Ctrl+C. Extra arguments are passed to server.py.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File services\stt\run.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File services\stt\run.ps1 -Port 3115
#>
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$py = Join-Path $here '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
  throw 'services/stt/.venv is missing: run  powershell -NoProfile -ExecutionPolicy Bypass -File services\stt\setup.ps1  first'
}
if ($Port -gt 0) { $env:STT_PORT = "$Port" }
if (-not $env:STT_PORT) { $env:STT_PORT = '3100' }
$addr = if ($env:STT_HOST) { $env:STT_HOST } else { '127.0.0.1' }

try {
  $h = Invoke-RestMethod -Uri "http://${addr}:$($env:STT_PORT)/health" -TimeoutSec 2
  Write-Host "[stt] already running on ${addr}:$($env:STT_PORT) (device=$($h.device) compute=$($h.compute) warm=$($h.warm)); not starting another"
  exit 0
} catch {
  # nothing listening: start it
}

$env:HF_HOME = Join-Path $here 'models'
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:PYTHONUNBUFFERED = '1'

$old = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { & $py -u (Join-Path $here 'server.py') @args } finally { $ErrorActionPreference = $old }
exit $LASTEXITCODE
