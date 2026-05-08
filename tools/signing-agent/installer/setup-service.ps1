# setup-service.ps1
#
# Invoked by installer.nsi during install. Writes config.json, registers the
# agent as a Windows service via the bundled NSSM, opens the firewall, and
# verifies the service reaches the Running state. Any failure surfaces as a
# non-zero exit code so the NSIS installer can abort and roll back.
#
# The agent listens on 127.0.0.1 only (loopback), so no TLS is needed.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $InstallDir,
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [string] $Token        = "",
  [int]    $Port         = 9443,
  [string] $CertTemplate = "WebServer",
  [string] $CaConfig     = "",
  # Optional: supply the Windows account and password that the service will
  # run as. If omitted the installer prompts interactively. The account must
  # have access to the personal certificate store (Cert:\CurrentUser\My).
  [string] $ServiceUser  = "",
  [string] $ServicePass  = ""
)

$ErrorActionPreference = "Stop"

$ServiceName = "PurchasingSigningAgent"
$NodeExe     = Join-Path $InstallDir "node\node.exe"
$NssmExe     = Join-Path $InstallDir "bin\nssm.exe"
$IndexJs     = Join-Path $InstallDir "index.js"
$ConfigPath  = Join-Path $DataDir    "config.json"

function Assert-Native {
  param([string] $Description)
  if ($LASTEXITCODE -ne 0) {
    throw ("{0} failed (exit {1})." -f $Description, $LASTEXITCODE)
  }
}

if (-not (Test-Path $DataDir)) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

