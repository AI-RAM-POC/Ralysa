# F-004: Model Gateway v0 (one provider, vault credentials, per-call audit): Feature Brief

> Phase 2 · Owner: product-manager · Release phase: **0 (Foundations)** · Source: [PRD](../../product/prd.md) (G2 approved 2026-09-25 with conditions), [roadmap](../../product/roadmap.md), spec §4 D4, §5.1, §6.5.2, §6.5.3, §8 (Secrets, Data residency), §12, §13 Phase 0; MA-302, summary R-5(c) (DV-12)
> MoSCoW: Must (REQ-024, REQ-095) · RICE 10.7 (R 10 · I 2 · C 80 % · E 1.5)

## Problem

Enterprises won't let an AI product put provider keys on laptops, send prompts to unknown regions, or make model calls nobody can attribute (spec §4 D4, §8; MA-302). Regulators in the pilot market ask where inference happens (DV-12, summary R-5(c)).

The Model Gateway is the single choke point that makes each model call:
- authenticated as a real user,
- served with a credential only the server holds,
- sent to a known endpoint in a known region,
- recorded for audit and usage.

Phase 0 needs the smallest version that proves this end to end: one provider, one approved model, vault-held credentials, and a complete audit and usage record for every call. Phase 1 (F-007, F-008) then adds more providers, policy checks, routing and fallback without changing the guarantees.

## Personas & surfaces

| Persona | Need |
|---|---|
| DEV (Phase 0 user, via CLI and Agent Host) | Streaming answers from an approved Claude model without ever handling a key. |
| PA | Configure the one approved model, its endpoint and region. Hold the provider credential in the vault and rotate it without downtime. See every call attributed to a user and region. |
| ASR (indirect) | Proof that 100 % of model calls are audited with model, tokens and inference region. |

**Surfaces:** Service only. Phase 0 callers are the local Agent Host (F-003) on behalf of the CLI (F-005).

## Requirements covered

| REQ | Phase 0 scope in this feature | Deferred |
|---|---|---|
| REQ-024 Model Gateway v0: one provider (Claude via Anthropic API or Vertex), vault credentials, per-call usage record and audit event (Must, Phase 0) | All criteria (a)–(c), plus a per-call UsageRecord (tokens in/out, cache tokens where reported, model, inference region). | More providers, local runtime and org keys: REQ-025, **F-007**. Full policy check (entitlement, residency, budget): REQ-027, F-007. Tier × classification × region routing and PII masking: REQ-028 and REQ-029, **F-008**. Fallback and rate limits: REQ-031, F-007. Cost attribution and reconciliation: REQ-032, F-007. Department and personal keys: REQ-026, F-030. |
| REQ-095 All credentials in a vault (Must, Phase 0) | Gateway scope: provider credentials held in the vault, never in the database, logs, prompts, responses or clients. Rotation without downtime. | Control-plane secrets are **F-002**. Client package scan is **F-005**. |

## User stories

- As a developer, I want my prompt answered by the approved Claude model, streamed as it's generated, so that I can work without a provider account or key.
- As a platform admin, I want the provider credential kept only in the vault and rotatable without an outage so that a leaked laptop or log can never expose it.
- As a platform admin, I want requests for any model other than the approved one refused so that no one can reach an unapproved model through Ralysa in Phase 0.
- As a platform admin, I want every model call recorded with user, model, tokens and inference region so that I can show a regulator where inference happened and who caused it.
- As an assurance user, I want the gateway to refuse to call the model when it can't write the audit record so that "every call is audited" is a guarantee, not a best effort.

## Acceptance criteria

The **golden set** is 20 prompts: 10 English, 10 Arabic, 3 of them requiring a tool call. It runs through F-003 or a protocol-level test client.

