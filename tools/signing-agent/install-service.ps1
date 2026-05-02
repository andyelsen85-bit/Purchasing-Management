# Install the Purchasing Signing Agent as a Windows service via NSSM.
#
# Usage (run as Administrator):
#   powershell -ExecutionPolicy Bypass -File install-service.ps1
#
# Requires:
#   - Node.js LTS on PATH
#   - NSSM (https://nssm.cc/) on PATH
#   - config.json next to index.js

param(
  [string]$ServiceName = "PurchasingSigningAgent",
  [string]$InstallDir = "C:\Program Files\PurchasingSigningAgent",
  [string]$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source,
  [string]$NssmExe = (Get-Command nssm.exe -ErrorAction Stop).Source
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

# Copy source files
Copy-Item -Force -Recurse "$PSScriptRoot\index.js"          "$InstallDir\index.js"
Copy-Item -Force -Recurse "$PSScriptRoot\package.json"      "$InstallDir\package.json"
if (Test-Path "$PSScriptRoot\config.json") {
  Copy-Item -Force "$PSScriptRoot\config.json" "$InstallDir\config.json"
} elseif (-not (Test-Path "$InstallDir\config.json")) {
  Copy-Item -Force "$PSScriptRoot\config.example.json" "$InstallDir\config.json"
  Write-Warning "Copied config.example.json to config.json — edit it before starting the service."
}

Push-Location $InstallDir
try {
  & npm install --omit=dev | Out-Host
} finally {
  Pop-Location
}

# Stop & remove any existing service so we can re-install cleanly
$existing = & $NssmExe status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
  & $NssmExe stop   $ServiceName confirm | Out-Host
  & $NssmExe remove $ServiceName confirm | Out-Host
}

& $NssmExe install $ServiceName $NodeExe "`"$InstallDir\index.js`""
& $NssmExe set     $ServiceName AppDirectory  $InstallDir
& $NssmExe set     $ServiceName Start         SERVICE_AUTO_START
& $NssmExe set     $ServiceName AppStdout     "$InstallDir\agent.out.log"
& $NssmExe set     $ServiceName AppStderr     "$InstallDir\agent.err.log"
& $NssmExe set     $ServiceName AppRotateFiles 1
& $NssmExe set     $ServiceName AppRotateBytes 10485760

& $NssmExe start $ServiceName

Write-Host "Installed and started $ServiceName."
