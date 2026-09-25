# ADR-0017: MCP Gateway as an aggregating proxy with an identity-scoped virtual tool catalog

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §4 D5, §6.4.2 (hidden tools), §6.6.1, §6.15.5, §8 Supply chain · REQ-022, REQ-033, REQ-034, REQ-055, REQ-078 · summary R-5(e) · [mcp-gateway.md](../mcp-gateway.md) §2, §7

## Context & forces

- Tools a user may not use must never be loaded into the agent (REQ-022); per-SSO-group allowlists at operation granularity (REQ-034); entitlement checked before policy (§6.15.5).
- Only registered, approved server versions may be used from any surface (REQ-033); upstream tool changes must not silently reach users (supply chain, tool-description poisoning).
- MCP 2026-07-28 Streamable HTTP is stateless with per-request routing headers (`Mcp-Method`, `Mcp-Name`) meant for intermediaries, and must be supported alongside 2025-11-25 servers.
- Deferred tool loading and token efficiency (REQ-055) favour one catalog with short descriptions.
- Gateway overhead p95 < 100 ms.

## Options considered

| Criterion | A. Host connects to each MCP server directly; host filters tools; servers enforce policy | B. Aggregating proxy: one endpoint, per-identity virtual catalog (chosen) | C. Transparent forward proxy/sidecar per upstream server (host still sees many servers) |
|---|---|---|---|
| Hidden-not-blocked enforced server-side | No (host filters; modified host sees all) | Yes (`tools/list` only returns permitted tools) | Partly (per server) |
| Single enforcement and audit point | No | Yes | Many |
| Registry pinning and quarantine of changed tools | Hard | Natural (gateway diffs manifests) | Per sidecar |
| Upstream protocol version bridging (2025-11-25 ↔ 2026-07-28) | Host must handle all | Gateway handles | Sidecars handle |
| Credential brokering (ADR-0016) | Impossible centrally | Natural | Possible |
| Latency | Lowest | One hop | One hop |
| Blast radius if gateway fails | Per server | All remote tools (mitigate: HA, per-connector circuit breakers) | Per server |
| Local stdio servers | Direct | Not proxiable → decision API | Not proxiable |

## Decision

**Option B.** The Agent Host connects to a single tenant MCP endpoint on the gateway. The gateway serves a virtual catalog namespaced `connector.tool`, filtered by entitlement and policy for the calling user, built from approved manifests in the registry. It speaks MCP 2026-07-28 northbound and both 2026-07-28 and 2025-11-25 southbound. Upstream `tools/list_changed` and description/schema changes are diffed against the approved manifest and changed tools are quarantined until re-approved. Policy changes trigger `tools/list_changed` to connected hosts. Local stdio servers on Desktop/CLI are allowed only if registered and hash-pinned and are governed through the Control Plane decision API (ADR-0011 item 6) and the client-attested audit path ([observability-audit.md §3.3](../observability-audit.md)); the gateway does not see these calls.

## Consequences

- Positive: one place for policy, approvals, credentials, masking, provenance and audit; server-side hiding of tools; supply-chain control over tool descriptions; protocol-version bridging.
- Negative / risks: the gateway is on the critical path for every remote tool (HA, horizontal scaling, circuit breakers per connector); name collisions need namespacing; features the gateway does not yet proxy (e.g. new MCP capabilities) are unavailable until implemented.
- What would make us revisit: MCP standardizes an authorization/policy extension that upstream servers enforce reliably with enterprise identity (reduce proxy scope); latency budget cannot be met for large results (add streaming passthrough for approved read-only connectors).

## References

All accessed 2026-09-25.

- MCP versioning (current 2026-07-28, backward compatibility): https://modelcontextprotocol.io/specification/versioning
- MCP Streamable HTTP 2026-07-28 (stateless, routing headers, header/body validation): https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- MCP tools (list_changed, annotations untrusted): https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP security best practices (local server compromise, SSRF): https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
