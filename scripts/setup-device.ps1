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

# Hooks run through a shell that understands $HOME; an absolute path with
# forward slashes is the portable choice across Git Bash, WSL and PowerShell.
$hookPathSync    = ($HookDir + "\memory-sync.mjs")    -replace '\\', '/'
$hookPathPersist = ($HookDir + "\memory-persist.mjs") -replace '\\', '/'

$cfg = Get-Content $Settings -Raw | ConvertFrom-Json -AsHashtable
if (-not $cfg) { $cfg = @{} }
if (-not $cfg.hooks) { $cfg.hooks = @{} }

foreach ($pair in @(@("SessionStart", $hookPathSync, "memory-sync.mjs"),
                    @("SessionEnd",   $hookPathPersist, "memory-persist.mjs"))) {
  $event = $pair[0]; $path = $pair[1]; $script = $pair[2]
  $existing = @()
  if ($cfg.hooks[$event]) {
    # Drop any prior Cammy entry so re-running updates instead of duplicating.
    $existing = @($cfg.hooks[$event] | Where-Object {
      -not (@($_.hooks) | Where-Object { "$($_.command)" -like "*$script*" })
    })
  }
  $cfg.hooks[$event] = $existing + @(@{ hooks = @(@{ type = "command"; command = "node `"$path`"" }) })
}
($cfg | ConvertTo-Json -Depth 10) | Set-Content $Settings
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
