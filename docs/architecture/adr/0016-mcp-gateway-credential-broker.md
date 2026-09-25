# ADR-0016: The MCP/Data Gateway is the sole credential broker; no token passthrough

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §6.6.1 (identity pass-through), §6.7.1, §6.7.3, §8 Secrets · REQ-035, REQ-037, REQ-040, REQ-041, REQ-066, REQ-095 · [mcp-gateway.md](../mcp-gateway.md) §8

## Context & forces

- Tool calls must run **as the user** so source permissions and row-level security apply (§6.6.1, REQ-035). Service accounts are the exception, flagged and approved.
- All credentials in a vault; never on clients, in prompts, logs or the database (§8, REQ-095).
- MCP forbids token passthrough: servers must not accept tokens not issued for them and must not forward the token they received.
- Sources vary: Microsoft Graph (on-behalf-of), Google Workspace (per-user OAuth), IMAP (XOAUTH2 or vault password), databases (per-user roles), DMS (often service account), third-party MCP servers (MCP OAuth; enterprise-managed authorization via ID-JAG now a stable extension).
- Revoking a connection must delete its token ≤ 60 s (REQ-066b). Air-gapped installs use an on-prem vault.

## Options considered

| Criterion | A. Each connector (MCP server) holds and manages its own credentials | B. Gateway credential broker with pluggable auth modes and vault (chosen) | C. Forward the user's Ralysa or IdP token to every connector |
|---|---|---|---|
| As-the-user execution | Varies per connector | Uniform: OBO, token exchange, ID-JAG, per-user OAuth, dynamic DB roles | Only where the source trusts our token |
| Complies with MCP no-passthrough | Yes | Yes | **No** |
| Central revocation and audit | Scattered | One place (`credential.brokered` events, vault leases) | Weak |
| Secrets in third-party code | Yes (each server) | Only short-lived credentials in the call | Tokens leak to every server |
| Effort | Low for us, high risk | Medium (broker + mode plugins) | Low |
| Works with public MCP servers | Yes | Yes (injects credential per server's auth) | Rarely |

## Decision

**Option B.** The gateway's credential broker obtains, per call, a downstream credential for this user and this upstream using the registered `auth_mode`: `obo`, `token_exchange` (RFC 8693), `id_jag` (MCP enterprise-managed authorization), `per_user_oauth` (refresh token in vault, from `/me/connections`), `dynamic_db_role` (vault database secrets engine or pooled login with role switch so RLS applies), or `service_account` (flagged, platform-admin approved, end user asserted in metadata and audit). Credentials live only in memory for the call or are cached for their short lease. The Ralysa token (`aud=mcp-gateway`) never leaves the gateway. Ralysa-hosted connectors receive credentials from the gateway per call and hold none at rest.

## Consequences

- Positive: consistent as-the-user semantics; one audit trail for credential use; compliance with MCP security guidance; easy revocation.
- Negative / risks: the gateway becomes a high-value target (hardening, HSM-backed vault, least-privilege vault policies per connector); each auth mode is code to maintain; some sources cannot represent the user (service accounts remain, with weaker source-side audit).
- What would make us revisit: widespread adoption of ID-JAG lets most sources accept IdP-issued assertions directly, reducing broker modes; a customer mandates that credentials never transit a Ralysa component (then Option A for that connector with extra review).

## References

All accessed 2026-09-25.

- MCP authorization 2026-07-28 (audience validation, no token transit): https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- MCP security best practices (token passthrough, confused deputy): https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- MCP enterprise-managed authorization (ID-JAG): https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization
- Microsoft Entra on-behalf-of flow: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow
- RFC 8693 Token Exchange: https://www.rfc-editor.org/rfc/rfc8693
- HashiCorp Vault database secrets engine: https://developer.hashicorp.com/vault/docs/secrets/databases

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
