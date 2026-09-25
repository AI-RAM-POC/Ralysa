# ADR-0028: Signed licence file (JWS, EdDSA) verified locally, with optional online sync

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** spec §6.15.7; REQ-081, REQ-103c; DV-1; market R-4; F-013, F-042; `docs/architecture/deployment.md` §9

## Context & forces

- Customer-operated installs (dedicated, on-prem, air-gapped) must enforce plans, seats and term without depending on Ralysa-hosted services (REQ-101c). Air-gapped sites have no connectivity at all.
- A tampered licence must be rejected (REQ-081a). Expiry gives a 30-day grace period and then blocks new sessions, while audit stays readable (REQ-081b).
- Privacy: licence sync must not send user identities or content out of the country.

## Options considered

| Criterion | A. Signed licence file (JWS/EdDSA), vendor public key in the release; optional sync of seat counts | B. Online licence server with periodic check-in (mandatory) | C. Hardware dongle / HSM-bound licence |
|---|---|---|---|
| Air-gapped | Yes | No | Yes |
| Tamper resistance | Signature; clock-rollback check | Server-side | Strong |
| Ops friction | Low (file import) | Low when connected, fatal when not | High |
| Data leaving the site | None, or aggregate counts on opt-in | Usage metadata | None |

## Decision

Option **A**:

- The licence is a compact JWS signed with a vendor Ed25519 key. It contains `org`, `deployment_id`, plans, seats, term, features and grace days, and is verified with public keys shipped in each release (with rotation support).
- Effective entitlements = min(licence, OrgSubscriptions).
- Clock rollback is detected against the newest signed audit checkpoint.
- Connected sites may opt in to a daily sync that sends only the licence id and seat counts in use.
- Air-gapped sites renew by importing a new file.

## Consequences

- Positive: works in every model; no data egress; simple support story.
- Negative / risks: a determined customer admin with root access could patch the verifier. This is accepted: the risk is commercial, not security, and contracts plus audit cover it. Key rotation must be planned so old releases can still verify new licences.
- What would make us revisit: licence misuse is observed; a marketplace (for example a cloud marketplace listing) requires its own metering API.

## References

- RFC 7515 JSON Web Signature: https://www.rfc-editor.org/rfc/rfc7515 ; RFC 8037 (EdDSA for JOSE): https://www.rfc-editor.org/rfc/rfc8037 (accessed 2026-09-25)

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