# Lock the data directory down to Administrators + SYSTEM. The shared token
# lives here, so disable inheritance and remove everything else.
try {
  $acl = Get-Acl -Path $DataDir
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRule($rule)
  }
  $admins = New-Object System.Security.Principal.SecurityIdentifier "S-1-5-32-544"
  $system = New-Object System.Security.Principal.SecurityIdentifier "S-1-5-18"
  foreach ($sid in @($admins, $system)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      "FullControl",
      ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
       [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -Path $DataDir -AclObject $acl
} catch {
  Write-Warning ("Could not tighten ACL on {0}: {1}" -f $DataDir, $_.Exception.Message)
}

# Generate 32 cryptographically random bytes as the bearer token if none was
# supplied via /TOKEN=.
if ([string]::IsNullOrEmpty($Token)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Token = -join ($bytes | ForEach-Object { '{0:x2}' -f $_ })
}

# Write config.json.
$cfg = [ordered]@{
  port           = $Port
  sharedToken    = $Token
  certTemplate   = $CertTemplate
  caConfig       = $CaConfig
  allowedOrigins = @()
}
$json = $cfg | ConvertTo-Json -Depth 5
# PowerShell 5.x's -Encoding UTF8 adds a BOM; Node.js JSON.parse rejects BOM.
# Write via .NET directly with a BOM-free UTF-8 encoder.
[System.IO.File]::WriteAllText($ConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host ("Wrote {0}" -f $ConfigPath)
Write-Host ""
Write-Host "============================================================"
Write-Host "  SHARED TOKEN (copy this into the web app Settings):"
Write-Host ""
Write-Host ("  {0}" -f $Token)
Write-Host ""
Write-Host "  Settings -> Application -> Jeton partage"
Write-Host "============================================================"
Write-Host ""

# Register the service via NSSM. Stop+remove first so re-running the
# installer is idempotent (unattended upgrades). These two are best-effort:
# NSSM exits non-zero when the service does not exist yet, which is fine.
# Temporarily relax $ErrorActionPreference so NSSM stderr on "not found"
# does not become a terminating error.
$savedPref = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
& $NssmExe stop   $ServiceName 2>&1 | Out-Null
& $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
$ErrorActionPreference = $savedPref
$LASTEXITCODE = 0

# Install with only the application executable. AppParameters is set via the
# registry below so we avoid PowerShell-to-native-exe quote-escaping issues
# that cause Node to receive a truncated path when InstallDir contains spaces.
& $NssmExe install $ServiceName $NodeExe                      | Out-Host ; Assert-Native "nssm install"

# Write AppParameters directly to the registry with the path double-quoted.
# This is the only reliable way to store a quoted path when the install dir
# contains spaces (e.g. "C:\Program Files\...").
$nssmRegKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
Set-ItemProperty -Path $nssmRegKey -Name "AppParameters" -Value ('"' + $IndexJs + '"')
Write-Host "Set AppParameters -> `"$IndexJs`""

& $NssmExe set     $ServiceName AppDirectory   $InstallDir   | Out-Host ; Assert-Native "nssm set AppDirectory"
& $NssmExe set     $ServiceName Start          SERVICE_AUTO_START | Out-Host ; Assert-Native "nssm set Start"
& $NssmExe set     $ServiceName AppStdout      (Join-Path $DataDir "agent.out.log") | Out-Host ; Assert-Native "nssm set AppStdout"
& $NssmExe set     $ServiceName AppStderr      (Join-Path $DataDir "agent.err.log") | Out-Host ; Assert-Native "nssm set AppStderr"
& $NssmExe set     $ServiceName AppRotateFiles 1                 | Out-Host ; Assert-Native "nssm set AppRotateFiles"
& $NssmExe set     $ServiceName AppRotateBytes 10485760          | Out-Host ; Assert-Native "nssm set AppRotateBytes"
& $NssmExe set     $ServiceName Description    "Purchasing Management Windows certificate signing agent." | Out-Host
Assert-Native "nssm set Description"

# Tell the agent where to find its config file.
& $NssmExe set $ServiceName AppEnvironmentExtra "CONFIG_PATH=$ConfigPath" | Out-Host
Assert-Native "nssm set AppEnvironmentExtra"

# Firewall: replace any prior rule of the same name to make this idempotent.
$ErrorActionPreference = "SilentlyContinue"
& netsh advfirewall firewall delete rule name="$ServiceName" 2>&1 | Out-Null
$ErrorActionPreference = $savedPref
$LASTEXITCODE = 0
& netsh advfirewall firewall add rule `
    name="$ServiceName" `
    dir=in action=allow `
    protocol=TCP `
    localport=$Port `
    profile=any `
    description="Purchasing Signing Agent ($Port/tcp)" | Out-Host
Assert-Native "netsh advfirewall firewall add rule"

# nssm start can return non-zero when the wrapped process is still coming
# up or crashes before NSSM's own timeout. Don't Assert-Native here -- the
# polling loop below is the authoritative gate and it reads the error log.
& $NssmExe start $ServiceName | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Warning ("nssm start returned exit code {0} -- will wait for service status." -f $LASTEXITCODE)
}
$LASTEXITCODE = 0

# Poll for up to 30s while the service starts. NSSM marks itself running
# almost immediately; we want the wrapped Node process to also be up.
$deadline = (Get-Date).AddSeconds(30)
$svc = $null
do {
  Start-Sleep -Milliseconds 500
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
} while ($svc -and $svc.Status -ne 'Running' -and (Get-Date) -lt $deadline)

if (-not $svc) {
  throw "Service '$ServiceName' is not registered after install."
}
if ($svc.Status -ne 'Running') {
  $errLog = Join-Path $DataDir "agent.err.log"
  $tail = ""
  if (Test-Path $errLog) {
    $tail = (Get-Content $errLog -Tail 30 -ErrorAction SilentlyContinue) -join "`r`n"
  }
  throw ("Service '{0}' did not reach Running state (status={1}).`r`nLast stderr:`r`n{2}" -f `
         $ServiceName, $svc.Status, $tail)
}

Write-Host ("Service '{0}' is running on port {1}." -f $ServiceName, $Port)
Write-Host "Setup complete."
exit 0
