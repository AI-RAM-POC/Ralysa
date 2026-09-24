## Feature
- Feature: F-
- Requirements: REQ-
- Design: docs/features/F-nnn-*/design.md
- Tasks: F-nnn-T

## What changed

## Governance checklist
- [ ] Policy enforced server-side (not UI-only)
- [ ] Audit events emitted for new tool/model calls
- [ ] Side-effecting actions go through approval
- [ ] No secrets or PII in code, logs or tests
- [ ] Residency / model routing respected
- [ ] Untrusted content (docs/email/tool output) cannot trigger tools unchecked
- [ ] UI: i18n keys, RTL-safe CSS, accessible (or N/A)

## Test evidence
<paste `pnpm lint && pnpm test && pnpm build` output and any E2E/eval results>

## code-reviewer verdict
<Approve / Approve with nits / Request changes, with summary>
