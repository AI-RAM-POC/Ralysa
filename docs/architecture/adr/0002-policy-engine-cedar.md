# ADR-0002: Policy engine: Cedar, embedded, with a typed obligations resolver

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Proposed by architect agent (stream A). Decision owner: Tech lead (G3).
- **Related:** spec §4 D3, §6.4.2–6.4.4, §6.12.2, §6.15.5, §15 Q6; REQ-019, REQ-020, REQ-021, REQ-022, REQ-023, REQ-027, REQ-028, REQ-034, REQ-060, REQ-061, REQ-067, REQ-070, REQ-078, REQ-094; F-006, F-008, F-009, F-010 · Decision model and PDP placement: [ADR-0011](0011-policy-decision-model-and-pdp-placement.md) (this ADR implements it on Cedar)

## Context & forces

Spec §6.4.2 names OPA or AWS Cedar and leaves the choice open (§15 Q6). The policy engine sits on the hot path of every gateway call and is also the artifact that regulators and auditors read in the evidence pack (REQ-070).

What policy has to do:

- **Allow/deny** for models, tools, connectors per operation, skills and plugins. Where a user matches several profiles, **deny overrides allow** (§6.4.2, REQ-019a).
- **Two kinds of deny** (ADR-0011): an ordinary `deny` that an approved, time-boxed **grant can lift** (REQ-023), and a `mandatory_deny` that nothing lifts. Plus `require_approval` as an allow with an obligation.
- **Effective access = subscribed AND permitted** (§6.15.1). Policy can never grant a module the user isn't subscribed to (REQ-078c).
- **Non-overridable guardrails:** payments, hiring and fraud blocking are never automated (REQ-061); T3 data is denied to non-local models by default (REQ-028); C4 data only in air-gapped deployments (REQ-094d). A tenant admin must not be able to switch these off.
- **Obligations and parameters,** not just allow/deny: `mask_pii`, row limits, allowed tables, approval requirement and approver, budgets, `per_request_max_tokens`, default layout, residency.
- **Validate on save** with a specific error (REQ-020c). **Explain** each permission with its source profile and policy version (REQ-067c).
- **Propagate changes in ≤ 60 s** (REQ-021b). Evaluate in-process within the N2 budget (≤ 5 ms p95 for entitlement plus policy, [overview §5](../overview.md#5-nfr-budget)). Work fully offline for air-gapped installs.
- Admins author the §6.4.4 YAML shape. Most admins shouldn't have to learn a policy language.
- Team: small and TypeScript-first (ADR-0001).

## Options considered

| Criterion | A. Cedar embedded (cedar-wasm) + TypeScript obligations resolver | B. OPA / Rego (sidecar or Wasm) | C. Custom TypeScript rules engine over the YAML |
|---|---|---|---|
| Deny-overrides semantics | Built in: default deny, and any satisfied `forbid` overrides every `permit` ([Cedar authorization](https://docs.cedarpolicy.com/auth/authorization.html)) | Must be written in Rego by us, and every policy author must follow the convention | Must be written and tested by us |
| "A grant lifts a deny" (ADR-0011 `deny` vs `mandatory_deny`) | Not native: a `permit` can never override a `forbid`, so grants can't be `permit` policies. Expressible by writing ordinary denies as `forbid … unless { <grant in context> }` and mandatory denies as `forbid` with no grant clause (see Decision 2a) | Native: the combining logic is ours, written once in a base policy | Ours |
| Non-overridable guardrails | Platform-owned `forbid` policies structurally win over any tenant `permit` | By convention in the Rego package structure | By code |
| Validation at save (REQ-020c) | Schema-based validation when policies are created or updated ([Cedar docs](https://docs.cedarpolicy.com/)) | Compile and type checks; semantic checks are ours | Ours |
| Analysis and assurance | Language spec formally verified in Lean; Rust implementation differentially tested against it ([AWS, Cedar joins CNCF](https://aws.amazon.com/blogs/opensource/cedar-joins-cncf-as-a-sandbox-project)) | Mature tooling (tests, Regal linter); no formal model | None |
| Structured outputs / obligations | Returns a decision plus the determining policies only; obligations need a separate resolver | Can return any JSON document, so obligations and routing live in one policy | Anything |
| Explainability (REQ-067c) | Determining policy IDs returned per decision | Decision logs and tracing | Ours |
| In-process in Node | `@cedar-policy/cedar-wasm` (Node and web targets) | `@open-policy-agent/opa-wasm` ([OPA Wasm](https://www.openpolicyagent.org/docs/wasm)); or an OPA sidecar over HTTP | Native |
| Distribution and propagation | No bundle server; we build signed, versioned snapshots and push them | Built-in bundles with signing and polling or long-polling ([OPA bundles](https://www.openpolicyagent.org/docs/management-bundles)) | Ours |
| Air-gapped | Library only | Library or sidecar | n/a |
| Readability for admins and auditors | Designed to be readable and analyzable | Rego has a steep learning curve | YAML only, but its semantics live in code |
| Project status | CNCF Sandbox since 2025-12-15; used in production by AWS services, Cloudflare and MongoDB (same AWS source) | CNCF Graduated. Core maintainers moved from Styra to Apple in 2025; CNCF governance and the maintainer list are unchanged ([OPA blog](https://www.openpolicyagent.org/blog/note-from-teemu-tim-and-torin-to-the-open-policy-agent-community-2dbbfe494371)) | n/a |
| Lock-in | Open source; the policy language is portable | Open source; widely used in customer platform teams | Ours alone |

All links above were accessed 2026-09-25.

## Decision

**Option A: Cedar** for every authorization decision, evaluated in-process through `@cedar-policy/cedar-wasm` in the control plane, both gateways and the Agent Host (the host only filters the tool index; gateways stay authoritative).

How it fits together:

1. **Authoring.** Admins edit the §6.4.4 profile YAML in the Console. The control plane compiles it into (a) Cedar `permit`/`forbid` policies and (b) a typed **settings document** (limits, masking, approver, budgets, layout). Both are validated against the Cedar schema and a zod schema before save. Raw Cedar editing for advanced admins is a later option, not Phase 1.
2. **Guardrails.** REQ-061 (never automated), T3 non-local deny, C4 air-gapped-only, personal keys on T3, pack tier floors and "no permit without entitlement" ship as **platform `forbid` policies**. They are versioned with the product, and tenant admins can't edit them. These are ADR-0011's built-in `mandatory_deny` statements.

2a. **Mapping of the ADR-0011 decision model onto Cedar.** Cedar has only `permit` and `forbid`, default deny, and forbid-overrides-permit, so a later `permit` can never lift a `forbid`. The compiler therefore emits:

| ADR-0011 effect | Cedar form | Who authors it |
|---|---|---|
| `mandatory_deny` | `forbid (…) when { … };` with **no** grant clause. Nothing can lift it, including grants and other profiles | Built-in (product) or platform admin |
| `deny` | `forbid (…) when { … } unless { context.active_grants.contains(<grant key for this action and resource>) };` | Platform or department admin (via profile YAML) |
| grant (REQ-023) | **Data, not policy.** Active, unexpired grants are passed in `context` (and as entity data in the snapshot); the PEP also checks `expires_at` at evaluation time (ADR-0011 item 4) | Access-request approval |
| `allow` | `permit (…) when { … };` | Profiles |
| `require_approval` | `permit` plus an approval obligation produced by the settings resolver (decision 3) | Profiles, protected classes (§6.12.2) |
| default deny | Cedar's implicit deny | — |

The ADR-0011 evaluation order maps as follows. Token validity, kill-switch and entitlement are checked by the PEP before Cedar is called; entitlement is also a platform `forbid`, as defence in depth. Among the `forbid`s Cedar does not order, so the PEP turns the **determining policies** into ADR-0011 reason codes (`mandatory_policy`, `policy`, `not_entitled`) using the policy IDs and annotations the compiler assigns. A `deny` that a grant lifted is reported with `grant_id`. Unit tests for the compiler assert that no tenant-authored statement compiles to a grant-free `forbid` unless the author is a platform admin, and that no grant can lift a `mandatory_deny`.
3. **Obligations.** A TypeScript **effective-settings resolver** merges settings from all matching profiles with the *most restrictive wins* rule: lowest limit, `mask_pii` true if any profile sets it, and so on. It is pure, unit-tested and kept in `packages` so every service uses the same one.
4. **Distribution.** The control plane publishes a signed, versioned **policy snapshot** (Cedar policy set, schema, settings, entity data such as group-to-profile mapping, entitlements, grants and revocations). This is the "signed bundle" of ADR-0011, which owns distribution: change notification by push, delta pull by each PEP, and the freshness and fail-closed rules in the canonical table ([identity-and-policy.md §5.6](../identity-and-policy.md#56-governance-state-freshness-and-fail-closed-rules-canonical)). Each decision logs the snapshot version, which feeds REQ-067c and the evidence pack.
5. **Routing** (REQ-028) is not computed by Cedar. The Model Gateway lists candidate endpoints and asks Cedar about each (`Action::"invoke"` on `ModelEndpoint` with tier, classification and region attributes), then applies the routing order. That keeps residency guardrails in auditable policy and routing preference in code.

## Consequences

- Positive:
  - Deny-overrides and non-overridable guardrails come from the engine's semantics, not from conventions we must police.
  - Policies are short and readable for auditors and regulators. Validation errors appear at save.
  - Evaluation is in-process: no sidecar per pod and no extra network hop on the hot path.
- Negative / risks:
  - We build and operate snapshot distribution ourselves, which OPA provides out of the box.
  - Obligation logic lives outside the engine. The two artifacts (Cedar policies and the settings document) must always be versioned and shipped together.
  - Cedar is a younger CNCF project than OPA, with a smaller community.
  - Customers with existing OPA estates may ask for Rego.
  - Per-candidate evaluation for routing and tool-index filtering multiplies evaluations: about 100 tools × profiles per session start. This must be measured against the N2 budget.
  - "Grant lifts deny" is a compiler convention (`unless` over context grants), not an engine feature. A policy authored outside the compiler (for example a future raw-Cedar editor) could get it wrong, so raw Cedar editing must go through the same validator.
- What would make us revisit:
  - The obligations resolver grows into a second policy language, for example conditional obligations that depend on request data. At that point OPA's structured outputs would be simpler.
  - Expressing ADR-0011's `deny` / `mandatory_deny` / grant semantics through `unless` clauses causes authoring or explainability errors in F-006 testing (this is ADR-0011's own revisit trigger "the chosen engine cannot express `mandatory_deny` vs `deny` cleanly").
  - cedar-wasm misses the N2 budget or lacks a feature we need.
  - Two or more pilot or bank customers require policies in Rego.
  - The Cedar project loses momentum.

## References

- Cedar authorization semantics (default deny, forbid overrides permit): https://docs.cedarpolicy.com/auth/authorization.html (accessed 2026-09-25)
- Cedar policy syntax (`when` / `unless` conditions, forbid overrides permit, implicit deny): https://docs.cedarpolicy.com/policies/syntax-policy.html (accessed 2026-09-25; also cited by ADR-0011)
- ADR-0011 (decision model, PDP placement, signed bundles)
- Cedar overview (schema validation, analyzability, bounded latency): https://docs.cedarpolicy.com/ (accessed 2026-09-25)
- Cedar joins CNCF Sandbox; formal verification; adopters: https://aws.amazon.com/blogs/opensource/cedar-joins-cncf-as-a-sandbox-project (accessed 2026-09-25)
- cedar-wasm npm package: https://github.com/cedar-policy/cedar/blob/main/cedar-wasm/README.md (accessed 2026-09-25)
- OPA Wasm: https://www.openpolicyagent.org/docs/wasm (accessed 2026-09-25)
- OPA bundles (signing, polling): https://www.openpolicyagent.org/docs/management-bundles (accessed 2026-09-25)
- OPA maintainers' note on joining Apple: https://www.openpolicyagent.org/blog/note-from-teemu-tim-and-torin-to-the-open-policy-agent-community-2dbbfe494371 (accessed 2026-09-25)

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
