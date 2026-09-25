# ADR-0001: TypeScript for control plane and Ralysa-owned services

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** Proposed by architect agent (stream A). Decision owner: Tech lead (G3).
- **Related:** spec §4 D2/D9, §6.2.1, §10.3, §15 Q3; REQ-010, REQ-011, REQ-015, REQ-027, REQ-098, REQ-110; F-002, F-003, F-004, F-005

## Context & forces

Spec §15 Q3 leaves the control-plane language open: TypeScript (types shared with UI, CLI and Agent Host) or Python (closer to LiteLLM and data tooling). The spec's own recommendation is TypeScript, with Python only where libraries require it.

Forces:

- **Shared types across surfaces and services.** `packages/protocol` and `packages/auth` are TypeScript because all three surfaces are TypeScript (D9). The control plane and gateways validate the same payloads: approvals, policy decisions, usage events. One schema source removes a class of drift bugs and supports the REQ-012 conformance suite.
- **Agent Host.** The Claude Agent SDK is offered in Python and TypeScript ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), accessed 2026-09-25). §6.2.1 prefers TypeScript to share types with UI and CLI.
- **Model Gateway base.** LiteLLM Proxy is Python ([LiteLLM proxy docs](https://docs.litellm.ai/docs/simple_proxy), accessed 2026-09-25).
- **Policy engine bindings.** Both candidates for ADR-0002 run in-process in Node: Cedar through `@cedar-policy/cedar-wasm` ([README](https://github.com/cedar-policy/cedar/blob/main/cedar-wasm/README.md), accessed 2026-09-25) and OPA through `@open-policy-agent/opa-wasm` ([OPA Wasm docs](https://www.openpolicyagent.org/docs/wasm), accessed 2026-09-25).
- **NFRs.** Gateway overhead p95 < 100 ms (§12). The gateways are I/O-bound (token checks, cache lookups, audit writes, streaming passthrough), not CPU-bound.
- **Team and time.** The team is small and Phase 1 is overloaded (OQ-3). Each extra language adds a toolchain, lint and test setup, base images, SBOM and CVE triage (REQ-098), and a hiring profile.
- **Packaging.** On-prem and air-gapped installs (DV-1) favour fewer runtimes and base images.
- **Libraries that exist mainly in Python:** document extraction (Unstructured), OCR pipelines, and some Arabic NER models for PII detection.

## Options considered

| Criterion | A. TypeScript for all Ralysa-owned services; Python only for third-party or library-bound components | B. Python (FastAPI) for control plane and gateways; TypeScript for surfaces and Agent Host | C. TypeScript plus Go for the gateways |
|---|---|---|---|
| Shared types with `packages/protocol` | Direct import of zod schemas | Schemas duplicated or generated (JSON Schema → pydantic); drift risk | Generated Go types; drift risk |
| Agent SDK | TypeScript SDK in the host, same language as the protocol | Host stays TypeScript anyway, so two languages in the core | Host TypeScript; two languages |
| LiteLLM integration | LiteLLM runs as an internal container; our policy layer calls it over localhost HTTP | Can extend LiteLLM in-process with Python hooks | Same as A |
| Policy engine in-process | cedar-wasm or opa-wasm in Node | Cedar Python bindings or OPA over HTTP | cedar-go or OPA Go library |
| Gateway latency (p95 < 100 ms overhead) | Adequate for I/O-bound work; must be proven in load test | Adequate | Best raw performance |
| Team size and hiring | One language across the stack | Two core languages | Two core languages; Go gateway skills needed |
| Packaging, SBOM, CVE surface | Node everywhere, plus the two Python images we can't avoid | Node + Python in most services | Node + Go + Python (LiteLLM) |
| Data/ML libraries (OCR, NER) | Isolated in `services/extraction` or a masking sidecar | Native | Isolated, as A |
| Time to MVP | Fastest: one toolchain, shared validation | Slower: schema duplication | Slowest |

## Decision

**Option A.** All Ralysa-owned services are TypeScript on Node.js LTS: `control-plane`, `agent-host`, `mcp-gateway`, `workspace-runtime` and the policy layer of `model-gateway`. The HTTP framework is chosen in F-002 design; the default is Fastify.

Python is allowed only in these places, each behind an HTTP or queue contract generated from `packages/protocol` or OpenAPI:

1. **LiteLLM Proxy**, run as an unmodified upstream container that only the model-gateway policy layer can reach. We configure it; we don't fork it. Policy, routing decisions, masking, budgets, metering and audit live in the TypeScript layer. This applies only if the model-gateway stream keeps LiteLLM.
2. **`services/extraction`** (Unstructured, OCR with Arabic support; Apache Tika runs on the JVM as its own container).
3. **A PII-detection sidecar**, only if the Arabic NER model the model-gateway stream selects has no workable non-Python runtime.

Any new exception needs its own ADR.

## Consequences

- Positive:
  - One schema source (zod in `packages/protocol`) for surfaces, host, gateways and control plane. Conformance tests run in one toolchain.
  - The smallest set of base images and SBOM entries for on-prem and air-gapped installs.
  - The Agent SDK adapter, the protocol server and the policy evaluation all share types. That makes the "no SDK types past `services/agent-host`" rule easy to lint (ADR-0004).
- Negative / risks:
  - The model call path gains a localhost hop (TypeScript policy layer → LiteLLM), which must fit the N2 budget ([overview §5](../overview.md#5-nfr-budget)).
  - We can't use LiteLLM's in-process Python callbacks. Metering reads the provider usage fields in the TypeScript layer instead.
  - Node's single-threaded event loop means CPU-heavy work (large-prompt PII masking, JSON Schema validation of big tool results) must be kept off the hot path or moved to worker threads or a sidecar.
- What would make us revisit:
  - LiteLLM has to be forked or deeply extended to meet policy needs. Then either write the policy layer as a Python LiteLLM plugin, or replace LiteLLM with a TypeScript gateway.
  - The Phase 1 load test at 1,000 concurrent users misses gateway overhead p95 < 100 ms because of Node itself, not I/O. Then consider option C for the gateways only.
  - The hired team turns out to be mostly Python.

## References

- Claude Agent SDK overview (Python and TypeScript): https://code.claude.com/docs/en/agent-sdk/overview (accessed 2026-09-25)
- LiteLLM Proxy (Python LLM gateway): https://docs.litellm.ai/docs/simple_proxy (accessed 2026-09-25)
- Cedar Wasm package for JavaScript/TypeScript: https://github.com/cedar-policy/cedar/blob/main/cedar-wasm/README.md (accessed 2026-09-25)
- OPA Wasm and the `@open-policy-agent/opa-wasm` SDK: https://www.openpolicyagent.org/docs/wasm (accessed 2026-09-25)
- Zod JSON Schema conversion: https://zod.dev/json-schema (accessed 2026-09-25)
- Spec §10.3, §15 Q3; PRD OQ-3

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
