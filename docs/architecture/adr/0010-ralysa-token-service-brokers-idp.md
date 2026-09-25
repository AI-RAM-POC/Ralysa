# ADR-0010: Ralysa Token Service brokers all IdP sign-ins and mints audience-bound Ralysa tokens

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §4 D3, §6.4.1, §8 Authentication/Secrets, §9, §12 · REQ-001, REQ-016, REQ-017, REQ-021, REQ-069, REQ-078, REQ-095 · F-002, F-005 · [identity-and-policy.md](../identity-and-policy.md) §3.1 · [security.md](../security.md) TM-01, SR-08, OQ-S4 · Revised in the G3 consistency review (CLI sign-in options added)

## Context & forces

- Every gateway must enforce identity server-side (D3). Gateways need a token they can validate locally in < 5 ms to stay inside the p95 < 100 ms overhead budget (§12).
- Five IdPs over OIDC **or SAML** (REQ-017), including on-prem IdPs in air-gapped sites (§9). SAML IdPs have no device flow and no OAuth access tokens.
- CLI uses a device-code flow (§6.4.1). Microsoft recommends blocking device code flow wherever possible because it is used for phishing, and customers can block it in Conditional Access.
- Entra drops the `groups` claim above 200 groups (JWT) / 150 (SAML) and sends an overage marker.
- Entitlement and policy changes must take effect ≤ 60 s (REQ-078a, REQ-021b); session revocation ≤ 60 s (REQ-017d).
- MCP forbids token passthrough: a token must be issued for the resource that receives it.
- Team is small; time to Phase 0 is ≈ 4 weeks. Lock-in to one IdP vendor must be avoided.

## Options considered

| Criterion | A. Pass IdP access tokens straight to gateways | B. RTS brokers IdP, mints Ralysa tokens (chosen) | C. Buy/embed a full IdP broker (e.g. Keycloak as broker) in every deployment |
|---|---|---|---|
| Works with SAML IdPs | No (no OAuth access token) | Yes | Yes |
| CLI device flow where IdP device code is blocked | No | Yes (RTS hosts RFC 8628; IdP sees a browser sign-in) | Yes |
| Audience binding per gateway (no passthrough) | Weak: IdP tokens usually have one audience; would need one app registration per gateway per IdP | Strong: one audience per Ralysa service | Strong |
| Claims needed by gateways (tenant, sid, ent_ver, pol_ver) | Not available; each gateway must look everything up | In token | In token (custom mappers) |
| Group overage handling | Every gateway must call Graph | Once, in RTS / directory sync | In broker |
| Revocation ≤ 60 s | Depends on IdP (often not) | RTS-controlled revocation feed | Broker-controlled |
| Build effort | Lowest | Medium (OIDC RP + SAML SP + AS endpoints, using mature libraries) | Medium, plus operating another stateful product in every install incl. air-gapped |
| Lock-in | IdP-specific behaviour leaks into gateways | Low; RTS is ours, standards-based | Coupled to broker product |
| Air-gapped | Depends on IdP | Yes | Yes |

## Decision

**Option B.** The Control Plane includes a Ralysa Token Service that is an OIDC relying party / SAML service provider toward the customer IdP and an OAuth authorization server toward Ralysa clients. It offers authorization code + PKCE with loopback redirect for Desktop and the CLI, a BFF session for Web, and token exchange for the CLI device flow (below). It issues rotating refresh tokens and short-lived (15 min default) JWT access tokens with exactly one audience per Ralysa service, plus RFC 8693 token exchange for the server-side Agent Host (`sub` user, `act` host). IdP tokens never reach a gateway or any Ralysa service other than RTS; in CLI flow A below the CLI holds the IdP token in memory only for one exchange at RTS.

Implementation uses mature OIDC/SAML/OAuth libraries in TypeScript ([ADR-0001](0001-services-language-typescript.md)); the decision does not depend on the language. If a customer mandates their own broker (Option C), RTS federates to it like any IdP.

### CLI sign-in: which device flow (reconciles security TM-01 / SR-08, F-002 AC-2, F-005 AC-1)

The first draft of this ADR had RTS host the device authorization endpoint for every CLI sign-in. The security review (TM-01, SR-08) prefers the IdP-native device flow so the tenant's Conditional Access rules for device code apply, with loopback + PKCE as an alternative. F-002 also plans no Ralysa-hosted web page in Phase 0, which an RTS-hosted device flow would need.

