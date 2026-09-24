---
name: adlc-status
description: Show where every feature and product-level artifact is in the Ralysa ADLC - current phase, gate approvals, blockers, and the recommended next command. Use when the user asks for status, progress, what's next, or a lifecycle overview.
argument-hint: "[optional F-nnn]"
---

# ADLC status

1. **Product level.** For each of `docs/market/summary.md` (G1), `docs/product/prd.md` (G2) and the ADRs in `docs/architecture/adr/` (G3: count them by status), report whether it exists and whether its approval block is filled in.
2. **Features.** For each `docs/features/F-*/` (or only $ARGUMENTS), read `status.md` and the approval blocks in brief, design, test-report and uat. Work out the current phase and the next gate. Cross-check against git and GitHub where it's cheap: the branch exists, the PR state (`gh pr list --search F-nnn`), and open `bug`/`uat` issues.
3. **Releases.** Report the latest tags (`git tag --sort=-creatordate | head`) and the release records in `docs/releases/`.
4. Output one compact table (feature | phase | last gate passed | blocker | next command), followed by the top 3 recommended actions. Point out any inconsistency, such as code merged without G5, or a release that includes a feature without G6.

This is a read-only report. Change nothing.
