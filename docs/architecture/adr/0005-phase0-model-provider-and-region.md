# ADR-0005: Phase 0 model provider and region: Claude on Vertex AI, regional endpoint only

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Proposed by architect agent (stream A). Decision owner: Tech lead (G3) with Product owner.
- **Related:** spec §4 D4, §6.5, §8 (Data residency), §14 (regional model availability; Agent SDK dependency); PRD DV-2, DV-12, DV-18, A-8, OQ-2, OQ-4, OQ-5; REQ-001d, REQ-024, REQ-025, REQ-028, REQ-032, REQ-095; MA-302; F-004

## Context & forces

Phase 0 needs **one** provider behind Model Gateway v0 (REQ-024). Every call must be audited with **user, model, tokens and inference region** (REQ-001d, REQ-024b), and the key must never reach clients (REQ-095). The F-004 brief (OQ-F004-1) recommends Vertex AI with a regional endpoint so the inference region is deterministic for F-004 AC-9 and DV-12; this was checked against the brief in the G3 consistency review. The brief's rationale also cites "the Phase 1 in-region direction (Vertex Doha/Dammam)", but Google lists no Middle East region for Claude today (below), so that part of the rationale doesn't hold; the recommendation itself is unchanged (brief change BC-08).

Forces:

- **MA-302, the binding constraint.** No in-country frontier inference exists for Qatar. We re-checked the vendor docs on 2026-09-25:
  - **Anthropic API:** `inference_geo` supports only `"global"` and `"us"`. Workspace geo is `"us"` only. The response reports `usage.inference_geo`, which gives per-call proof of where inference ran ([Anthropic data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)).
  - **Vertex AI:** offers global, multi-region (`us`, `eu`) and regional endpoints. Regional endpoints give "guaranteed data routing through specific geographic regions" at a 10 % premium. Anthropic's examples state that regional endpoints serve **Claude Sonnet 4.6 and earlier**, while newer models use global or multi-region endpoints ([Claude on Google Cloud](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai)). Google's Claude model page lists **no Middle East region** for Claude ([Google Cloud, Claude models](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude)).
  - **Bedrock:** Claude for me-central-1 and me-south-1 customers is served through **global cross-region inference**. Logs and configuration stay in the source region, but inference is routed elsewhere ([AWS ML blog](https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-global-cross-region-inference-for-anthropics-claude-models-in-the-middle-east-regions)).
  - **Microsoft Foundry:** Claude "hosted on Azure" offers Global or a **US** Data Zone ([Anthropic data residency](https://platform.claude.com/docs/en/manage-claude/data-residency), Foundry note).
- **Phase 0 carries no customer data.** It proves the mechanism (gateway, vault, audit with region), not residency compliance. Region choice for Phase 1 tiers is F-008's job, under the routing policy (REQ-028) and legal answers (OQ-2, A-8).
- **Gateway compatibility.** The Agent SDK (Claude Code harness) can talk to a gateway in the Anthropic Messages, Bedrock InvokeModel or Vertex rawPredict formats ([gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)). The Model Gateway exposes the **Anthropic Messages** format to the host whatever the upstream, so the host config never changes when the provider changes ([LLM gateways](https://code.claude.com/docs/en/llm-gateway)).
- **Phase 1 needs Anthropic, Vertex and Bedrock anyway** (REQ-025). Phase 0 picks the first; it doesn't exclude the others.
- **Pilot likelihood.** Qatar pilots are likely to host in Google Doha or Azure Qatar Central (R-4). Customers bring their own cloud contracts (D4).
- **Commercial.** Anthropic terms for the resold SDK are still open (OQ-4).

All links in this section were accessed 2026-09-25.

## Options considered

| Criterion | A. Anthropic API, `inference_geo: "us"` | B. Vertex AI, **regional** endpoint | C. Bedrock (Middle East regions through global cross-region inference, or a US/EU region) | D. Microsoft Foundry, hosted on Azure, US Data Zone |
|---|---|---|---|---|
| Inference location pinned | Country-level (US) | Single named region | ME regions: not pinned (global). Other regions: per inference profile | Country-level (US) |
| Region provable per call | Yes: `usage.inference_geo` in each response | From the endpoint URL the gateway chose (gateway-authoritative) | From the profile; global means unknown | From the deployment type |
| In-country Qatar option today | No | No Middle East region listed for Claude | No (inference routed globally) | No |
| Newest Claude models | Yes (geo control on 4.6 and later) | Regional endpoints: Sonnet 4.6 and earlier; newer only global or multi-region | Per region/profile | Per deployment |
| Credentials in vault (REQ-095) | Static API key | Service account or workload identity federation (spec §6.5.2) | IAM role | Managed identity or key |
| Agent SDK / gateway format | Native Anthropic Messages | Vertex rawPredict is a supported gateway format; our gateway translates | Bedrock InvokeModel is supported | Not listed as a separate gateway format; not assessed |
| Price effect | 1.1× for US-only | +10 % for regional endpoints | Per AWS | 1.1× for US Data Zone |
| Reuse in Phase 1 (REQ-025) | Required provider | Required provider | Required provider | Phase 2 (REQ-026) |
| Closeness to likely pilot cloud | Neutral | Google Doha pilots: same project, billing and contract | AWS me-central-1 pilots | Azure Qatar Central pilots |
| Dependency on Anthropic direct terms (OQ-4) | Highest | Contract via Google | Contract via AWS | Contract via Microsoft |

## Decision

**Option B**, as F-004 recommends: Phase 0 uses **Claude on Vertex AI through a regional endpoint.**

Rules for Model Gateway v0:

1. **Region.** Pin one regional location where the chosen model is listed in Model Garden when F-004 is set up. `europe-west1` is the default candidate; confirm it at setup. The `global` and multi-region (`us`, `eu`) endpoints are **disabled in gateway configuration**. Global routing means we can't state an inference region, which conflicts with DV-12.
2. **Model.** Use the newest Claude model served on that regional endpoint. Per Anthropic's docs that is Sonnet 4.6 or earlier today. Accept the lag in Phase 0.
3. **Region recording (security SR-04).** The gateway writes `endpoint_region` (the pinned Vertex location, from its **own** endpoint configuration) and `inference_region` (the processing geography, from the endpoint registry entry, which cites the Vertex regional-endpoint routing guarantee and the date it was verified) into every AuditEvent and UsageRecord, never from anything the client sends. For a Vertex regional endpoint the two values are the same region, which satisfies F-004 AC-9. Field definitions: [observability-audit.md §3.1](../observability-audit.md).
4. **Credentials.** Use workload identity federation where the gateway runs on GCP; otherwise a service-account key held in the vault. The key never leaves the gateway.
5. **Data.** Synthetic and T1 test data only in Phase 0. No customer data until F-008 routing and the legal answers (OQ-2, A-8) are in place. This is enforced technically, not only procedurally: the Phase 0 gateway runs with a deployment-level `max_tier = T1` setting and denies any session whose tier is higher, and the CLI shows a "synthetic data only" banner (security P0-6; brief change BC-09).
6. **Fallback configuration.** Option A (Anthropic API with `allowed_inference_geos: ["us"]`) is documented as a switch-over if Vertex regional quota or model availability blocks F-004. It needs no host change, because the gateway always exposes the Anthropic format. In that case `inference_region` = `us` (registry-declared) and the gateway also records the provider-reported `usage.inference_geo` as `inference_region_observed`.

## Consequences

- Positive:
  - Every Phase 0 call has a single, named inference region, which proves the DV-12 audit pattern early.
  - It matches the likely Google Doha pilot path and the customer's own cloud contract (D4). No static Anthropic key sits on the critical path.
  - The Anthropic-format gateway boundary keeps the Agent Host independent of the provider.
- Negative / risks:
  - Regional endpoints lag the newest Claude models. Phase 0 evals will run on an older model than Phase 1 might use.
  - Pinning a region outside the Gulf does **not** meet any Gulf residency rule. It proves the mechanism only. T2/T3 residency rests on local models (ADR-0006) and legal answers.
  - A 10 % regional premium, and regional quota may be tighter than global.
  - Region evidence is gateway-asserted (endpoint URL), not provider-reported as with the Anthropic API's `usage.inference_geo`.
- What would make us revisit:
  - Google lists Claude on `me-central1` (Doha) or `me-central2` (Dammam) regional endpoints. Switch region; this also changes T1/T2 routing for Qatar and KSA.
  - Anthropic adds a Middle East `inference_geo`.
  - The pilot customer mandates AWS or Azure.
  - Regional model lag blocks the REQ-030 eval thresholds.
  - Anthropic commercial terms (OQ-4) make the direct API the only permitted route for the SDK.

## References

- Anthropic, Data residency (`inference_geo` values, workspace geo, `usage.inference_geo`, pricing, partner-platform notes): https://platform.claude.com/docs/en/manage-claude/data-residency (accessed 2026-09-25)
- Anthropic, Claude on Google Cloud (global, multi-region and regional endpoints; regional model support; 10 % premium): https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai (accessed 2026-09-25)
- Google Cloud, Anthropic Claude models (region availability): https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude (accessed 2026-09-25)
- AWS, Bedrock global cross-region inference for Claude in the Middle East: https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-global-cross-region-inference-for-anthropics-claude-models-in-the-middle-east-regions (accessed 2026-09-25)
- Claude Code, LLM gateway and compatibility guide (API formats a gateway may expose): https://code.claude.com/docs/en/llm-gateway, https://code.claude.com/docs/en/llm-gateway-protocol (accessed 2026-09-25)
- `docs/market/regulation.md`, "where can frontier models actually run in-country?" (MA-302), including Azure OpenAI Regional Provisioned in UAE North only
- F-004 brief (`docs/features/F-004-model-gateway-v0/brief.md`, OQ-F004-1, AC-4, AC-5, AC-9), cross-checked in the G3 consistency review.
- docs/architecture/security.md TM-20, SR-04, P0-5, P0-6.

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
