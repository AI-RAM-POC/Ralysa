# ADR-0014: Model Gateway = Ralysa policy front + replaceable provider adapter (LiteLLM), Anthropic-compatible northbound API

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §4 D4, §6.5, §10.3, §12 · REQ-024 to REQ-032, REQ-079 · DV-2, DV-4, DV-12 · F-004 · [model-gateway.md](../model-gateway.md) · Language [ADR-0001](0001-services-language-typescript.md), Phase 0 provider [ADR-0005](0005-phase0-model-provider-and-region.md), local runtime [ADR-0006](0006-local-model-runtime.md), budgets [ADR-0019](0019-budget-enforcement-reservation-ledger.md) · [security.md](../security.md) TM-37, SR-20, SR-26, OQ-S2

## Context & forces

- Spec suggests "LiteLLM Proxy + custom policy layer, or custom gateway if requirements outgrow it" (§6.5.4, §10.3).
- Requirements now exceed a stock proxy: tier × classification × region routing with never-widen fallback (DV-2), session tier high-water mark, Arabic + English PII masking before non-local calls, inference region in every record (DV-12), pooled org credits with department sub-pools and BYOM exclusion (DV-4), two-phase fail-closed audit (REQ-071c), p95 < 100 ms overhead.
- The Agent Host engine calls an Anthropic Messages-format endpoint (`/v1/messages`, `count_tokens`, `/v1/models`) and needs `anthropic-beta`/`anthropic-version` forwarded unchanged. Anthropic does not support routing its agent harness to non-Claude models through a gateway.
- LiteLLM offers an Anthropic-format `/v1/messages` across providers, custom guardrails (pre_call can modify, during_call cannot), fallbacks, retries, cooldowns. vLLM serves both OpenAI-compatible and Anthropic Messages APIs.
- Air-gapped and on-prem must work; small team; avoid lock-in to a proxy's data model.
- **LiteLLM security history (security.md TM-37):** LiteLLM can store provider credentials and virtual keys in its own DB, which conflicts with REQ-095; it has a master key and an admin UI; it had a PyPI supply-chain compromise on 2026-03-24 (litellm 1.82.7 and 1.82.8 stole credentials) ([LiteLLM security update](https://docs.litellm.ai/blog/security-update-march-2026)) and CVE-2026-42208, an SQL injection on the key-verification path in 1.81.16 to 1.83.6, fixed in 1.83.7 ([LiteLLM advisory](https://docs.litellm.ai/blog/cve-2026-42208-litellm-proxy-sql-injection)).

## Options considered

| Criterion | A. LiteLLM Proxy with Ralysa logic as LiteLLM hooks/guardrails | B. Ralysa policy front service + LiteLLM as provider adapter stage (chosen) | C. Fully custom gateway (no LiteLLM) |
|---|---|---|---|
| Time to Phase 1 | Fast | Medium | Slow (provider adapters, tool translation, streaming for 6+ providers) |
| Ownership of policy, routing, audit, budgets | Inside a third-party process and its extension API | Ralysa code with its own tests and contract | Ralysa |
| Replaceability of provider layer | Low | High (adapter behind an internal interface) | n/a |
| Latency | One process | One extra in-cluster hop (~1–3 ms) | One process |
| Budget model fit (pooled credits, BYOM exclusion) | Must bend LiteLLM budgets or bypass them | Ralysa ledger; LiteLLM budgets unused | Ralysa ledger |
| Language coupling | Python (LiteLLM) | Front in stream A language; adapter in Python | Stream A language |
| Provider coverage | Broad | Broad | Narrow at first |
| Upgrade risk | LiteLLM changes can break governance | Contained to adapter | None |
| Supply-chain and attack surface (TM-37) | Full LiteLLM surface (auth, keys DB, admin UI) is the security boundary | LiteLLM is internal-only behind Ralysa authN; its key DB, admin UI and auth path are unused (constraints below) | Smallest; all code ours |

## Decision

**Option B.** The Model Gateway is a Ralysa **policy front** (authn, context and tier HWM, PDP, budget reservation, routing, masking, two-phase audit, metering) that calls a **provider adapter** through an internal interface. Phase 1 adapter = LiteLLM Proxy as an unmodified container ([ADR-0001](0001-services-language-typescript.md)), configured without its own budgets as source of truth (ADR-0019). Northbound APIs: Anthropic Messages-compatible for the Agent Host, OpenAI-compatible for internal callers. Phase 0 (F-004) may use the same structure with the adapter reduced to the single Vertex endpoint.

**LiteLLM deployment constraints (adopted from security.md TM-37 / SR-26; a release gate, not guidance):**

1. **Internal-only.** ClusterIP service; NetworkPolicy admits only the policy front. No client, Agent Host or other workload can reach it. Ralysa's own authN and policy run in front of it on every call; LiteLLM's virtual-key auth path is not the security boundary.
2. **Admin UI off.** The LiteLLM UI and management endpoints are disabled and unreachable.
3. **Master key from Vault**, never in Helm values, environment files or images.
4. **No provider credentials in LiteLLM's database.** Preferably LiteLLM runs with no database at all; the policy front's credential broker fetches the credential from the vault (or uses workload identity) and injects it per request, or LiteLLM reads it through a vault integration. Nothing is persisted by LiteLLM (REQ-095, SR-26).
5. **No response or semantic caching** in LiteLLM (SR-20); provider prompt caching only. No external callbacks or telemetry (air-gapped, SR-21).
6. **Pinned image digest from a verified release**, signature-checked at admission (SR-28). Never a version in a known-bad range: not 1.82.7 or 1.82.8, and ≥ 1.83.7 for CVE-2026-42208. The image is built or pulled once and mirrored; nothing installs LiteLLM from PyPI at runtime.
7. **Patch SLA:** critical LiteLLM security fixes are rolled out within **72 h** of release (customer-operated installs receive a patch release in that window); SBOM and CVE gate on every image (REQ-098).

If a constraint can't be met for a release, the gateway ships without LiteLLM for the affected providers (direct adapters behind the same internal interface), which is Option C scoped to those providers.

**Non-Claude models (risk ER-1).** Non-Claude models behind the Anthropic-format API are **vendor-unsupported for the Claude agent harness**. Mitigation plan (same text in overview §4.1, ADR-0006, ADR-0012, ADR-0015): (1) REQ-030 eval gate per department through the real engine + translation path before any non-Claude model is enabled; (2) translation conformance tests in CI; (3) second-engine option: a Phase 2 spike of a second EnginePort adapter that speaks OpenAI-compatible APIs natively, with a go/no-go **before the RA pack (REQ-086) enables any T3 department** (ADR-0012).

ADR-0001 proposes TypeScript, so the front is a separate process from LiteLLM. If G3 picks Python instead, the front may run in the same process as LiteLLM **provided** the internal adapter interface is kept; the decision is the separation of concerns, not the process count.

## Consequences

- Positive: governance code is ours and testable; the provider layer can be swapped (e.g. to vLLM direct for local, or a custom adapter); budgets reconcile with subscriptions; clear place for masking and audit fail-closed.
- Negative / risks: two components to operate; a small latency hop; T3 local-model path via the Claude harness is unsupported by the vendor and depends on eval results; LiteLLM's Anthropic-format translation for some providers may lag new Claude features (we forward headers but some fields may be dropped).
- What would make us revisit: gateway overhead p95 approaches 100 ms; LiteLLM translation quality blocks eval gates; another LiteLLM supply-chain incident, or a critical fix we can't ship within the 72 h SLA (then replace the adapter with direct adapters, Option C); Anthropic or another vendor ships a supported gateway with equivalent policy hooks; G3 chooses a language that makes a single-process gateway clearly simpler.

## References

All accessed 2026-09-25.

- Claude Code, other LLM gateways (non-Claude routing unsupported): https://code.claude.com/docs/en/llm-gateway
- Claude Code, gateway compatibility guide: https://code.claude.com/docs/en/llm-gateway-protocol
- LiteLLM Anthropic-format `/v1/messages`: https://docs.litellm.ai/docs/anthropic_unified
- LiteLLM custom guardrails: https://docs.litellm.ai/docs/proxy/guardrails/custom_guardrail
- LiteLLM fallbacks and reliability: https://docs.litellm.ai/docs/proxy/reliability
- vLLM online serving (OpenAI-compatible and Anthropic Messages APIs): https://docs.vllm.ai/en/latest/serving/online_serving/
- LiteLLM security update, PyPI compromise of 2026-03-24 (via security.md TM-37): https://docs.litellm.ai/blog/security-update-march-2026
- LiteLLM advisory CVE-2026-42208 (via security.md TM-37): https://docs.litellm.ai/blog/cve-2026-42208-litellm-proxy-sql-injection
- Trend Micro analysis of the LiteLLM supply-chain compromise (via security.md): https://www.trendmicro.com/en_us/research/26/c/inside-litellm-supply-chain-compromise.html

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
