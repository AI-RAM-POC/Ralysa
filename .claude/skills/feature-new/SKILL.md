---
name: feature-new
description: Create a new feature workspace docs/features/F-nnn-slug/ with brief, design, test-plan, uat and status files from ADLC templates, and optionally a GitHub issue. Use when starting any new feature or when the PRD lists features without folders.
argument-hint: "\"<feature title>\" [REQ-ids]"
---

# New feature

Input: **$ARGUMENTS**

1. Find the next number by listing `docs/features/` and taking the highest `F-nnn` + 1 (start at `F-001`). Build a kebab-case slug of 5 words or fewer.
2. Create `docs/features/F-nnn-slug/` containing copies of these templates from `docs/adlc/templates/`: `feature-brief.md` → `brief.md`, `design.md`, `test-plan.md`, `test-report.md`, `uat.md`, `status.md`. Replace `F-nnn` and `<title>` in every file, and set `status.md` to phase **2 – Requirements**.
3. If `docs/product/prd.md` exists, launch the **product-manager** agent to fill in `brief.md` from the REQs given, or from the ones that best match the title. Otherwise leave it as a template and say so.
4. Add the feature row to the feature table in `docs/product/roadmap.md` if that file exists.
5. Ask whether to create a GitHub issue (`gh issue create --title "F-nnn: <title>" --label feature --body-file brief.md`). Create it only if the user says yes, and write the issue URL into `status.md`.
6. Report the folder path and next step: review the brief (G2), then `/design F-nnn`.
