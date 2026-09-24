---
name: release
description: ADLC phase 7 - prepare and run a release (scope, readiness checklist, changelog, release notes, RC tag, staging, go/no-go, production tag, rollback plan). Use when the user asks to cut, plan or ship a release or hotfix.
argument-hint: "X.Y.Z | rc | go-live X.Y.Z | hotfix X.Y.Z"
disable-model-invocation: true
---

# Phase 7: Release $ARGUMENTS

1. Launch the **release-manager** agent to:
   - find the last tag and list the merged PRs and features since then
   - check G5 and G6 for each feature
   - draft `docs/releases/vX.Y.Z.md` (from the template) and a `CHANGELOG.md` entry
   - fill in the readiness checklist
2. **Verify:** no feature is included without G5 and G6, CI is green on the target commit (`gh run list --branch main --limit 5`), and there's a rollback plan.
3. **RC** (`rc`, or the first run for a version): show the user the scope and checklist, and ask before creating and pushing `vX.Y.Z-rc.N`. Then list the staging deploy steps and hand off to UAT with `/uat <F-nnn>` for each user-facing feature.
4. **Go-live** (`go-live X.Y.Z`): check that **G8** is signed in each user-facing feature's `uat.md`. Present the go/no-go evidence. Only after an explicit human "go", tag `vX.Y.Z`, push the tag and run `gh release create vX.Y.Z --notes-file docs/releases/vX.Y.Z.md`.
5. **Hotfix:** branch `hotfix/vX.Y.Z` from the previous tag, run the minimum fix through `/implement` and `/test`, then follow the same RC and go-live flow with a shortened UAT, which the business owner must still agree to.
6. Update every included feature's `status.md`, and report the release record path.
