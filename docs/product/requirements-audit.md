# Requirements implementation audit

- **Date:** 2026-09-26
- **Baseline:** `main` at `e5d80b3`
- **Scope:** every REQ-nnn in [prd.md](prd.md) (110) and the 12 rows of its non-functional requirements table
- **Method:** three read-only agents checked each requirement's acceptance criteria against the code and tests on `main`, not against feature documents. Each status cites the files and tests that support it.

## Status definitions

| Status | Meaning |
|---|---|
| **Implemented** | Every acceptance criterion is met in code on `main`, with a test |
| **Partial** | Some criteria are built and tested; the rest are missing |
| **Foundation only** | Only contracts, schemas or guardrails exist; the behaviour isn't built |
| **Not started** | No code; the planned feature and phase come from [roadmap.md](roadmap.md) |

## Summary

| Status | REQ-001–046 | REQ-047–082 | REQ-083–110 | **Total (110)** | NFR rows (12) |
|---|---|---|---|---|---|
| Implemented | 1 | 0 | 0 | **1** | 0 |
| Partial | 0 | 1 | 4 | **5** | 4 |
| Foundation only | 11 | 10 | 7 | **28** | 3 |
| Not started | 34 | 25 | 17 | **76** | 5 |

This is expected at this point: only Phase 0 features F-001 (partly) and F-002 have code.
- **Guarded placeholders:** these folders hold only a README and a placeholder `package.json`, and the `placeholder-guard` check enforces that:
  - `apps/cli`, `apps/desktop`
  - `services/agent-host`, `services/model-gateway`, `services/mcp-gateway`, `services/extraction`, `services/workspace-runtime`
  - `packages/sdk`, `packages/views`, `packages/workbench`
- **README only, not guarded:** every `packs/*`, `deploy/helm` and `deploy/terraform`.

## Phase 0 requirements

| REQ | Title | Feature | Status | Evidence | Missing |
|---|---|---|---|---|---|
| REQ-016 | IdP-only OIDC sign-in, no passwords, MFA from the IdP | F-002 | **Implemented** (Entra, mock IdP) | `tooling/repo-scripts/src/check-no-password.ts`; `services/control-plane/src/auth/sign-in.ts`, `identity-mapping.ts`; tests `sign-in.int.ts` (TC-01, -07, -09, -21, -24, -31), `sessions.int.ts` (AC-3), `openapi.test.ts` | Caveats: real-Entra run TC-F-002-28 (blocked on E-1); F-002 G6 conditions |
| REQ-095 | Credentials only in a vault, rotation without an outage | F-002, F-004 | Partial | (a) `scans.int.ts` (pg_dump, logs, deploy, `cp.credential`), CI artefact and image scans; (b) `rotation.int.ts` (TC-15, -20), soak 0/1,199 failures | The F-004 slice (provider keys, "never in prompts"); CLI and desktop clients |
| REQ-106 | English/Arabic UI, RTL, i18n keys, logical CSS | F-001 → F-021 | Partial | `tooling/eslint-config/react-ui.js` (no literal strings), logical-CSS lint tests, `check-i18n.ts`, `apps/ui-lab/e2e/mirroring.spec.ts`, `visual.spec.ts` (68 LTR/RTL snapshots), `locale.spec.ts` | Only the ui-lab gallery and an empty `apps/web` shell; locale not from the profile; native Arabic review (OQ-D8) |
| REQ-109 | WCAG 2.1 AA in both languages | F-001 → F-021 | Partial | `e2e/a11y.spec.ts` (axe), `keyboard.spec.ts`, `packages/ui/test/contrast.test.ts` | Only ui-lab components; no manual screen-reader audit; D-F001-E2E-1 and TC-F-001-25 open; browser matrix TC-F-001-16 |
| REQ-001 | CLI: device-code sign-in and streaming chat | F-005 | Foundation only | `packages/auth/src/client/idp-device.ts`, `exchange.ts`, `token-manager.ts` (no file token store); tests `client-flows.test.ts`, `token-manager.test.ts` | No CLI app, `/login`, chat, streaming, cancel, model-call audit or OS keychain store |
| REQ-010 | Local Agent Host with no provider keys | F-003 | Foundation only | `check-banned-deps.ts`, `check-provider-hosts.ts`; client-attested audit ingest `client-events.ts` | The Agent Host itself |
| REQ-024 | Model Gateway v0 | F-004 | Foundation only | `model-gateway` service identity and audience (`gateway.int.ts`), audit envelope model/token/region fields, `packages/secrets` | The gateway, the provider call, per-call audit and usage |
| REQ-011 | Agent Protocol core | F-003 | Not started | Schema generator only (`packages/protocol/src/schema/generator.ts`) | Every method and event |

