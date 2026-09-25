# ADR-0004: Agent Protocol: JSON-RPC 2.0, JSON Schema contract authored in zod, engine-neutral types

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Proposed by architect agent (stream A). Decision owner: Tech lead (G3).
- **Related:** spec §4 D2/D8, §5.1, §6.2, §14 (Agent SDK dependency); REQ-008, REQ-009, REQ-011, REQ-012, REQ-015, REQ-062, REQ-069; MA-109; F-003, F-005, F-017

## Context & forces

The spec fixes the idea of one typed Agent Protocol between the three surfaces and the Agent Host. It sketches "WebSocket, JSON-RPC 2.0, versioned schema in `packages/protocol`" (§6.2.2) but doesn't compare alternatives. This ADR confirms the transport and fixes the schema approach and the engine-neutrality rule.

Forces:

- **Engine swappability** (§14 risk, MA-109, REQ-015). Anthropic is both our engine vendor and a competitor, and the commercial terms are open (OQ-4). The protocol must contain **no Claude Agent SDK types**. A mock host must pass the same conformance suite.
- **Three surfaces, two host locations** (D8). CLI and Desktop talk to a **local** host process. Web talks to a **remote** host in a sandbox. `session.resume` must survive reconnects and hand off Desktop ↔ Web (REQ-009).
- **Bidirectional streaming.** The host streams `message.delta`, `tool.*`, `approval.required` and `usage.update` while the client sends `session.cancel` and `approval.respond` mid-turn. Cancel within 2 s (REQ-011c); approval card within 2 s (REQ-062a).
- **Browser support** without an extra proxy tier; this also matters on-prem.
- **Consistency with MCP.** MCP encodes messages as JSON-RPC and defines stdio and Streamable HTTP transports ([MCP transports, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), accessed 2026-09-25). The host is an MCP client already, and developers will read both protocols.
- **TypeScript everywhere** (ADR-0001), plus published, language-neutral schemas for third parties (REQ-053 SDK) and for a possible non-TypeScript engine later.
- **Security.** No access token in URLs (REQ-069c). Every connection is bound to a user identity, and `tool.completed` payloads are redacted per policy before they leave the host (REQ-011d).

## Options considered

