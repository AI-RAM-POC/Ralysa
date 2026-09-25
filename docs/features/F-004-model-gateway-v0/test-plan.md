# F-004: Model Gateway v0 (one provider, vault credentials, per-call audit): Test Plan

> Phase 6 · Owner: test-engineer

## Traceability
| AC | Test case | Level (unit/int/E2E/eval/manual) | Automated file | Surface |
|---|---|---|---|---|
| AC-1 | TC-F-004-01 | | | |

## Governance & security cases
- [ ] Unauthorized group denied at API
- [ ] Approval gate blocks side effect until approved
- [ ] Audit event written for every tool/model call
- [ ] PII masked in logs/traces
- [ ] Residency / model routing enforced
- [ ] Prompt-injection cases (documents, email, tool results)

## LLM evals
| Eval ID | Input | Expected behaviour | Rubric | Models |
|---|---|---|---|---|

## NFR checks
| NFR | Target | Method |
|---|---|---|
| Gateway overhead p95 | < 100 ms | |
| Accessibility | WCAG 2.1 AA | axe + Playwright |
| RTL / Arabic | Correct layout & text | |

## Test data & environment
