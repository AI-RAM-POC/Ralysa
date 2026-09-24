# Ralysa Agentic Development Life Cycle (ADLC)

The ADLC is how Ralysa is built: **AI agents do the work of each phase, and humans approve the result at each gate.** This follows the product's own principle from the spec: *AI recommends, humans approve.*

## Phases

| # | Phase | Agent | Command | Main outputs | Gate / approver |
|---|---|---|---|---|---|
| 1 | Market analysis | `market-analyst` | `/market-analysis` | `docs/market/*.md` | G1 Market fit: Founder / Product owner |
| 2 | Product requirements | `product-manager` | `/requirements` | `docs/product/prd.md`, roadmap, GitHub issues | G2 Scope: Product owner |
| 3 | Architecture | `architect` | `/architecture` | `docs/architecture/*.md`, ADRs | G3 Architecture: Tech lead |
| 4 | Solution design | `solution-designer` | `/design F-xxx` | `docs/features/F-xxx/design.md` | G4 Design: Tech lead |
| 5 | Development | `developer` | `/implement F-xxx` | Code + unit tests on `feat/F-xxx-*`, PR | G5 Code review: `code-reviewer` + human reviewer |
| 6 | Testing | `test-engineer`, `security-reviewer` | `/test F-xxx` | `test-plan.md`, `test-report.md`, security notes | G6 Quality: QA lead |
| 7 | Release management | `release-manager` | `/release x.y.z` | `docs/releases/vx.y.z.md`, `CHANGELOG.md`, tag | G7 Release candidate: Release manager |
| 8 | End-user testing (UAT) | `uat-coordinator` | `/uat F-xxx` | `docs/features/F-xxx/uat.md`, UAT sign-off | G8 Go-live: Business owner |
| 9 | Operate & learn | `market-analyst`, `product-manager` | `/adlc-status` | Feedback turned into new backlog items | Loops back to phase 1 or 2 |

Phases 1–3 happen at **product level** and are updated as things change. Phases 4–8 happen **per feature** (`F-xxx`) and per release.

## Release flow (phases 6 to 8)

```
feature merged → QA passed (G6) → release candidate vX.Y.Z-rc.N on staging (G7)
              → UAT with real department users (G8) → production tag vX.Y.Z → operate
```

UAT always runs against a release candidate on staging, **before** production. A failed UAT sends the feature back to phase 4 or 5.

## Traceability IDs

| Prefix | Artifact | Where it lives |
|---|---|---|
| `MA-nnn` | Market insight / competitor finding | `docs/market/` |
| `REQ-nnn` | Product requirement | `docs/product/prd.md` + GitHub issue |
| `ADR-nnnn` | Architecture decision | `docs/architecture/adr/` |
| `F-nnn` | Feature (delivers one or more REQs) | `docs/features/F-nnn-slug/` |
| `TC-F-nnn-nn` | Test case | `docs/features/F-nnn-slug/test-plan.md` |
| `UAT-F-nnn-nn` | UAT scenario | `docs/features/F-nnn-slug/uat.md` |

Every PR names its `F-nnn`. Every feature names its `REQ-nnn`s. Every REQ names the `MA-nnn` or spec section it comes from.

## Per-feature folder

`/feature-new "<title>"` creates:

```
docs/features/F-nnn-slug/
  brief.md       problem, users, REQs covered, acceptance criteria   (phase 2)
  design.md      solution design                                     (phase 4)
  test-plan.md   test cases, then results in test-report.md          (phase 6)
  uat.md         UAT scenarios, testers, sign-off                    (phase 8)
  status.md      current phase + gate log
```

## Gates

A gate is passed only when a **named human** records approval in the artifact's `Approval` section (or in `status.md`). Agents never mark their own gates as approved. The exit checklist for each gate is in its template under [templates/](templates/).

## Rules for agents

1. Read `requirements/Ralysa_Spec.md` and this file before starting any phase.
2. Write artifacts from the templates. Don't invent new formats.
3. Keep the traceability IDs up to date in both directions.
4. Never approve a gate, merge to `main`, push tags or deploy to production without explicit human approval.
5. Open questions go into the artifact's *Open questions* section. Don't guess silently.