| Criterion | A. JSON-RPC 2.0 over WebSocket (remote) and stdio / local IPC (local); zod schemas exported as JSON Schema | B. gRPC with Protobuf (gRPC-Web in the browser) | C. HTTP POST + Server-Sent Events (MCP Streamable HTTP style) |
|---|---|---|---|
| Browser, bidirectional mid-turn messages | Native WebSocket, full duplex | gRPC-Web supports only unary and server-streaming; client and bidi streaming are not supported, and it needs a proxy, Envoy by default ([grpc-web](https://github.com/grpc/grpc-web), accessed 2026-09-25) | Cancel and approve become separate POSTs correlated to a stream; workable |
| Local host (CLI/Desktop) | Same JSON-RPC framing over stdio or a local IPC channel; no open port | Local gRPC server on a port or socket | Local HTTP server on a port; needs Origin checks against DNS rebinding (the MCP spec warns about this for local HTTP servers) |
| Consistency with MCP / LSP style | Same message model as MCP | Different model | Close to MCP's HTTP transport |
| Schema and types | Authored in zod; published JSON Schema is the normative contract; `z.toJSONSchema()` targets draft 2020-12 by default ([Zod JSON Schema](https://zod.dev/json-schema), accessed 2026-09-25) | Protobuf with codegen; strong evolution rules | Same as A |
| Notifications (no reply) | Native: a request without `id` is a notification ([JSON-RPC 2.0](https://www.jsonrpc.org/specification), accessed 2026-09-25) | Streams | SSE events |
| Resume and handoff | Sequence numbers per session, replay from the last acknowledged seq | Same, custom | SSE `Last-Event-ID` replay |
| Debuggability | Human-readable JSON | Binary; needs tooling | Human-readable |
| Payload efficiency | Adequate: text deltas, tool cards | Best | Adequate |
| Extra infrastructure on-prem | None beyond ingress WebSocket support | gRPC-Web proxy | None |

## Decision

**Option A.**

1. **Wire format:** JSON-RPC 2.0. Client → host requests as in §6.2.2. Host → client events are JSON-RPC notifications.
2. **Transports:**
   - Remote (Web → server-mode host): WebSocket over TLS through the ingress.
   - Local (CLI, Desktop → local host): stdio of a child process (the default; the CLI and Desktop spawn the host), or a local IPC channel (Unix domain socket or named pipe restricted by OS ACLs, plus a per-launch secret). **No listening TCP port** on the user's machine (security SR-15; F-003 AC-7).
   - The framing layer is transport-agnostic, so a later HTTP+SSE fallback can be added without schema changes.
3. **Handshake and auth.** The first exchange is `protocol.hello` (message catalogue in [agent-protocol.md §3.2](../agent-protocol.md)), with protocol versions, client surface and capabilities. For remote hosts the browser's WebSocket upgrade to the Session Router carries the BFF session cookie and passes an `Origin` check, and `protocol.hello` carries a short-lived, single-use connect ticket that the BFF (control plane) mints for that cookie session. The ticket is never a long-lived token and is never placed in a URL. The Session Router binds the connection to the ticket's user; the sandboxed host itself calls gateways with a delegated token obtained by token exchange (identity-and-policy.md §4.1). The host rejects any request whose identity differs from the bound user.
4. **Versioning:**
   - Semver (`MAJOR.MINOR.PATCH`) on the schema package. The wire protocol version is its `MAJOR.MINOR`; `PATCH` never changes the wire format.
   - `protocol.hello` negotiates the highest common `MAJOR.MINOR`, and every message then declares it in `_meta.protocol` (F-003 AC-8).
   - Minor versions only add optional fields, methods and events. Receivers must ignore unknown fields and unknown notification types.
   - A major mismatch returns an explicit incompatibility error naming the minimum version (REQ-012c).
5. **Schema: one statement, shared with ADR-0012.** The **published JSON Schema (draft 2020-12) in `packages/protocol` is the normative, language-neutral wire contract**, and it contains no engine or model-vendor types. It is **authored in zod** and generated with `z.toJSONSchema()`; the generated files are committed and versioned. TypeScript types and runtime validators come from the same zod source. Conformance tests and any non-TypeScript implementation validate against the JSON Schema. CI regenerates the schema and fails on any difference from the committed files, so zod and JSON Schema cannot drift. Zod features that don't export losslessly to JSON Schema (transforms, refinements that change the wire shape) are not allowed in protocol schemas.
5a. **Message metadata.** Every JSON-RPC message carries `_meta` (in `params` for requests and notifications, in `result` for responses, in `error.data` for errors) with `protocol` (the negotiated version) and `trace` (W3C `traceparent`, optional `tracestate`), so traces join across surface, host and gateways (ADR-0024).
6. **Engine-neutral types:**
   - The protocol defines its own `Message`, `ContentBlock`, `ToolCall`, `ToolResult`, `Usage`, `ApprovalRequest`, `Artifact` and `AccessDenied` types.
   - `services/agent-host` contains an **engine adapter** that maps Claude Agent SDK messages and hooks to and from these types. It is the only module allowed to import the SDK.
   - CI enforces this with an import-restriction lint rule on `@anthropic-ai/claude-agent-sdk` outside `services/agent-host/src/engine/**`.
   - A mock engine and a mock host pass the conformance suite (REQ-015).
7. **Reliability:**
   - Every host → client notification carries a per-session monotonic `seq`.
   - `session.resume` replays from the last acknowledged `seq`. The authoritative transcript and pending approvals live in the control plane, so handoff works across host instances.

## Consequences

- Positive:
  - One protocol model for surfaces and MCP. Full duplex in the browser without a proxy. No local open ports on developer machines.
  - Changing the agent engine means writing a new adapter inside `services/agent-host`, with no client release.
  - JSON Schema publication lets third parties and non-TypeScript engines implement the protocol.
- Negative / risks:
  - We own versioning discipline and the conformance suite. JSON-RPC gives no evolution rules the way Protobuf does.
  - WebSocket needs sticky routing or a session-to-sandbox lookup at the ingress, and idle-timeout tuning on customer load balancers.
  - JSON is larger than Protobuf. This is acceptable for text streams; large artifacts go by reference to object storage, never inline.
  - The adapter must translate SDK features, such as new hook types, as the SDK evolves. That is ongoing maintenance.
- What would make us revisit:
  - A customer's network stack blocks WebSocket through its proxies. Add the HTTP+SSE transport under the same schema.
  - Protocol traffic grows into high-volume binary payloads (for example terminal streams at scale). Consider a binary sub-channel.
  - MCP or another standard emerges for client ↔ agent-host communication that we could adopt instead of our own methods.

## References

- JSON-RPC 2.0 specification: https://www.jsonrpc.org/specification (accessed 2026-09-25)
- MCP transports (JSON-RPC, stdio, Streamable HTTP, local-server security warning): https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (accessed 2026-09-25)
- gRPC-Web streaming limitations and proxy requirement: https://github.com/grpc/grpc-web (accessed 2026-09-25)
- Zod JSON Schema conversion: https://zod.dev/json-schema (accessed 2026-09-25)
- Claude Agent SDK overview (sessions, hooks, permissions the adapter must map): https://code.claude.com/docs/en/agent-sdk/overview (accessed 2026-09-25)
- F-003 brief (`docs/features/F-003-agent-host-protocol-core/brief.md`), cross-checked in the G3 consistency review: AC-7 (no unauthenticated endpoint) is met by stdio / OS-ACL IPC, AC-8 (semantic version, every message declares its version) by decision 4 and `_meta.protocol`, and OQ-F003-3 (no engine-vendor types in Phase 0) by decision 6.
- ADR-0012 (engine port; states the same schema rule as decision 5).

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
