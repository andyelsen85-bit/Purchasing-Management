# setup-service.ps1
#
# Invoked by installer.nsi during install. Writes config.json, ensures TLS
# material exists in ProgramData (generating a self-signed PFX if the
# operator did not supply one), registers the agent as a Windows service via
# the bundled NSSM, opens the firewall, and verifies the service reaches the
# Running state. Any failure surfaces as a non-zero exit code so the NSIS
# installer can abort and roll back.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $InstallDir,
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [string] $Token        = "",
  [int]    $Port         = 9443,
  [string] $CertSource   = "",
  [string] $KeySource    = "",
  [string] $CertTemplate = "WebServer",
  [string] $CaConfig     = ""
)

$ErrorActionPreference = "Stop"

$ServiceName = "PurchasingSigningAgent"
$NodeExe     = Join-Path $InstallDir "node\node.exe"
$NssmExe     = Join-Path $InstallDir "bin\nssm.exe"
$IndexJs     = Join-Path $InstallDir "index.js"
$ConfigPath  = Join-Path $DataDir    "config.json"
$CertDest    = Join-Path $DataDir    "agent.crt"
$KeyDest     = Join-Path $DataDir    "agent.key"
$PfxDest     = Join-Path $DataDir    "agent.pfx"

function Assert-Native {
  param([string] $Description)
  if ($LASTEXITCODE -ne 0) {
    throw ("{0} failed (exit {1})." -f $Description, $LASTEXITCODE)
  }
}

if (-not (Test-Path $DataDir)) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

# Lock the data directory down to Administrators + SYSTEM. The token, TLS
# key, and PFX passphrase live here, so disable inheritance and remove
# everything else.
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
  Write-Host ("Generated random shared token (length {0})." -f $Token.Length)
}

# Stage TLS material when paths were provided. We never overwrite an existing
# cert/key so re-running the installer to rotate other settings is safe.
if ($CertSource -and (Test-Path $CertSource) -and -not (Test-Path $CertDest)) {
  Copy-Item -Force $CertSource $CertDest
  Write-Host ("Installed TLS cert: {0}" -f $CertDest)
}
if ($KeySource -and (Test-Path $KeySource) -and -not (Test-Path $KeyDest)) {
  Copy-Item -Force $KeySource $KeyDest
  Write-Host ("Installed TLS key:  {0}" -f $KeyDest)
}

# Decide which TLS path the service will use. Cert+key PEM is preferred when
# the operator supplied them. Otherwise we generate a self-signed PFX so the
# service can come up immediately; the operator can replace agent.pfx (or
# drop in agent.crt/agent.key) and restart later.
$pfxPassphrase = ""
$useCertKey    = (Test-Path $CertDest) -and (Test-Path $KeyDest)
if (-not $useCertKey) {
  if (Test-Path $PfxDest) {
    Write-Host ("Re-using existing TLS PFX: {0}" -f $PfxDest)
    # Read the previously-written passphrase out of config.json if present.
    if (Test-Path $ConfigPath) {
      try {
        $existing = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($existing.tlsPfxPassphrase) { $pfxPassphrase = [string]$existing.tlsPfxPassphrase }
      } catch { }
    }
  } else {
    Write-Host "No TLS cert/key supplied -- generating a self-signed PFX."
    $hostname = [System.Net.Dns]::GetHostName()
    $sans = New-Object System.Collections.Generic.List[string]
    $sans.Add($hostname) | Out-Null
    $sans.Add("localhost") | Out-Null
    try {
      $domain = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).Domain
      if ($domain -and $domain.ToUpper() -ne "WORKGROUP") {
        $sans.Add(("{0}.{1}" -f $hostname, $domain)) | Out-Null
      }
    } catch { }

    $cert = New-SelfSignedCertificate `
      -DnsName $sans `
      -CertStoreLocation Cert:\LocalMachine\My `
      -KeyExportPolicy Exportable `
      -KeyAlgorithm RSA -KeyLength 2048 `
      -NotAfter (Get-Date).AddYears(5) `
      -Subject ("CN={0} Purchasing Signing Agent" -f $hostname)
    if (-not $cert) { throw "New-SelfSignedCertificate did not return a certificate." }

    $passBytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($passBytes)
    $pfxPassphrase = -join ($passBytes | ForEach-Object { '{0:x2}' -f $_ })
    $secure = ConvertTo-SecureString -String $pfxPassphrase -Force -AsPlainText
    Export-PfxCertificate `
      -Cert ("Cert:\LocalMachine\My\{0}" -f $cert.Thumbprint) `
      -FilePath $PfxDest `
      -Password $secure | Out-Null
    Remove-Item -Force ("Cert:\LocalMachine\My\{0}" -f $cert.Thumbprint)
    Write-Host ("Wrote self-signed PFX: {0} (SAN: {1})" -f $PfxDest, ($sans -join ', '))
  }
}

# Write config.json. We always prefer cert/key PEM if both are present;
# otherwise we record the PFX path/passphrase. The agent reads either form.
$cfg = [ordered]@{
  port           = $Port
  sharedToken    = $Token
  certTemplate   = $CertTemplate
  caConfig       = $CaConfig
  allowedOrigins = @()
}
if ($useCertKey) {
  $cfg.tlsCertPath = $CertDest
  $cfg.tlsKeyPath  = $KeyDest
} else {
  $cfg.tlsPfxPath       = $PfxDest
  $cfg.tlsPfxPassphrase = $pfxPassphrase
}
$json = $cfg | ConvertTo-Json -Depth 5
Set-Content -Path $ConfigPath -Value $json -Encoding UTF8
Write-Host ("Wrote {0}" -f $ConfigPath)

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

# AppEnvironmentExtra accepts multiple "KEY=VALUE" tokens. NSSM rewrites
# them as a NUL-separated multi-string in the service registry key. We pass
# the agent its config path plus whichever TLS path style we picked.
$envArgs = @("CONFIG_PATH=$ConfigPath")
if ($useCertKey) {
  $envArgs += "TLS_CERT_PATH=$CertDest"
  $envArgs += "TLS_KEY_PATH=$KeyDest"
} else {
  $envArgs += "TLS_PFX_PATH=$PfxDest"
  $envArgs += "TLS_PFX_PASSPHRASE=$pfxPassphrase"
}
& $NssmExe set $ServiceName AppEnvironmentExtra @envArgs | Out-Host
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