## 1–6: Surfaces, Agent Host, Identity & Policy, Model Gateway, MCP/Data Gateway, Connectors

| REQ | Title | Planned | Status | Evidence / missing |
|---|---|---|---|---|
| 001 | CLI sign-in and chat | F-005 / P0 | Foundation only | See Phase 0 table |
| 002 | Full CLI command set, non-interactive | F-017 / P1 | Not started | — |
| 003 | Desktop app with local Agent Host | F-015 / P1 | Not started | The PKCE loopback flow exists for the CLI and could be reused |
| 004 | Web Chat workspace | F-016 / P1 | Foundation only | `apps/web` shell with ar/en catalogs, `LocaleProvider`, `ThemeProvider`. Missing: web sign-in, chat |
| 005 | Code workspace | F-015 / F-024 | Not started | — |
| 006 | Data and Docs workspaces | F-025, F-026 / P2 | Not started | — |
| 007 | Common UI elements | F-015, F-016 / P1 | Foundation only | Theme (`packages/ui/src/theme/ThemeProvider.tsx`), RTL `AppShell`, tokens. Missing: palette, tool/approval/blocked cards, usage indicator, branding, default layout |
| 008 | One account across surfaces | F-015, F-016 / P1 | Not started | — |
| 009 | Session handoff, responsive 360 px | F-024 / P2 | Not started | — |
| 010 | Local Agent Host, gateways only | F-003 / P0 | Foundation only | See Phase 0 table |
| 011 | Agent Protocol core | F-003 / P0 | Not started | See Phase 0 table |
| 012 | Agent Protocol complete, conformance | F-017 / P1 | Not started | — |
| 013 | Server-side isolated Agent Host | F-016 / P1 | Not started | Audit source enum only |
| 014 | Web Workspace Runtime | F-024 / P2 | Not started | — |
| 015 | Engine swappability | F-017 / P1 | Not started | — |
| 016 | IdP-only OIDC sign-in | F-002 / P0 | **Implemented** | See Phase 0 table |
| 017 | Five IdPs, OIDC and SAML, admin revocation | F-006 / P1 | Foundation only | Entra device code and PKCE loopback; `access_ttl_s` 60–3600 s; refresh re-checks Graph; self sign-out (TC-13). Missing: Okta, Ping, Keycloak, Google, SAML, desktop/web flows, admin revocation ≤ 60 s. **Gap:** the config allows a 1-minute TTL (spec minimum 5), and a group removal waits for the next refresh |
| 018 | SCIM 2.0 | F-030 / P2 | Not started | — |
| 019 | Group → profile mapping | F-006 / P1 | Foundation only | `cp.idp_group.role` (access, platform_admin), audited `directory.group_role.changed`. Missing: profiles, deny-overrides, effective-permission viewer |
| 020 | Declarative versioned policy | F-006 / P1 | Foundation only | Static `p0-static:<hash>` policy version (`auth/policy-version.ts`), immutable org region. Missing: policy language and store |
| 021 | Server-side authorization, live propagation | F-006 / P1 | Foundation only | PEP toolkit in `packages/auth` (verifier, revocation feed, principal resolver with `session_roles`), governance feed; `gateway.int.ts`. Missing: PDP, policy propagation |
| 022 | Denied tools hidden from the model | F-006 / P1 | Not started | — |
| 023 | Access requests, time-boxed grants | F-033 / P3 | Not started | — |
| 024 | Model Gateway v0 | F-004 / P0 | Foundation only | See Phase 0 table |
| 025 | Model Gateway v1 providers | F-007 / P1 | Not started | — |
| 026 | More providers, dept/personal keys | F-030 / P2 | Not started | — |
| 027 | Per-request model policy check | F-007 / P1 | Not started | — |
| 028 | Tier × classification × region routing | F-008 / P1 | Foundation only | Tier, classification and region fields in the audit envelope. Missing: routing engine |
| 029 | Pre-model PII masking | F-008 / P1 | Not started | Log redaction only |
| 030 | Model eval gate | F-008 / P1 | Not started | — |
| 031 | Provider fallback, user/dept rate limits | F-007 / P1 | Not started | Auth-route IP limits only |
| 032 | Usage metering with inference region | F-007 / P1 | Foundation only | `cp.usage_record` (migration `cp/0004`), `db.int.ts` (AC-13). No writer |
| 033 | Approved MCP server registry | F-009 / P1 | Not started | — |
| 034 | Identity-scoped MCP | F-009 / P1 | Not started | Token audience only |
| 035 | Tool calls as the user (OBO, RLS) | F-009 / P1 | Not started | — |
| 036 | Result shaping, masking, labels | F-009 / P1 | Not started | — |
| 037 | PostgreSQL, SQL Server, Oracle connectors | F-009 / P1 | Not started | — |
| 038 | More database connectors | F-036 / P3 | Not started | — |
| 039 | Technology pilot connectors | F-022 / P1 | Not started | — |
| 040 | Microsoft 365 connector | F-027 / P2 | Not started | The Graph client is for directory checks only |
| 041 | Google Workspace, IMAP/SMTP, Exchange | F-027 / P2 | Not started | — |
| 042 | Document extraction, Arabic OCR | F-026 / P2 | Not started | — |
| 043 | DMS and cloud-storage connectors | F-039 / P3 | Not started | — |
| 044 | Indexed enterprise search | F-039 / P3 | Not started | — |
| 045 | Telecom BSS/CDR connectors | F-031 / P2 | Not started | — |
| 046 | M365 Copilot coexistence | F-040 / P3 | Not started | — |