| Criterion | A. IdP-native device flow + RTS token exchange | B. Loopback + PKCE through RTS (`/login --browser`) | C. RTS-hosted device flow (RFC 8628 at RTS, browser leg federated to the IdP) |
|---|---|---|---|
| Tenant Conditional Access for device code applies (SR-08) | **Yes**: the IdP runs the device flow ([Entra device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)) | n/a: no device code | **No**: the IdP sees an ordinary browser sign-in, so device-code CA rules don't fire |
| Device-code phishing (TM-01) | IdP controls plus CA; RTS records exchange IP and device label | Not applicable | Must be contained on a Ralysa page: TTL ≤ 10 min, single use, client/IP/geo confirmation, IP-mismatch alert |
| Works with SAML or IdPs without a device flow | No | Yes | Yes |
| Headless / SSH sessions | Yes | No (needs a local browser) | Yes |
| Tenant has blocked device code in CA | Blocked (then use B) | Yes | Works, but bypasses the tenant's intent unless the tenant switch disables it |
| Ralysa-hosted page in Phase 0 | None | Only the CLI's loopback "return to your terminal" page (i18n keys) | Yes: verification and confirmation pages (F-002 scope change) |
| Matches F-002 AC-2 / F-005 AC-1 as written | Partly: the IdP, not the control plane, returns the code (brief change BC-01) | Matches F-002 AC-1 (browser-redirect grant) | Yes |

**Recommendation (meets SR-08):**

1. **Phase 0 default for `/login`: A**, IdP-native device authorization with Entra ID, followed by a one-time RFC 8693 exchange at RTS. RTS validates the IdP token (signature, `iss`, pinned `tid`, audience = the Ralysa app registration, `auth_time`) before minting Ralysa tokens.
2. **Always available: B** (`ralysa /login --browser`), and the automatic choice when a tenant disables device code.
3. **C only as a fallback** for IdPs without a native device flow (SAML, some on-prem and air-gapped IdPs), from Phase 1, with all SR-08 hardening on the RTS page.
4. **A per-tenant switch** disables device code (A and C) entirely.

What would change this recommendation: the Phase 0 Entra test tenant or the pilot tenant blocks device code (then B is the Phase 0 default and F-005 AC-1 needs rewording); Entra's device-code controls prove weaker in practice than a hardened RTS page (then prefer C with the SR-08 controls).

## Consequences

- Positive: one token model for all surfaces (parity); SAML and air-gapped supported; tenant Conditional Access applies to CLI device sign-in where the IdP supports it; no token passthrough; fast local validation at gateways; revocation under our control; no Ralysa web page needed in Phase 0.
- Negative / risks: RTS is a security-critical component we own (needs threat model, pen test, key rotation, HA). One more hop in sign-in. We must track IdP-specific quirks (overage, SAML signing algorithms, device-flow support per IdP). Three CLI flows to build and test over time (A and B in Phase 0, C from Phase 1). In flow C, Conditional Access policies that target "device code" do not see the sign-in as device code; this is documented and the tenant switch can disable C.
- What would make us revisit: a pilot security team refuses a non-IdP authorization server; MCP enterprise-managed authorization (ID-JAG) becomes the norm for all downstream calls such that IdP-issued assertions are needed end to end; RTS maintenance cost exceeds adopting an embedded broker.

## References

All accessed 2026-09-25.

- RFC 8628 Device Authorization Grant: https://www.rfc-editor.org/rfc/rfc8628
- Microsoft Entra, device authorization grant: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
- RFC 7636 PKCE: https://www.rfc-editor.org/rfc/rfc7636
- RFC 8252 OAuth 2.0 for Native Apps: https://www.rfc-editor.org/rfc/rfc8252
- RFC 8693 Token Exchange: https://www.rfc-editor.org/rfc/rfc8693
- RFC 9068 JWT access tokens: https://www.rfc-editor.org/rfc/rfc9068
- RFC 10017 OAuth 2.0 for Browser-Based Applications (BFF): https://www.rfc-editor.org/info/rfc10017/
- Microsoft Entra, Conditional Access authentication flows: https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-authentication-flows
- Microsoft, group claims and overage: https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles
- MCP security best practices, token passthrough: https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
