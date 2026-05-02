Purchasing Signing Agent — installed-file layout
================================================

This file is dropped into the install directory so operators can find their
way around without going back to the documentation site.

Install layout:

  C:\Program Files\PurchasingSigningAgent\
      index.js                  Node entry point
      package.json
      node_modules\             Bundled dependencies (ws)
      node\node.exe             Pinned Node.js runtime
      bin\nssm.exe              Service manager
      setup-service.ps1         Re-run with -InstallDir / -DataDir to repair
      unsetup-service.ps1
      install-service.ps1       Manual NSSM install (legacy, optional)
      uninstall-service.ps1
      Uninstall.exe             Add/Remove Programs entry point
      LICENSE.txt
      README.txt                You are here

  C:\ProgramData\PurchasingSigningAgent\   (locked to Administrators + SYSTEM)
      config.json               Generated at install time
      agent.crt                 TLS cert (drop in if not provided to the installer)
      agent.key                 TLS private key
      agent.out.log             Service stdout (rotated at ~10 MB)
      agent.err.log             Service stderr

Common service operations:

  * Show status       : sc.exe query PurchasingSigningAgent
  * Start             : "C:\Program Files\PurchasingSigningAgent\bin\nssm.exe" start PurchasingSigningAgent
  * Stop              : "C:\Program Files\PurchasingSigningAgent\bin\nssm.exe" stop  PurchasingSigningAgent
  * Edit settings GUI : "C:\Program Files\PurchasingSigningAgent\bin\nssm.exe" edit  PurchasingSigningAgent
  * Tail logs         : Get-Content C:\ProgramData\PurchasingSigningAgent\agent.err.log -Wait

Health check from the agent host:

  curl.exe -k -H "Authorization: Bearer <token>" https://localhost:9443/healthz

The token is in config.json. Treat config.json as a secret.
