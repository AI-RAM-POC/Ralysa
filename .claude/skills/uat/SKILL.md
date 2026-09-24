---
name: uat
description: ADLC phase 8 - end-user / user acceptance testing. Prepare UAT scenarios, testers, data and bilingual tester guide for a feature on a release candidate; triage feedback; produce the UAT summary and go-live sign-off request. Use for UAT planning, collecting business user feedback, or sign-off.
argument-hint: "F-nnn [plan | triage | summary]"
---

# Phase 8: UAT for $ARGUMENTS

The mode defaults to `plan`.

- **plan:** check that the feature is in a release candidate (`docs/releases/*-rc*` or its `status.md`) and that G6 is approved. Launch the **uat-coordinator** to fill in `uat.md`: testers by persona, business-language scenarios `UAT-F-nnn-nn`, environment and test accounts, masked data, the bilingual (EN/AR) tester guide and the timeline. Verify that every user-visible acceptance criterion has a scenario, and that no production personal data is used.
- **triage:** collect open issues labelled `uat` for this feature (`gh issue list --label uat --search F-nnn`) plus any feedback the user pastes. Launch the **uat-coordinator** to classify each item as Defect, Change request or Training, update `uat.md`, and propose the next actions. Defects go back to `/implement`, and change requests go to the backlog via the product-manager.
- **summary:** launch the **uat-coordinator** to write the UAT summary and recommendation (Accept / Accept with conditions / Reject).

At the end, update `status.md` to phase **8 – UAT**. Tell the user exactly who has to sign **G8** (the business owner of the department) and that go-live is blocked until they do. Next step: `/release go-live X.Y.Z`.
