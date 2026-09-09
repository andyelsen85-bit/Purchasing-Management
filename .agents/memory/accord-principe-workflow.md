---
name: Accord de principe workflow
description: Durable GT Invest rule for suspending and later resuming requests decided as Accord de principe.
---

A GT Invest decision of **Accord de principe** must remain at GT Invest and must not advance through the generic next-step action. The decision must appear in the meeting Compte Rendu.

**Why:** The user confirmed that these requests are intentionally suspended and require a separate later validation before the normal workflow can continue.

**How to apply:** Preserve a distinct Accord de principe state, include it in regenerated meeting CRs, block ordinary progression, and use an explicit audited validation action to resume the configured next step.