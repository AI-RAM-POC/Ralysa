# ADR-0006: Local model runtime: vLLM, behind the Model Gateway

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Proposed by architect agent (stream A). Decision owner: Tech lead (G3).
- **Related:** spec §6.5.2, §9, §14 (multi-model quality, regional availability); PRD DV-1, DV-2, A-4, OQ-6; REQ-025, REQ-028, REQ-030, REQ-054, REQ-102, REQ-103, REQ-110; summary R-4, R-5(d); MA-302, MA-303, MA-408; F-007, F-008, F-023, F-042

## Context & forces

Because no hosted provider offers in-country Claude inference in Qatar (MA-302, ADR-0005), **T3 data must be served by local models from Phase 1** (DV-2). On-prem ships with a **bundled local runtime** (REQ-102). Air-gapped runs on local models only (REQ-103). At least one Arabic-capable open or sovereign model must be available (REQ-025).

Forces:

- **Multi-user serving.** One deployment targets 1,000 concurrent users in Phase 1 (REQ-110). Only part of that traffic is T3, but the runtime must batch many concurrent requests.
- **Agent tool use.** The Agent Host runs an agent loop with tool calls. The runtime must parse tool calls for the chosen model family. Quality is gated per department by REQ-030.
- **Prompt caching and prefix reuse** keep long, stable system prompts cheap (REQ-054).
- **Operations in customer data centres:** Kubernetes and Helm, offline model weights, metrics, customer GPUs (A-4), possibly non-NVIDIA hardware.
- **Security.** The runtime must not be reachable except from the Model Gateway, which does authN, policy, masking decisions and audit.
- **Engine fit.** Anthropic states it doesn't support routing its harness to non-Claude models through any gateway ([LLM gateways](https://code.claude.com/docs/en/llm-gateway), accessed 2026-09-25). Local-model sessions therefore run on a combination Anthropic doesn't support. This is risk **ER-1** ([overview.md §4.1](../overview.md#41-non-negotiables-where-each-is-enforced)), carried through one mitigation plan (below).
- **Maintenance status.** Hugging Face TGI is in maintenance mode, and Hugging Face recommends vLLM or SGLang instead ([TGI docs](https://huggingface.co/docs/text-generation-inference/index), accessed 2026-09-25).

## Options considered

| Criterion | A. vLLM | B. SGLang | C. Ollama | D. Hugging Face TGI |
|---|---|---|---|---|
| Serving model | High-throughput multi-user server | High-throughput server; "low-latency, high-throughput inference" ([SGLang docs](https://docs.sglang.io/)) | Local and desktop oriented; `OLLAMA_NUM_PARALLEL` "default 1" parallel requests per model ([Ollama FAQ](https://docs.ollama.com/faq)) | Multi-user server with continuous batching |
| APIs | OpenAI-compatible Completions, Chat and Embeddings, **plus Anthropic Messages `/v1/messages`** ([vLLM online serving](https://docs.vllm.ai/en/latest/serving/online_serving/)) | OpenAI-compatible APIs | OpenAI-compatible chat, completions, embeddings, responses, with tools ([Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)) | Own API plus an OpenAI-style route |
| Tool calling | `--enable-auto-tool-choice` with per-family parsers: Llama, Mistral, Hermes/Qwen, DeepSeek, Granite, Gemma and more ([vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/)) | Supported through parsers (not assessed in depth) | `tools` supported on chat completions | "Guidance" structured outputs for tool use |
| Prefix caching | Yes | RadixAttention prefix caching | Not assessed | Not assessed |
| Arabic model coverage | Falcon and Llama/Qwen architectures listed. JAIS not confirmed in the supported-models list ([vLLM supported models](https://docs.vllm.ai/en/latest/models/supported_models/)) | Llama, Qwen, DeepSeek and similar | Depends on GGUF availability | n/a |
| Hardware breadth | NVIDIA focus (others not assessed here) | NVIDIA, AMD, Intel Xeon, TPU, Ascend, MUSA ([SGLang docs](https://docs.sglang.io/)) | CPU and consumer GPUs | NVIDIA focus |
| Built-in auth | Not relied on: network policy plus gateway | Not relied on | None documented; the FAQ proposes a reverse proxy | Not relied on |
| Project status | Active; recommended by Hugging Face | Active (LMSYS); recommended by Hugging Face | Active | **Maintenance mode**; excluded |
| Fit for on-prem Phase 1 (1,000 users) | Good | Good | Poor: single-user defaults | Poor: maintenance mode |

All links above were accessed 2026-09-25.

## Decision

**Option A: vLLM** is the supported, bundled local runtime in `deploy/helm` for dedicated, on-prem and air-gapped deployments.

1. **Contract between gateway and runtime:** OpenAI-compatible Chat Completions with tools, and Embeddings. The Model Gateway (through its provider adapter, LiteLLM in Phase 1, [ADR-0014](0014-model-gateway-policy-front-and-provider-adapter.md)) translates the host's Anthropic-format requests to it. We don't depend on vLLM's own `/v1/messages`, so SGLang or another OpenAI-compatible server can be swapped in by configuration.
2. **Isolation:**
   - The runtime lives in its own namespace, and a network policy admits only the Model Gateway.
   - Every request is authenticated, policy-checked and audited at the gateway. The runtime is never exposed to clients or Agent Hosts directly.
   - Each local model is registered as a `ModelProvider` with `regions = [deployment region]` and `locality = local`, which makes it eligible for T3 (REQ-028).
3. **Models.**
   - Phase 1 ships with one general tool-capable open model and one Arabic-capable model from the OQ-6 shortlist. Each is enabled per department only after passing REQ-030.
   - Weights are packaged as OCI artifacts for offline install (air-gapped, REQ-103).
   - A shortlisted model that vLLM doesn't support triggers the revisit clause below.
4. **Ollama** is supported only on developer workstations and for demos. It isn't a production target and isn't eligible for T2/T3 in a deployment.
5. **Sizing.** GPU sizing per model and concurrency goes into `deployment.md` once OQ-6 is answered. Customer or partner capacity is assumed (A-4).

## Consequences

- Positive:
  - T3 and air-gapped deployments work from Phase 1 with an actively maintained, multi-user server that has broad tool-calling parser coverage.
  - The OpenAI-compatible contract keeps the runtime replaceable (SGLang is the named alternative) and matches LiteLLM's provider model.
  - The embeddings endpoint on the same runtime gives future indexed search (ADR-0007) a local embedding path for T3 sources.
- Negative / risks:
  - **Tool-use quality on open models with the Claude Agent SDK loop is unproven and unsupported by Anthropic (ER-1).** A department may fail REQ-030 on every local model. Mitigation plan (same text in overview §4.1, ADR-0012, ADR-0014, ADR-0015): (1) REQ-030 eval gate per department through the real engine + translation path before any non-Claude model is enabled; (2) translation conformance tests in CI; (3) second-engine option: a Phase 2 spike of a second EnginePort adapter that speaks OpenAI-compatible APIs natively, with a go/no-go **before the RA pack (REQ-086) enables any T3 department** (ADR-0004, ADR-0012; no client release). Step (3) is a real cost if the go/no-go says go.
  - JAIS support in vLLM wasn't confirmed. The Arabic model choice may be constrained by runtime support.
  - vLLM's hardware focus is NVIDIA. Customers with other accelerators may be better served by SGLang, which means a second runtime to test.
  - GPU capacity and cost sit with the customer (A-4, MA-408) and are the likely scale bottleneck (N4).
- What would make us revisit:
  - On pilot hardware and the chosen model, SGLang shows at least 30 % more throughput at equal latency, or better tool-call parse accuracy.
  - The OQ-6 Arabic model runs only on another runtime.
  - The customer's accelerators aren't well supported by vLLM.
  - vLLM project health declines.

## References

- vLLM online serving (OpenAI-compatible and Anthropic Messages APIs): https://docs.vllm.ai/en/latest/serving/online_serving/ (accessed 2026-09-25)
- vLLM tool calling: https://docs.vllm.ai/en/latest/features/tool_calling/ (accessed 2026-09-25)
- vLLM supported models: https://docs.vllm.ai/en/latest/models/supported_models/ (accessed 2026-09-25)
- SGLang documentation: https://docs.sglang.io/ (accessed 2026-09-25)
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility (accessed 2026-09-25)
- Ollama FAQ (parallelism, network exposure): https://docs.ollama.com/faq (accessed 2026-09-25)
- Hugging Face TGI (maintenance mode notice): https://huggingface.co/docs/text-generation-inference/index (accessed 2026-09-25)
- Claude Code, other LLM gateways (non-Claude models not supported): https://code.claude.com/docs/en/llm-gateway (accessed 2026-09-25)

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
