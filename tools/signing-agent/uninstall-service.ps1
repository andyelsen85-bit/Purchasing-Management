param(
  [string]$ServiceName = "PurchasingSigningAgent",
  [string]$InstallDir = "C:\Program Files\PurchasingSigningAgent",
  [string]$NssmExe = (Get-Command nssm.exe -ErrorAction Stop).Source
)

$ErrorActionPreference = "SilentlyContinue"

& $NssmExe stop   $ServiceName confirm | Out-Host
& $NssmExe remove $ServiceName confirm | Out-Host

if (Test-Path $InstallDir) {
  Remove-Item -Recurse -Force $InstallDir
}

Write-Host "Uninstalled $ServiceName."