| ID | Given | When | Then |
|---|---|---|---|
| AC-1 | A valid Ralysa access token (F-002) and the approved model | The golden set is sent | Every reply is streamed incrementally, with more than one chunk per reply. Tool-call requests and results round-trip correctly for the 3 tool prompts. 20 of 20 complete without gateway error. |
| AC-2 | A request with a missing, invalid, expired or wrong-audience token | It reaches the gateway | The gateway returns 401. **0** provider calls are made (provider-side capture or stub counter). The rejection is audited with `outcome=denied`. (REQ-024(c)) |
| AC-3 | A valid token and a request for any model other than the configured approved model | It reaches the gateway | The request is refused with an access-denied error naming the approved model. 0 provider calls are made. The refusal is audited with `outcome=denied`. |
| AC-4 | 100 gateway calls with mixed outcomes (success, provider error, client-cancelled, denied) | Audit events are reconciled | Exactly one audit event exists per call. Each event holds user id, `session_id`, model, provider, **inference region**, tokens in and out (0 where none were consumed), outcome, timestamp and `trace_id`. Events for denied calls hold the reason. (REQ-024(b); DV-12) |
| AC-5 | The same 100 calls | UsageRecords are reconciled | Every call that reached the provider has exactly one UsageRecord with user, `session_id`, model, tokens in/out, cache read/write tokens (when the provider reports them) and inference region. Its token counts equal the provider-reported counts for that call. |
| AC-6 | The audit store (F-002) is unavailable | A valid chat request arrives | No provider call is made. The caller receives an error stating that audit is unavailable. (Fail-closed audit pulled forward from REQ-071(c) so AC-4's "every call" holds.) |
| AC-7 | The provider credential | The gateway database, gateway and control-plane logs, gateway container image, captured provider-bound requests and returned responses, and client packages (F-005) are scanned for it | Findings = **0**. The database holds only a vault reference. No gateway API returns the credential, and provider error messages passed to callers have credential material removed. (REQ-024(a), REQ-095(a)) |
| AC-8 | Continuous traffic of ≥ 1 streaming request/s for 10 min | The provider credential is rotated in the vault and the old one revoked at the provider | 0 requests fail because of the rotation. The new credential is used for all new requests ≤ 5 min after rotation *(proposed)*. (REQ-095(b)) |
| AC-9 | The approved model configured on one provider endpoint in one region | The golden set runs with egress capture | All provider-bound traffic goes only to that endpoint. The `inference_region` in every audit and usage record equals the configured endpoint region. |
| AC-10 | A streaming request in progress | The caller cancels or disconnects | The gateway stops the provider stream ≤ 2 s after the cancel. The audit and usage records show `outcome=cancelled` with tokens consumed up to that point. |
| AC-11 | A stub provider with fixed latency and 50 concurrent streaming requests *(proposed load)* | Gateway overhead is measured (gateway time-to-first-byte minus stub time-to-first-byte) | Overhead p95 is **< 100 ms** (spec §12; REQ-110(a) baseline). |
| AC-12 | Prompts containing a unique canary string | The gateway handles them | The canary appears in 0 audit events and 0 gateway or control-plane log lines at default log level. Phase 0 audit is metadata-only. |
| AC-13 | The 10 Arabic prompts from the golden set | They are sent and answered | The provider-bound request bytes equal the client-sent text (capture). Replies reach the caller with 0 replacement characters or encoding errors. |

## Governance

- **Access (SSO groups / policy):**
  - Every request must carry a valid Ralysa token from F-002, which reflects the Phase 0 access-group decision.
  - The gateway enforces, server-side: token validity (AC-2), the single approved model (AC-3) and the single approved endpoint and region (AC-9).
  - Clients hold no key and cannot choose an endpoint.
  - The per-request policy check (user × model × entitlement × residency × budget) is REQ-027, F-007.
- **Approvals required:** None. A model call is not a side-effecting business action. Changing the approved model, endpoint or credential is a platform-admin configuration change, audited as `gateway.config_changed`. Console UI for it comes in F-018.
- **Audit events:** `model.call` (success / error / cancelled / denied) with the AC-4 fields; `gateway.config_changed`; `secret.rotated`. Each model call is audited exactly once, by the gateway.
- **PII / data classification / residency:**
  - Prompts and completions pass through but are **not stored** in audit or logs in Phase 0 (AC-12).
  - Inference region is recorded on every call (AC-4, AC-5, AC-9).
  - Phase 0 is limited to **internal and synthetic data, T1 only**. No customer, T2 or T3 data may pass through a Phase 0 gateway, because PII masking (REQ-029) and tier routing (REQ-028) don't exist until F-008.
  - Content from tools that the host forwards to the model is untrusted. Injection controls are F-010.

## Non-functional (spec §12)

| §12 category | Phase 0 target |
|---|---|
| Latency | Gateway overhead p95 < 100 ms at 50 concurrent streams *(proposed load)* (AC-11). First-token time is otherwise dominated by the model (§12). Cancel ≤ 2 s (AC-10). |
| Observability | 100 % of model calls audited with `trace_id` (AC-4). Fail-closed audit (AC-6). |
| Security (§8 Secrets, Data residency) | AC-2, AC-3, AC-7, AC-8, AC-9, AC-12. |
| Extensibility | Adding a provider later must be a registration or configuration change, not a change to the audit and usage guarantees above (spec §12; F-007 proves it). |
| Scale | No Phase 0 target beyond AC-11. 1,000 concurrent users in Phase 1 (REQ-110). |
| Availability, recoverability | No Phase 0 target. Phase 1: REQ-110 DR drill. |

## Arabic / RTL

No UI. Arabic prompts and replies must pass through the gateway byte-identical and without encoding loss (AC-13). Arabic-reply behaviour and Arabic model evaluation are REQ-107(b) and REQ-030 (F-021, F-008).

## Out of scope

- Providers other than the one chosen for Phase 0; the local model runtime; the Arabic local model (F-007, F-008).
- Policy-driven model lists, entitlements (Advanced Models) and budget/allowance enforcement (F-007, F-013, F-014).
- Data-tier and classification routing, T3 default-deny, PII masking (F-008).
- Fallback, rate limits, size-based routing, prompt-caching strategy (F-007, F-020, F-030).
- Cost calculation, chargeback and dashboards (REQ-032, REQ-073, F-007, F-014).
- Console UI for providers and keys (F-018).
- Choice of gateway implementation. Spec §6.5.4 suggests LiteLLM Proxy; the architect decides at G3.

## Dependencies

| Type | Item |
|---|---|
| Other features | **Upstream:** F-001 (CI, secret scan), F-002 (token validation, audit store, UsageRecord and Credential entities, service identity). **Downstream:** F-003 (host sends all model calls here), F-005 (end-to-end chat). **Phase 1:** F-007 and F-008 extend it. |
| Architecture (G3) | Gateway implementation (§6.5.4), vault product, streaming transport between host and gateway. |
| External / commercial | A provider account (Anthropic API or Google Vertex AI) with a Claude model in a known region. PRD OQ-4 (Anthropic terms) before Phase 0 build. A vault instance. |
| Process | Brief-level G2 approval, then G3, then `/design F-004` (G4). |

## Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Model calls with a complete audit event (incl. inference region) | 100 % | AC-4 reconciliation at Phase 0 exit |
| UsageRecord token counts matching the provider | 100 % of calls in AC-5 | AC-5 |
| Provider-credential exposure findings | 0 | AC-7 scan |
| Gateway overhead p95 | < 100 ms | AC-11 |
| Requests failed by credential rotation | 0 | AC-8 |

## Open questions

| # | Question | Recommendation | Owner |
|---|---|---|---|
| OQ-F004-1 | Anthropic API or Google Vertex AI for Phase 0 (REQ-024 allows either)? | **Vertex AI on a regional endpoint.** It makes the inference region deterministic for AC-9 and DV-12, and matches the Phase 1 in-region direction (Vertex Doha/Dammam, MA-302). Use the Anthropic API only if OQ-4 terms or model availability require it; then record the provider-declared region. The architect confirms availability at G3. | Product owner + architect |
| OQ-F004-2 | Which Claude model is the single approved model? | A current Sonnet-class Claude model pinned to a specific version, so behaviour is stable during Phase 0 testing. | Product owner |
| OQ-F004-3 | Load for the overhead test (50 concurrent) and credential propagation (≤ 5 min) are *(proposed)*. | Confirm at G4 (G2 condition). | Tech lead |
| OQ-F004-4 | Should prompt text be stored anywhere in Phase 0? | No. Metadata only until PRD OQ-16 (retention per tier) is decided in F-011. | Product owner + CISO advisor |

**G2 approval conditions (2026-09-25) and how they affect this feature:**
- *(Proposed)* numeric targets are confirmed at design: applies to AC-8 and AC-11.
- Phase 1 re-estimate: F-007 and F-008 build directly on this gateway.
- REQ-090, DV-16 and the onboarding REQ: not applicable.

Scope derived from PRD approved at G2 (2026-09-25); brief-level approval pending.

## Approval (G2)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
