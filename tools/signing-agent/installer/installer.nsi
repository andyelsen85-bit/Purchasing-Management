; -----------------------------------------------------------------------------
; Purchasing Signing Agent — Windows installer (NSIS)
;
; Builds an EXE that:
;   * extracts the agent + a bundled Node.js node.exe + NSSM
;   * runs setup-service.ps1 to write config.json, copy TLS files,
;     register the service, open the firewall, and start the service
;   * registers an uninstaller in Add/Remove Programs
;
; Silent install (no prompts):  SigningAgent-Setup.exe /S
; Optional command-line switches (use both /S and these for unattended):
;   /TOKEN=<bearer>          shared bearer token (default: random 32B hex)
;   /PORT=<port>             HTTPS port (default: 9443)
;   /CERT=<file>             path to TLS cert PEM to install
;   /KEY=<file>              path to TLS key PEM to install
;   /TEMPLATE=<name>         certreq.exe template (default: WebServer)
;   /CACONFIG=<value>        certreq.exe -config string (default: empty)
;   /D=<dir>                 install directory (NSIS built-in, must be last)
; -----------------------------------------------------------------------------

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef VERSION
  !define VERSION "0.2.0"
!endif
!define VERSION_FULL "${VERSION}.0"

Name "Purchasing Signing Agent ${VERSION}"
OutFile "dist\SigningAgent-Setup-${VERSION}.exe"
Unicode true
RequestExecutionLevel admin
InstallDir "$PROGRAMFILES64\PurchasingSigningAgent"
InstallDirRegKey HKLM "Software\PurchasingSigningAgent" "InstallDir"
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
BrandingText "Purchasing Management"

VIProductVersion "${VERSION_FULL}"
VIAddVersionKey "ProductName"     "Purchasing Signing Agent"
VIAddVersionKey "FileDescription" "Windows-side HTTPS agent that signs CSRs via certreq.exe."
VIAddVersionKey "FileVersion"     "${VERSION_FULL}"
VIAddVersionKey "ProductVersion"  "${VERSION_FULL}"
VIAddVersionKey "CompanyName"     "Purchasing Management"
VIAddVersionKey "LegalCopyright"  "(c) Purchasing Management"

!define SERVICE_NAME "PurchasingSigningAgent"
!define DATA_SUBDIR  "PurchasingSigningAgent"

Var ARG_TOKEN
Var ARG_PORT
Var ARG_CERT
Var ARG_KEY
Var ARG_TEMPLATE
Var ARG_CACONFIG
Var DATA_DIR
Var PSARGS

!define MUI_ICON   "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!define MUI_ABORTWARNING

!define MUI_FINISHPAGE_TEXT "Purchasing Signing Agent ${VERSION} has been installed.$\r$\n$\r$\nConfig: %ProgramData%\PurchasingSigningAgent\config.json$\r$\nService: PurchasingSigningAgent$\r$\n$\r$\nIf no TLS certificate / key was supplied, drop agent.crt and agent.key into that folder, then start the service."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  ; SetShellVarContext all rebinds $APPDATA to %ProgramData% (machine-wide)
  ; instead of the per-user %APPDATA%. We want the agent's data on the
  ; machine, since the service runs as LocalSystem.
  SetShellVarContext all
  StrCpy $DATA_DIR "$APPDATA\${DATA_SUBDIR}"

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/TOKEN="    $ARG_TOKEN
  ${GetOptions} $R0 "/PORT="     $ARG_PORT
  ${GetOptions} $R0 "/CERT="     $ARG_CERT
  ${GetOptions} $R0 "/KEY="      $ARG_KEY
  ${GetOptions} $R0 "/TEMPLATE=" $ARG_TEMPLATE
  ${GetOptions} $R0 "/CACONFIG=" $ARG_CACONFIG
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File "payload\index.js"
  File "payload\package.json"
  File "payload\config.example.json"
  File "payload\setup-service.ps1"
  File "payload\unsetup-service.ps1"
  File "payload\install-service.ps1"
  File "payload\uninstall-service.ps1"
  File "payload\LICENSE.txt"
  File "payload\README.txt"
  File /r "payload\node_modules"

  SetOutPath "$INSTDIR\node"
  File "payload\node\node.exe"

  SetOutPath "$INSTDIR\bin"
  File "payload\bin\nssm.exe"

  CreateDirectory "$DATA_DIR"

  ; Compose the PowerShell argument list, only forwarding switches actually given.
  StrCpy $PSARGS '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\setup-service.ps1" -InstallDir "$INSTDIR" -DataDir "$DATA_DIR"'
  ${If} $ARG_TOKEN != ""
    StrCpy $PSARGS '$PSARGS -Token "$ARG_TOKEN"'
  ${EndIf}
  ${If} $ARG_PORT != ""
    StrCpy $PSARGS '$PSARGS -Port $ARG_PORT'
  ${EndIf}
  ${If} $ARG_CERT != ""
    StrCpy $PSARGS '$PSARGS -CertSource "$ARG_CERT"'
  ${EndIf}
  ${If} $ARG_KEY != ""
    StrCpy $PSARGS '$PSARGS -KeySource "$ARG_KEY"'
  ${EndIf}
  ${If} $ARG_TEMPLATE != ""
    StrCpy $PSARGS '$PSARGS -CertTemplate "$ARG_TEMPLATE"'
  ${EndIf}
  ${If} $ARG_CACONFIG != ""
    StrCpy $PSARGS '$PSARGS -CaConfig "$ARG_CACONFIG"'
  ${EndIf}

  DetailPrint "Running setup-service.ps1..."
  nsExec::ExecToLog 'powershell.exe $PSARGS'
  Pop $R0
  ${If} $R0 != 0
    DetailPrint "FATAL: setup-service.ps1 exited with code $R0 — rolling back."
    ; Best-effort cleanup: remove the registered service and extracted files
    ; so the host is left in a clean state for a retry.
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\unsetup-service.ps1" -InstallDir "$INSTDIR" -DataDir "$DATA_DIR" -RemoveData 0'
    Pop $R2
    SetOutPath "$TEMP"
    RMDir /r "$INSTDIR"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP "Installation failed: setup-service.ps1 returned exit code $R0.$\r$\n$\r$\nReview the install details for the failure reason, fix it, and run the installer again."
    ${EndIf}
    Abort "Setup failed."
  ${EndIf}

  ; Reference info for the uninstaller and Add/Remove Programs.
  WriteRegStr HKLM "Software\PurchasingSigningAgent" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\PurchasingSigningAgent" "DataDir"    "$DATA_DIR"
  WriteRegStr HKLM "Software\PurchasingSigningAgent" "Version"    "${VERSION}"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "DisplayName"          "Purchasing Signing Agent"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "DisplayVersion"       "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "Publisher"            "Purchasing Management"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "InstallLocation"      "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "UninstallString"      '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  SetShellVarContext all

  ReadRegStr $R0 HKLM "Software\PurchasingSigningAgent" "DataDir"
  ${If} $R0 == ""
    StrCpy $R0 "$APPDATA\${DATA_SUBDIR}"
  ${EndIf}

  StrCpy $R1 "0"
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "Also remove configuration and logs in $R0?" IDNO +2
      StrCpy $R1 "1"
  ${EndIf}

  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\unsetup-service.ps1" -InstallDir "$INSTDIR" -DataDir "$R0" -RemoveData $R1'
  Pop $R2

  RMDir /r "$INSTDIR"
  ${If} $R1 == "1"
    RMDir /r "$R0"
  ${EndIf}

  DeleteRegKey HKLM "Software\PurchasingSigningAgent"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}"
SectionEnd
