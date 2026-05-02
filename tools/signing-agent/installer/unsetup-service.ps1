# unsetup-service.ps1
#
# Invoked by Uninstall.exe to stop and remove the service, drop the firewall
# rule, and (optionally) wipe ProgramData. Failures are non-fatal so the
# uninstaller always finishes — best-effort cleanup.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $InstallDir,
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [int] $RemoveData = 0
)

$ErrorActionPreference = "Continue"

$ServiceName = "PurchasingSigningAgent"
$NssmExe     = Join-Path $InstallDir "bin\nssm.exe"

if (Test-Path $NssmExe) {
  & $NssmExe stop   $ServiceName confirm 2>&1 | Out-Null
  & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
} else {
  # NSSM is gone but the service might still be registered. Fall back to sc.
  & sc.exe stop   $ServiceName 2>&1 | Out-Null
  & sc.exe delete $ServiceName 2>&1 | Out-Null
}

& netsh advfirewall firewall delete rule name="$ServiceName" 2>&1 | Out-Null

if ($RemoveData -eq 1 -and (Test-Path $DataDir)) {
  Remove-Item -Recurse -Force $DataDir
}

exit 0
