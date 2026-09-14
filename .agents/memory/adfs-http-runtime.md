---
name: AD FS HTTP runtime compatibility
description: Runtime compatibility constraint for the HTTP transport used by AD FS OIDC.
---

Keep the AD FS HTTP transport on an Undici release whose declared engine supports the production Node 20 runtime. Verify imports with the exact deployment Node version before upgrading it.

**Why:** Undici 8 initialized correctly in the development Node 24 environment but crashed at startup under Node 20 because a required WebIDL helper was unavailable.

**How to apply:** When upgrading Undici or the AD FS networking stack, check the package engine requirement and run a direct import/Agent smoke test with the deployment’s exact Node version.