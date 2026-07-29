# Wire this Windows machine into Cammy shared memory.
#
#   .\scripts\setup-device.ps1 -Url https://your-service.onrender.com -Key YOUR_MEMORY_API_KEY
#
# Installs the SessionStart/SessionEnd hooks globally, persists the two env
# vars for your user, and verifies the API is reachable.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Key
)
$ErrorActionPreference = "Stop"
$Url = $Url.TrimEnd('/')

$RepoDir  = Split-Path -Parent $PSScriptRoot
$HookDir  = Join-Path $HOME ".claude\hooks"
$Settings = Join-Path $HOME ".claude\settings.json"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node is not on PATH. Install Node 18+ (https://nodejs.org) and reopen PowerShell."
}

Write-Host "==> Verifying $Url"
try {
  $health = Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 15
} catch {
  Write-Error "could not reach $Url/health - check the URL and that the service is deployed"
}
Write-Host "    reachable, v$($health.v)"

Write-Host "==> Checking the key"
try {
  Invoke-RestMethod -Uri "$Url/sessions" -Headers @{ "x-api-key" = $Key } -TimeoutSec 15 | Out-Null
} catch {
  Write-Error "API rejected that key - check MEMORY_API_KEY matches the deployed value"
}
Write-Host "    accepted"

Write-Host "==> Installing hooks to $HookDir"
New-Item -ItemType Directory -Force -Path $HookDir | Out-Null
Copy-Item (Join-Path $RepoDir ".claude\hooks\memory-sync.mjs")    $HookDir -Force
Copy-Item (Join-Path $RepoDir ".claude\hooks\memory-persist.mjs") $HookDir -Force

Write-Host "==> Merging hook config into $Settings"
New-Item -ItemType Directory -Force -Path (Split-Path $Settings) | Out-Null
if (-not (Test-Path $Settings)) { "{}" | Set-Content $Settings }
Copy-Item $Settings "$Settings.bak.$([int][double]::Parse((Get-Date -UFormat %s)))" -Force

# The merge runs in Node, not PowerShell: Windows PowerShell 5.1 has no
# `ConvertFrom-Json -AsHashtable`, and Node is already required here anyway
# because the hooks themselves are .mjs.
# An absolute path with forward slashes is what works across the shells Claude
# Code may invoke the hook through (Git Bash, WSL, PowerShell).
$hooksForCmd = $HookDir -replace '\\', '/'
& node (Join-Path $RepoDir "scripts\merge-settings.mjs") $Settings $hooksForCmd
if ($LASTEXITCODE -ne 0) {
  Write-Error "could not merge $Settings - it has been left untouched (a backup sits alongside it)"
}
Write-Host "    done (previous file backed up alongside it)"

Write-Host "==> Persisting env vars"
[Environment]::SetEnvironmentVariable("MEMORY_API_URL", $Url, "User")
[Environment]::SetEnvironmentVariable("MEMORY_API_KEY", $Key, "User")
Write-Host "    set for the current user"

Write-Host ""
Write-Host "Done. Open a new terminal, then confirm with:"
Write-Host ""
Write-Host '  curl.exe -H "x-api-key: $env:MEMORY_API_KEY" "$env:MEMORY_API_URL/sessions"'
Write-Host ""
Write-Host "Every Claude Code session on this machine will now sync shared memory."
