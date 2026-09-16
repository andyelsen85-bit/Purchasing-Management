---
name: Settings encryption rollout
description: Confirmed production behavior for operator-managed settings encryption and legacy-secret migration.
---

The Kubernetes/GitOps rollout using a stable, independent operator-managed settings encryption key is confirmed working, including the legacy-secret migration path.

**Why:** The production deployment was validated after restoring fail-closed key requirements and compatibility migration from the embedded-key release.

**How to apply:** Preserve the independent key across restarts and upgrades. Future encryption changes must retain an explicit migration path and should be validated against the deployed secret-management workflow.