## 7–12: Skills/Memory/Plugins, Token optimization, Hooks/Approvals/Safety, Web Console, Observability/Audit/Cost, Subscriptions

| REQ | Title | Planned | Status | Evidence / missing |
|---|---|---|---|---|
| 047 | Skill folders, scoped | F-019 / P1 | Not started | — |
| 048 | Skills Library lifecycle | F-019 / P1 | Not started | — |
| 049 | Memory v1, `/me/memory` | F-019 / P1 | Not started | — |
| 050 | Memory privacy filter | F-019 / P1 | Not started | — |
| 051 | Department and project memory | F-030 / P2 | Not started | — |
| 052 | Plugins, signed marketplace | F-028 / P2 | Not started | — |
| 053 | Authoring SDK | F-040 / P3 | Not started | — |
| 054 | Prompt caching, hit rate | F-020 / P1 | Foundation only | Cache-token columns in the audit store and `cp.usage_record` |
| 055 | Deferred tool loading | F-020 / P1 | Not started | — |
| 056 | Context compaction | F-020 / P1 | Not started | — |
| 057 | Subagents, size routing | F-030 / P2 | Not started | — |
| 058 | Prompt registry, evals, A/B | F-032 / P3 | Not started | — |
| 059 | Hooks, fail closed | F-010 / P1 | Foundation only | `hook.failed`, `tool.call.denied` in the client audit allowlist. Missing: hook engine |
| 060 | Default approval rules | F-010 / P1 | Not started | Audit outcome values only |
| 061 | Never-automated classes | F-010 / P1 | Not started | — |
| 062 | Approval experience | F-010 / P1 | Foundation only | `approval.presented` action, `payload_hash` audit column. Missing: approval service and UI |
| 063 | Prompt-injection defence | F-010 / P1 | Not started | — |
| 064 | Kill switch | F-012 / P1 | Foundation only | `cp.kill_switch` (read-only), `governance/kill-switch.ts`, 423 + `tool.call.denied` in `client-events.ts`, feed every 5 s; tests `audit-ingest.test.ts`, `audit-routes.int.ts`. Missing: activate/deactivate API, gateway enforcement ≤ 30 s, banner, activation audit |
| 065 | AI-generated labels | F-012 / P1 | Not started | — |
| 066 | `/me` console page | F-018 / P1 | Foundation only | `GET /v1/me` API. Missing: the page |
| 067 | `/admin` v1 | F-018 / P1 | Foundation only | Admin-gated audit search `GET /v1/audit/events` (`audit/routes/query.ts`, `audit-routes.int.ts`). Missing: all console UI and other admin functions |
| 068 | `/dept` console | F-029 / P2 | Not started | — |
| 069 | Deep links, one-time login code | F-018 / P1 | Not started | — |
| 070 | AI register, regulator evidence pack | F-012 / P1 | Not started | — |
| 071 | Immutable audit log | F-011 / P1 | Partial | Insert-only store with ALWAYS triggers, hash chain, Transit-signed checkpoints, `audit-verify`, writer fails closed in 250 ms (`db.int.ts`, `audit-chain.test.ts`, `checkpoint.int.ts`, `audit.int.ts`). Missing: model/tool call coverage, prompt storage mode, 1–7 year retention; C1 items SEC-F002-35/36/37 before F-011 |
| 072 | Tracing, explainability | F-011 / P1 | Foundation only | W3C `traceparent`, `trace_id` on every audit event. Missing: cross-service tracing, explainability view |
| 073 | Usage and cost dashboards | F-014 / P1 | Foundation only | `cp.usage_record` schema only |
| 074 | Alerts | F-029 / P2 | Not started | Metrics go to `noopMetrics` |
| 075 | SIEM export | F-044 / P4 | Not started | — |
| 076 | Subscription catalog, named seats | F-013 / P1 | Not started | — |
| 077 | Seat pools | F-013 / P1 | Not started | — |
| 078 | Entitlement enforcement | F-013 / P1 | Foundation only | `entitlement_version` audit field only |
| 079 | Pooled allowance, spend limits | F-014 / P1 | Foundation only | `credits`, `byom`, `pool_id` columns only |
| 080 | Subscriptions v2 | F-029 / P2 | Not started | — |
| 081 | Licence key, signed licence file | F-013 / F-042 | Not started | — |
| 082 | Platform fee, pay-per-use | F-041 / P3 | Not started | — |

