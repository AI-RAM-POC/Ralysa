# ADR-0024: OpenTelemetry-only instrumentation, bundled OSS backends, Langfuse optional, audit separate from traces

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** spec §6.14, §10.3 (OpenTelemetry, Prometheus, Grafana, Langfuse), §12; REQ-072, REQ-074; F-011; `docs/architecture/observability-audit.md` §8

## Context & forces

- Every model and tool call must be traced (100 %), linked to audit by `trace_id`, across surfaces, Agent Host, gateways and providers.
- Content in traces is a leakage risk for T2/T3 data. Trace stores are usually less protected than the audit store.
- Must run air-gapped, with no SaaS APM.
- Small team: one instrumentation API; backends should be swappable per customer (many customers already run Grafana, Splunk or Elastic).

## Options considered

| Criterion | A. OTel SDKs + Collector; Prometheus/Grafana + Tempo or Jaeger bundled; Langfuse optional | B. Langfuse as the primary trace store | C. Vendor APM agent (Datadog, Dynatrace and similar) |
|---|---|---|---|
| Air-gapped | Yes | Yes (self-hosted, needs ClickHouse)[^lf] | Usually no |
| GenAI conventions | OTel `gen_ai.*`[^otel] | Native LLM views, OTLP ingest[^lf] | Varies |
| Customer backend choice | Any OTLP backend | Langfuse only | Vendor only |
| Ops footprint | Moderate | Adds ClickHouse, Redis, S3 | Agent per node + licence |
| Content control | Collector processors drop content attributes | Masking features exist | Vendor-dependent |

## Decision

Option **A**:

- OpenTelemetry is the only instrumentation API. `traceparent` is propagated across HTTP, MCP and the Agent Protocol.
- The Collector uses tail sampling that keeps 100 % of spans with `gen_ai.*` or tool attributes, errors, denials and approvals.
- Content attributes are off by default and prohibited for T2/T3.
- The bundled Prometheus + Grafana + trace store is the default. Langfuse is an optional add-on (planned with evals, F-032).
- **The audit log, not traces, is the system of record** and powers the explainability view.

## Consequences

- Positive: vendor-neutral; works air-gapped; customers can route OTLP to their own tools; no sensitive content in telemetry by default.
- Negative / risks: without Langfuse, LLM-specific debugging views are thinner in Phase 1. Tail sampling needs Collector state (a load-balancing exporter by trace id).
- What would make us revisit: the pilot requires Langfuse-style evaluation dashboards in Phase 1; the OTel GenAI conventions change incompatibly (pin the semconv version).

## References

All accessed 2026-09-25.

[^otel]: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
[^lf]: https://langfuse.com/self-hosting and https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
