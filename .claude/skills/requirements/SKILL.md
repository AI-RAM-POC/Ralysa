---
name: requirements
description: ADLC phase 2 - build or update the PRD (REQ-nnn), RICE-prioritized roadmap, and feature list (F-nnn) from the spec and approved market insights. Use when the user asks for requirements, a PRD, backlog, roadmap, prioritization or scoping.
argument-hint: "[optional: phase or area to focus on, e.g. 'Phase 0' or 'subscriptions']"
---

# Phase 2: Product requirements

Focus: **$ARGUMENTS** (blank means the whole spec).

1. Check G1: `docs/market/summary.md` has a filled approval block. If not, warn the user that requirements will rest on unvalidated market input, and continue only if they agree.
2. Launch the **product-manager** subagent to create or update, using the templates in `docs/adlc/templates/`:
   - `docs/product/prd.md`: REQ-nnn with source, persona, surface, MoSCoW, phase and acceptance criteria
   - `docs/product/roadmap.md`: REQs → F-nnn features → spec §13 phases, with RICE scores
   - a feature list table (F-nnn, title, REQs, phase, status)
3. **Verify:**
   - every spec goal G1–G9 is covered by at least one REQ
   - no REQ contradicts the non-goals in §2.2
   - acceptance criteria are testable
   - REQ ↔ F mapping is complete
   List any gaps.
4. Report: the counts (REQs by priority, features by phase), the proposed Phase 0 features, and the open questions. Ask the product owner to approve **G2** in `prd.md`.
5. Offer to (a) create feature folders with `/feature-new` for Phase 0 features and (b) create matching GitHub issues. Do each only after the user says yes.