## 13–17: Department packs, Security & Compliance, Deployment, i18n/Accessibility, NFRs

| REQ | Title | Planned | Status | Evidence / missing |
|---|---|---|---|---|
| 083 | Pack framework | F-022 / P1 | Not started | Stub READMEs; kill switch reads a `pack_id` claim |
| 084 | Technology pilot pack | F-022 / P1 | Not started | — |
| 085 | Technology suite completion | F-036 / P3 | Not started | — |
| 086 | Revenue Assurance pack | F-031 / P2 | Not started | — |
| 087 | Fraud pack | F-034 / P3 | Not started | — |
| 088 | Wave-1 business and finance packs | F-036 / P3 | Not started | — |
| 089 | HR pack | F-037 / P3 | Not started | — |
| 090 | Wave-2 packs | F-038 / P3 | Not started | — |
| 091 | NOC pack | F-035 / P3 | Not started | — |
| 092 | Wave-3 packs | F-045 / P4 | Not started | — |
| 093 | Telecom Edition | F-046 / P4 | Not started | — |
| 094 | Sensitivity tiers, classification mapping | F-008, F-022 / P1 | Foundation only | `tier` and `classification` in the audit envelope and store; `air_gapped` deployment model |
| 095 | Credentials only in a vault | F-002, F-004 / P0 | Partial | See Phase 0 table |
| 096 | TLS 1.2+, AES-256, CMK, residency | F-023 / P1 | Foundation only | Production guards require https and verified DB TLS (TC-34); immutable org region. Missing: TLS minimum-version test, CMK, residency test |
| 097 | Purview / Google DLP labels | F-044 / P4 | Not started | — |
| 098 | Supply chain | F-028 / P2 | Foundation only | `check-banned-deps.ts`, pre-install gate, digest-pinned image. Missing: SBOM, blocking CVE scan, plugin signing |
| 099 | Compliance programme evidence | F-012 / P1 | Not started | — |
| 100 | Exit / export bundle | F-012 / P1 | Not started | — |
| 101 | Dedicated in-country cloud | F-023 / P1 | Foundation only | Control-plane Dockerfile, dev compose. Missing: Terraform, Helm |
| 102 | On-prem Kubernetes, local model | F-023 / P1 | Foundation only | Same image. Missing: Kubernetes packaging (SEC-F002-22), local runtime |
| 103 | Air-gapped deployment | F-042 / P4 | Not started | Enum value only |
| 104 | High availability 99.9 % | F-043 / P4 | Not started | — |
| 105 | In-region multi-tenant SaaS | F-043 / P4 | Partial | FORCE RLS isolation (`db.int.ts`, TC-F-002-27), immutable region trigger. Missing: foreign-region refusal, provisioning |
| 106 | English/Arabic UI, RTL | F-001 → F-021 | Partial | See Phase 0 table |
| 107 | Bidi text, locale formats | F-021 / P1 | Foundation only | `Ltr.tsx`, `<bdi>` in `T.tsx`, `mirroring.spec.ts`, `shaping.spec.ts`. Missing: bidi golden set, digit switching, Hijri dates |
| 108 | Arabic DOCX/XLSX/PDF output | F-026 / P2 | Not started | — |
| 109 | WCAG 2.1 AA | F-001 → F-021 | Partial | See Phase 0 table |
| 110 | Service levels | F-023, F-043 | Foundation only | F-002 measurements: token validation p95 0.15–2.17 ms, `/oauth2/token` p95 57 ms. Missing: gateway overhead, 1,000-user load, DR drill. Note D-1: the 250 ms audit budget fails sign-ins closed under DB load |

