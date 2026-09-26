# F-002: SSO sign-in (OIDC) and control-plane skeleton: Test Report

> Phase 6 · Owner: test-engineer · Commit: <sha> · Environment: <env>
>
> **Status: skeleton.** Only the section "Development close-out input (F-002-T15)" is filled in, by
> the developer at T15 (commit `9124033` + the T15 PR). Every other section is completed by the
> test engineer in `/test F-002`. Nothing here is a G6 decision.

## Development close-out input (F-002-T15)

Written at T15 (design §10: "TC-28 recorded, or marked blocked on E-1; production default of
`require_mfa_claim` confirmed or an exception filed (Q5)"). The test engineer keeps this section
as it is, and records later changes to it (TC-28 run, exception closed) in the results below.

### G6 condition met: TC-F-002-16 (AC-10, 10-minute rotation soak)

| Item | Value |
| --- | --- |
| Run | [soak run 36204987424](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36204987424), `soak.yml` dispatched on `main` at `ee80613` after #35 merged |
| Result | **Passed**, 2026-09-26 (job 00:28:43–00:39:35 UTC) |
| Evidence | 1,199 operations, 0 failures; key rotated at 60 s, new kid `ralysa-rts-signing.v2` in use 150.6 s later (bound 180 s, AC-10 allows 300 s); 20 of 20 old-kid tokens verified at the end; IdP secret v2 held by both replicas after 60 s, no `invalid_client`; `secret.rotated` once per phase and version; no warn or error line |
| Condition | R35-3 (status.md): dispatch `soak.yml` on `main` after T13 and link the run here. **Met.** |

Details: implementation-notes.md, T13 "Tests (T13)".

### TC-F-002-28 (AC-1, AC-2, AC-6): BLOCKED on E-1

| Item | Value |
| --- | --- |
| Result | **Blocked** (not run) |
| Blocker | **E-1** (external): no Entra ID test tenant yet: the two app registrations (§6.7, including the `ipaddr` optional claim), a client secret (≤ 180 days), **admin consent** for Graph `User.Read.All` and `GroupMember.Read.All` (Q3), Conditional Access for MFA and for admins, and the test users. Owner: founder / tenant admin. |
| What proceeds without it | Everything else. Development and CI ran flows A and B, disabled and deleted users, IdP session revocation and the Arabic user against the Entra-shaped mock IdP (TC-F-002-01, -02, -03, -04, -08, -09, -21, -24, -30, -31). |
| What waits for it | The real-tenant confirmation of the claims marked "to verify" in the design (§6.7): Q4, Q5, the `amr` values for phishing-resistant methods (`access.phishing_resistant_amr`), `xms_pl` for locale, `ipaddr` semantics, and E-2 (whether the tenant blocks device code). |
| Tenant setup | The control-plane README, "Entra ID configuration checklist". |

**When E-1 is available**, the test engineer runs TC-F-002-28 and records, per step, the outcome
and the relevant claims of the Entra tokens (claim names and presence only; never a token, code or
secret in this report):

| # | Step | Expected | Records |
| --- | --- | --- | --- |
| 28.1 | Flow B (`/login --browser`) as the in-group user, with the MFA prompt | Signed in, role `user`; one `auth.sign_in success` at redemption | ID token: `amr`, `acrs` present? (Q5) |
| 28.2 | Flow A (device code) as the in-group user, with the MFA prompt (or `unauthorized_client` / `conditional_access_blocked` if CA blocks device code, E-2) | Signed in, role `user`; one `auth.sign_in success` | Access token: `amr`, `acrs` (Q5); `ipaddr` vs the exchange `client_ip`, and whether `ipaddr` is the approving browser's or the polling client's address (Q4) |
| 28.3 | Flow B as the admin (phishing-resistant method, authentication context) | Role `platform_admin` | `amr` values for the method (`access.phishing_resistant_amr`); `acrs` carries the context id |
| 28.4 | Not-in-group user, flows A and B | `access_denied`, `auth.denied.not_in_access_group`; no session | |
| 28.5 | Disabled user; deleted user | Refused at the IdP or by Graph; a known user is disabled and revoked | |
| 28.6 | Entra "revoke sessions" for a signed-in user, then a refresh | Refresh refused (`idp_sessions_revoked`), session revoked | |
| 28.7 | Arabic-named user in an Arabic-named group | Names stored and shown as sent (UTF-8, not normalised) | |

Decisions TC-28 feeds: the production default of `idp.require_mfa_claim` (Q5), the admin
strong-flow `amr` rule, and whether `ip_mismatch` can deny in flow A (Q4).

### Open questions kept open (pending TC-F-002-28)

| # | Question | State until TC-28 | Owner |
| --- | --- | --- | --- |
| Q4 | Does Entra's `ipaddr` in a device-flow access token carry the approving browser's IP or the polling client's? | **Open.** Flow A records `details.idp_ipaddr` and `details.ip_mismatch`, counts `auth_device_ip_mismatch_total` and logs `auth_device_ip_mismatch`, and never denies. | Test engineer (TC-28) |
| Q5 | Are `amr` and `acrs` reliably present in v2 access and ID tokens for the RTS app? | **Open**, with exception EXC-F002-01 below. | Test engineer (TC-28) |

### Exception EXC-F002-01: production default of `require_mfa_claim` not confirmed (Q5)

| Item | Value |
| --- | --- |
| What can't be done | Confirm the production default of `idp.require_mfa_claim` against real Entra tokens (T15 definition of done, Q5), because TC-F-002-28 is blocked on E-1. |
| Decision | Keep the fail-safe default the design (§3.2.5 row 6, §3.8; SEC-F002-06) and the code already have. `mfaClaimRequired()` in `services/control-plane/src/config/schema.ts` returns `idp.require_mfa_claim ?? (env === 'production')`: unset means **`true` in production** (and `false` in `dev` and `test`). A sign-in without MFA evidence (`amr` contains `mfa`, or `acrs` is non-empty) is refused `failure mfa_claim_missing`. Production refuses to start with `require_mfa_claim: false` unless `access.mfa_claim_exception_ref` is set, and neither setting can be changed through a `RALYSA_CFG__*` override. |
| Risk accepted | If TC-28 shows the claims are absent from real v2 tokens, every production sign-in fails closed with `mfa_claim_missing` until the setting is revisited. That is an availability risk, not a security one, and no production deployment happens before G6 and TC-28. |
| Not granted | This is **not** an `access.mfa_claim_exception_ref`: nothing runs with the MFA check off. That reference is only for a deployment that sets `require_mfa_claim: false` after TC-28 shows the claims are missing, and it needs its own documented exception. |
| Revisit | At TC-F-002-28: if `amr`/`acrs` are present, close this exception and confirm the default; if not, decide (with the security reviewer) between Conditional Access-only MFA with a documented `mfa_claim_exception_ref`, or another source of MFA evidence. |
| Recorded by | Standing authorization, recorded by Claude, 2026-09-26 (implementation-notes.md T15-1). |

## Summary

> Test engineer: complete in `/test F-002`.

| Total | Passed | Failed | Blocked | Skipped |
|---|---|---|---|---|
| | | | 1 (TC-F-002-28, E-1) | |

## Results

> Test engineer: complete in `/test F-002` (TC-F-002-01 to -37, with evidence). The two rows below
> are T15's input.

| Test case | Result | Evidence (output / link) | Defect |
|---|---|---|---|
| TC-F-002-16 | Passed | [soak run 36204987424](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36204987424) | |
| TC-F-002-28 | Blocked (E-1) | Not run: no Entra test tenant or admin consent yet | |

## NFR measurements

> Test engineer: complete in `/test F-002`.

## Security review summary (link security.md)

> Security reviewer: complete in `/test F-002`. The status.md items that block G6 unless a named
> human accepts them (SEC-F002-35 (b)–(d), -36, -37) are decided there, not here.

## Defects
| ID / issue | Severity | Summary | Status |
|---|---|---|---|

## Known limitations

> Test engineer: complete in `/test F-002`. T15 input: TC-F-002-28 blocked on E-1; Q4 and Q5 open;
> exception EXC-F002-01.

## Recommendation

> Test engineer: complete in `/test F-002`.

Ready for release candidate / Not ready

## Approval (G6)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
