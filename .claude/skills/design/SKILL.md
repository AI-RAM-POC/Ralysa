---
name: design
description: ADLC phase 4 - produce the solution design for one feature (contracts, data, flows, governance, UI, test strategy, rollout, task breakdown). Use when the user asks to design a feature or before implementing anything non-trivial.
argument-hint: "F-nnn"
---

# Phase 4: Solution design for $ARGUMENTS

1. Open `docs/features/$ARGUMENTS-*/`. Check that `brief.md` has acceptance criteria and **G2** approval. If approval is missing, tell the user and ask whether to proceed anyway.
2. Launch the **solution-designer** agent to write `design.md`.
3. If the design adds or changes a cross-service contract, a data store or a technology, launch the **architect** to review it for fit with the ADRs (appending a *Review notes* section). If it touches auth, gateways, connectors, sandboxes or audit, also launch the **security-reviewer** to write `security.md`.
4. **Verify:**
   - every acceptance criterion maps to a design element and a test
   - the task breakdown is ordered, with a definition of done per task
   - governance (policy, audit, approvals, residency) is explicit
   - any RTL/i18n need is covered
5. Update `status.md` to phase **4 – Design (awaiting G4)**. Report a summary, the tasks and their estimates, the risks and open questions, and ask the tech lead to approve **G4**. Next step: `/implement $ARGUMENTS`.