### Non-functional requirements table

| NFR | Status | Evidence / missing |
|---|---|---|
| Availability | Not started | — |
| Latency | Foundation only | Token-verifier p95 only; no gateway, approval or cancel paths |
| Scale | Not started | No load test |
| Web runtime | Not started | — |
| Security | Partial | SSO, vault secrets, insert-only hash-chained audit, secret and image scans. Missing: pentest, SBOM, CVE gate, CMK; non-dev blockers open (SEC-F002-38, -43..-46, -49; C1) |
| Accessibility | Partial | See REQ-109 |
| Localization | Partial | See REQ-106; Arabic names round-trip (TC-21). No golden sets yet |
| Extensibility | Not started | — |
| Recoverability | Not started | — |
| Observability | Partial | Fail-closed audit writer, client and service ingest, `inference_region`. Missing: model/tool calls, metrics exporter |
| Governance latency | Foundation only | Revocation feed stale after 60 s (TC-11); kill switch read-only. No timed propagation measurement |
| Residency | Foundation only | Immutable org region, region fields. Missing: egress check, residency test |

**Classification note (review of #60, R60-1):** REQ-001, -007, -017, -064 and -067 have real code behind them but meet none of their acceptance criteria, so they are Foundation only rather than Partial.

## Findings from the audit

1. **Roadmap status column was stale.** It listed F-001 and F-002 as "Not started"; corrected in the same change as this audit.
2. **F-001 status was stale.**
   - T13–T14 merged in PR #20 on 2026-09-25, but status.md still said "in review"; corrected.
   - F-001 still has open work: T15, T17 and T18 need a human merge (`.claude/**`, `.githooks`, `.github/CODEOWNERS`), and D-F001-E2E-1 blocks its G6.
3. **REQ-017 gap for F-006.** `access_ttl_s` accepts 60 s, below the requirement's 5-minute minimum. A group removal in Entra takes effect at the next refresh, not within a guaranteed 15 minutes.
4. **Capacity input for REQ-110.** Under database load, the 250 ms audit-write budget makes sign-ins fail closed (D-1 in #39; SEC-F002-48 in #53).
