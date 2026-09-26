# F-002: SSO sign-in (OIDC) and control-plane skeleton: Test Report

> Phase 6 · Owner: test-engineer · Commit: `f795d6b` (`main`; one test added on `test/F-002-g6`) ·
> Environment: local macOS (Darwin 27, arm64), Node 24.21.0, pnpm 11.27.1, Docker dev stack
> (Postgres 17, OpenBao dev server), in-process Entra-shaped mock IdP; CI run
> [36256916071](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36256916071) on `f795d6b`; soak
> [run 36204987424](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36204987424) on `main`.
> Tested 2026-09-26.
>
> The section "Development close-out input (F-002-T15)" was written by the developer at T15 and is
> kept as it was. Everything after it is the test engineer's (`/test F-002`). Nothing here is a G6
> decision.

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

The test cases are TC-F-002-01 to -37: 36 in use, because TC-32 is intentionally unused.
[test-plan.md](test-plan.md) maps each TC to its AC and REQ and names the file and test that
implement it.

| Run condition | Total | Passed | Failed | Blocked | Skipped |
|---|---|---|---|---|---|
| **Gating runs**: 5 full local integration runs on an idle machine, the forced unit run, CI on `f795d6b`, PR CI [run 36258446142](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36258446142) on `f01142e` (with the new test), the soak on `main` | 36 | 35 | 0 | 1 (TC-F-002-28, E-1) | 0 |
| **Stress runs**: 2 full integration runs with `pnpm test --force` looping alongside (probe of the #39 flaky class) | 36 | 32 | **3 (TC-F-002-01, -15, -23)** | 1 (TC-28) | 0 TCs (12 tests of `audit.int.ts` skipped in run 6 after its setup hook failed) |

**Per suite (real output, this phase):**

| Suite | Command | Result | Duration |
|---|---|---|---|
| Lint | `pnpm lint --force` | 33/33 tasks passed, 0 cached | 41.0 s |
| Typecheck and generated files | `turbo run typecheck check:generated --force` | 38/38 tasks passed, 0 cached | — |
| Unit | `pnpm test --force` | 33/33 tasks passed, 0 cached. **2,341 tests passed, 0 failed**: control-plane 410, auth 119, protocol 171, secrets 52, dev-stack 100, repo-scripts 735, eslint-config 401, ui 205, stylelint-config 107, ui-lab 36, web 2, vitest-config 3. Repeated 3 more times under load: 3/3 green | 67.0 s |
| Build | `pnpm build --force` | 23/23 tasks passed, 0 cached | 14.9 s |
| Integration: control plane | `turbo run test:integration` with `RALYSA_REQUIRE_DEV_STACK=1` | Runs 1–3: **168/168**. Runs 4–5, with the new TC-20 rotation-log test: **169/169**. Stress run 6: **2 failed, 155 passed, 12 skipped**, plus 1 failed setup hook. Stress run 7: **2 failed, 167 passed** | 64.8–69.0 s per run (79–80 s under load) |
| Integration: `@ralysa/secrets` | same | 5/5 in all 7 runs | 1.3–4.3 s |
| Integration: `@ralysa/dev-stack` (OpenBao policies, stack) | same | 66/66 in all 7 runs | 1.8–6.0 s |
| Repo checks | `pnpm repo:check` | Passed, including `check-no-password`, `check-integration-scope`, `check-migrations-immutable`, `check-i18n` and Prettier | 11.6 s |
| Secret-scan self-tests | `secret-scan-cli.ts selftest` | 4/4 passed (dir, git, artefact, canary) | — |
| Image scan (AC-9) | `secret-scan-cli.ts image --dockerfile deploy/docker/control-plane.Dockerfile --exact-values deploy/docker/dev/.env` | 0 findings in the image checks, the filesystem, and the config and history | — |
| TC-15 rotation load harness | inside the integration suite (`rotation.int.ts`) | 5/5 passed idle; **2/2 FAILED under load** (see Results) | 61.5–62.3 s each |
| TC-16 soak | `soak.yml`, [run 36204987424](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36204987424) on `main` | Passed (T15 section) | 10 min |
| CI on `f795d6b` | [run 36256916071](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36256916071) | `quality`, `integration` (with the image scan), `repo-checks`, `secret-scan` and `ui-e2e` all succeeded | 3 min 1 s |
| PR CI on `f01142e` (this branch) | [run 36258446142](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36258446142) | All six jobs succeeded. `integration`: control plane 169/169, including `rotation.int.ts` 2/2 (TC-15 and the new TC-20 rotation-log test); secrets 5/5; dev-stack 66/66 | — |
| UI e2e (axe) | — | Not run locally because F-002 has no UI (see Accessibility). `ui-e2e` is green in CI on `f795d6b` as a regression check of F-001's surfaces | — |

**Flake observations**

On an idle machine, **0 failures in 5 of 5 full integration runs**. That is 239–240 tests per run,
about 1,200 test executions. The #43/#44 fix for TC-F-002-10 held in every run.

Under CPU contention (a full `pnpm test --force` running alongside), **2 of 2 runs failed**. Every
failure is in the #39 class: an audit write exceeds the 250 ms budget and fails closed.
- **Run 6:**
  - the `audit.int.ts` `beforeAll` failed on its `db.migration.applied` write, so the file's 12
    tests were skipped;
  - TC-F-002-01: the flow-B redemption answered 503 `audit unavailable`;
  - TC-F-002-15: 2 of 288 operations answered 503 `sign_in_audit_unavailable`, at 4.6 s and 5.1 s.
- **Run 7:**
  - TC-F-002-23 "concurrent sealers never fork a chain" failed with `write exceeded 250 ms`. This is
    R37-r2-3, already in #39;
  - TC-F-002-15: 2 of 291 operations answered 503, at 2.3 s and 5.1 s.

The TC-15 failures happened **before** the key rotation (15 s) and the secret rotation (20 s), so
the rotation did not cause them. In both stress runs:
- the new kid was in use 6.7–7.8 s after the rotation;
- 20/20 old-kid tokens still verified;
- both replicas adopted the new IdP secret.

TC-01, TC-15 and the `audit.int.ts` setup hook are **new instances** of the #39 class. #39 lists
TC-09, TC-10, `audit-routes` `open()` and the concurrent-sealers test.

Under load: 4 failed tests and 1 failed setup hook in about 480 test executions (about 1 %), but 2
of 2 runs were red. CI runners are not normally this loaded, and CI on `main` has been green for the
last 5 pushes.

## Results

The evidence is from the gating runs: integration runs 1–5 (2026-09-26, 16:54–17:03 UTC) and the
forced unit run. The test names are in [test-plan.md](test-plan.md). Every row passed in every
gating run.

| Test case | AC | Result | Evidence (output / link) | Defect |
|---|---|---|---|---|
| TC-F-002-01 | AC-1 | **Passed**; **FAILED** in stress run 6 | Flow B end to end and the flow-A membership change: 5/5 idle. Run 6: `expected 503 to be 200`, body `temporarily_unavailable` / `audit unavailable` | D-1 (#39 class) |
| TC-F-002-02 | AC-2 | Passed | Device flow through `@ralysa/auth` → exchange → `/v1/me` → refresh; client half in `client-flows.test.ts` | |
| TC-F-002-03 | AC-2 | Passed | 4 integration tests (expired code; used code; replay after a Graph fault; bad `uti`, `alg`, `ver` or an RTS token) and the validator unit matrix | |
| TC-F-002-04 | AC-2 | Passed | Device code off: `unauthorized_client`, `denied device_code_disabled`, flow-A sessions revoked | |
| TC-F-002-05 | AC-3 | Passed | OpenAPI property scan; the token endpoint refuses `password`, unknown grants, client secrets and Basic auth; metadata lists only `none` and `private_key_jwt` | |
| TC-F-002-06 | AC-3 | Passed | `check-no-password` unit tests; `pnpm repo:check` green. MFA is IdP configuration, confirmed in TC-28 | |
| TC-F-002-07 | AC-4 | Passed | Flows A (client reports) and B: exactly one `auth.sign_in` per attempt, no tokens, codes or secrets stored; `sign-in-exits.test.ts` 53/53 | |
| TC-F-002-08 | AC-5 | Passed | bob, flows A and B: `auth.denied.not_in_access_group`, no user, no session | |
| TC-F-002-09 | AC-6 | Passed | carol; alice disabled after the mint; dora (Graph 404); Entra "revoke sessions"; Graph > 3 s; the circuit after 5 failures. The fake gateway refuses after the feed poll and after `exp` | |
| TC-F-002-10 | AC-7 | Passed | 20/20 negative cases rejected and stored as 20 `auth.token_rejected`; a valid token yields user id, `org_id` and groups | |
| TC-F-002-11 | AC-7 | Passed | Verifier matrix and revocation-feed unit tests (G-1 staleness, a stale or replayed feed) | |
| TC-F-002-12 | NFR | Passed | p95 0.15–0.53 ms standalone (5 runs); 1.17–2.17 ms inside the parallel `pnpm test`; bound 10 ms | |
| TC-F-002-13 | AC-8 | Passed | Revoke → `auth.sign_out`; a later refresh is `invalid_grant` and `auth.refresh denied revoked`; the feed sees it | |
| TC-F-002-14 | AC-9 | Passed | The `pg_dump --data-only`, captured-log and `deploy/**` scans find 0; `cp.credential` holds vault paths only; the keys report `exportable=false` and `allow_plaintext_backup=false`; startup refuses a violating key; the image scan finds 0 (local and CI) | |
| TC-F-002-15 | AC-10 | **Passed**; **FAILED** in stress runs 6 and 7 | Idle, each run: 298 operations (exchange 50, refresh 99, flow B 50, gateway verify 50, CP verify 49) and **0 failures**; new kid in use 6.97–8.23 s after the rotation (bound 12 s); 20/20 old-kid tokens verified at the end; `secret.rotated` once per phase and version; IdP secret adopted by replica A in 1.11–1.54 s and by B in 1.59–3.26 s through exactly one `invalid_client` retry; only the expected `idp_invalid_client` warning. Stress: 2 operations answered 503 in each run, before any rotation | D-1 (#39 class) |
| TC-F-002-16 | AC-10 | Passed | [soak run 36204987424](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36204987424): 1,199 operations, 0 failures, new kid after 150.6 s (T15 section) | |
| TC-F-002-17 | AC-11, AC-13 | Passed | Service ingestion: fields stored, 401 and 403, `duplicate`, allow-list refusals with `audit.ingest_rejected`, 422 for non-I-JSON; no PUT, PATCH or DELETE under `/v1/audit` | |
| TC-F-002-18 | AC-12 | Passed | Admin query by user, action, outcome and time; `audit.query` committed first; 503 when the audit DB fails; a non-admin gets 403 and a queryable `audit.query denied` | |
| TC-F-002-19 | AC-13 | Passed | Tables and columns; `org_id`, `relrowsecurity` and `relforcerowsecurity` on every table; `endpoint_region` and `inference_region` | |
| TC-F-002-20 | AC-14 | Passed | The `scans.int.ts` log scan, **and now the TC-15 rotation logs**: new test, 2/2 idle runs. Mutation check: a planted IdP secret makes it fail with "an IdP client secret is in the log" | |
| TC-F-002-21 | AC-15 | Passed | fatima: the Arabic display name (with harakat) and group names are byte-identical (`Buffer.compare`) | |
| TC-F-002-22 | AC-16 | Passed | Client-attested path: actor overwrite; 409, 413, 422, 423 and 429; `client_seq` gaps; kill-switch scopes; 503 `ack=false` | |
| TC-F-002-23 | AC-17 | **Passed**; **FAILED** in stress runs 6 and 7 | Insert-only grants and triggers, `audit.modify_denied`, TRUNCATE, DDL audited, sealed ≤ 5 s, `verifyChain`. Run 6: setup hook `write exceeded 250 ms`, so 12 tests skipped. Run 7: "concurrent sealers never fork a chain" `write exceeded 250 ms` | D-1 (#39 class) |
| TC-F-002-24 | AC-1, AC-5 | Passed | Tenant pinning; overage through Graph; a Graph fault gives `error group_overage_unresolved`; look-alike group; non-GUID claim | |
| TC-F-002-25 | SR-07 | Passed | Refresh reuse revokes the family; of two concurrent refreshes exactly one wins; code reuse revokes | |
| TC-F-002-26 | AC-11, SR-07 | Passed | Client-assertion replay, a foreign key, a wrong `aud` and a retired version are refused; OpenBao policy boundaries (66 dev-stack integration tests) | |
| TC-F-002-27 | ADR-0003 | Passed | A query outside `withOrg()` errors; the other org is invisible; `X-Org-Id` is ignored; the pooled connection is reset | |
| TC-F-002-28 | AC-1, AC-2, AC-6 | **Blocked (E-1)** | Not run: no Entra test tenant or admin consent yet (T15 section) | |
| TC-F-002-29 | AC-17 | Passed | Signed checkpoints; the log equals the row; an owner rewrite is caught at the first covering checkpoint; deleted checkpoints are detected; `checkpoint_gap`; OpenBao refuses to clear the flag (SEC-F002-35 a) | |
| TC-F-002-30 | AC-1 | Passed | Binding cookie; another IP gives `denied loopback_ip_mismatch`; `alert` mode; wrong verifier and reuse; `code_not_redeemed` once | |
| TC-F-002-31 | AC-12, SR-08 | Passed | Admin only on strong flows; `admin_role_withheld`; `fido` admin; `mfa_claim_missing`; `ip_mismatch` flagged | |
| TC-F-002-33 | AC-9, SR-26 | Passed | A runtime flip of `exportable` or `allow_plaintext_backup` stops signing, `/readyz` answers 503, one `secret.custody_violation`; the same for the checkpoint key | |
| TC-F-002-34 | AC-9 | Passed | Every §3.8 production guard; every entry point refuses an in-memory, sealed or unreachable OpenBao (#41) | |
| TC-F-002-35 | T-12 | Passed | Import and production-closure checks; image dev-only exclusion; the mock control API refuses a request without the per-run bearer | |
| TC-F-002-36 | AC-9 | Passed | Entry-point config validation | |
| TC-F-002-37 | AC-11 | Passed | Service allow-list validation at config load | |

**Acceptance criteria.** AC-1 to AC-17 each have at least one passing automated TC. The parts that
need the real Entra tenant (the MFA prompt, real claims, Q4, Q5) are TC-28, which is blocked on E-1.

**Coverage.** Requirement coverage: all 17 ACs, and 35 of 36 TCs automated (TC-28 is manual by
design). Line and branch coverage were **not measured**. The repository has no coverage provider
(no `@vitest/coverage-v8` or similar), and adding one is a dependency change outside this phase.

**New test in this phase.** `services/control-plane/test/integration/rotation.int.ts` ::
"TC-F-002-20 (rotation logs): the two replicas' logs during TC-15 hold no token or secret; users are
UUIDs". It uses a new optional log capture in `test/soak/rotation-harness.ts`, and closes the TC-20
gap recorded as T14-11 in status.md (TC-20 must also cover TC-15's logs).

## NFR measurements

Numbers are from this phase unless marked otherwise. "Local" means Apple silicon, macOS, Node
24.21.0, with the dev stack in Docker.

| NFR (design §1.1, §8.4) | Target | Measured | Source |
|---|---|---|---|
| Token validation added to a gateway request | ≤ 10 ms p95; design target ≤ 2 ms with a warm cache | Standalone (5 runs × 1,000): **p95 0.152–0.525 ms**, p50 0.127–0.175 ms. Inside the fully parallel `pnpm test` (4 runs): p95 1.17–2.17 ms, p50 0.32–0.37 ms. The 2 ms design target is met standalone and missed by up to 0.17 ms under full parallel load; the 10 ms bound is met in every run | TC-12 |
| Gateway overhead p95 (§12) | < 100 ms | Not measurable in F-002: there is no gateway until F-004. F-002's share is the row above | — |
| New signing key in use after rotation (AC-10) | ≤ 5 min | **150.6 s** at production timings (soak: poll 30 s, delay 120 s). **6.97–8.23 s** compressed (poll 2 s, delay 6 s; bound 12 s), 5 idle runs | TC-16, TC-15 |
| New IdP client secret in use (AC-10) | ≤ 5 min | Soak: both replicas within 60 s (T15). Compressed: replica A in 1.11–1.54 s (2 s poll); replica B in 1.59–3.26 s through one `invalid_client` re-read | TC-16, TC-15 |
| Failed requests during rotation (AC-10) | 0 | Soak: 0 of 1,199. Compressed, idle: **0 of 298** in each of 5 runs. Under CPU stress: 2 of 288 and 2 of 291, both before any rotation (the audit budget, D-1) | TC-16, TC-15 |
| Old-kid tokens valid until expiry (AC-10) | 100 % | 20/20 in all 7 TC-15 runs (idle and stress); 20/20 in the soak | TC-15, TC-16 |
| Revocation reaches a verifying service | ≤ 60 s | Not measured as a number. Asserted: the fake gateway refuses after its next feed poll (TC-09, TC-13), and the verifier treats the feed as stale 60 s after the last confirmation (TC-11) | TC-09, -11, -13 |
| JWKS freshness | Refetch on an unknown `kid`, cached otherwise | Asserted by the TC-11 cache tests (they count refetches), not timed | TC-11 |
| Event sealed into the hash chain (AC-17) | ≤ 5 s | Asserted `< 5,000 ms` in every gating run; the actual time is not recorded | TC-23 |
| Checkpoint interval | 60 s (2 s in tests) | Asserted at the 2 s test interval | TC-29 |
| Sign-in audit completeness (AC-4) | 100 % | 100 %: every scripted attempt produced exactly one `auth.sign_in` | TC-07 |
| Access-token lifetime (AC-6) | ≤ 15 min | Default `tokens.access_ttl_s` is 900 (schema bounds 60–3600); the expiry path is tested with 5 s | TC-09 |
| Sign-in latency, server side (informative; no target) | none | See the note below this table | integration logs |
| Workspace cold start (§12) | < 15 s | N/A: F-002 has no workspace | — |
| Accessibility (WCAG 2.1 AA) | 0 serious or critical | N/A: F-002 has no UI (next section) | — |

Sign-in latency comes from the control plane's own `request` log lines in integration runs 1–3. They
were measured with the in-process mock IdP and under the suite's parallel load:

| Route | p50 | p95 | Max | n |
|---|---|---|---|---|
| `POST /oauth2/token` 200 (exchange, refresh and code redemption mixed) | 25 ms | 57 ms | 172 ms | 222 |
| Flow-B `GET /oauth2/idp/callback` 302 | 53 ms | 93 ms | — | 69 |
| `GET /oauth2/authorize` | — | 18 ms | — | — |
| `GET /v1/me` | — | 31 ms | — | — |
| `GET /v1/audit/events` (admin, run 1) | — | 60 ms | — | 6 |

Latency against real Entra can't be measured locally until E-1 is available.

### Accessibility and Arabic/RTL

- **F-002 has no UI surface of its own**, as the brief and design §7 say:
  - the sign-in pages are Entra's;
  - the CLI renders every user-facing message (F-005);
  - the flow-B "return to your terminal" page belongs to the CLI loopback (F-005).
- **The one browser-facing response** is the `invalid_authorize_request` error. It is
  `text/plain; charset=utf-8` with `Content-Language: en, ar`, and its body is the English and
  Arabic sentences from `services/control-plane/src/i18n/{en,ar}.json`, with no markup (D-20).
  - `sign-in-browser.int.ts` checks the status, the content type, `content-language`, that the body
    equals the i18n text, and that it contains Arabic script.
  - Without layout there is no CSS, so logical properties don't apply and axe has nothing to scan.
  - The en and ar key sets are identical (checked in this phase), and `check-i18n` in
    `repo:check` passes.
- **Errors for clients** carry `ralysa_error.i18n_key` (for example
  `auth.denied.not_in_access_group`) for F-005 to render in en and ar.
- **Arabic data:** TC-21 passes. The display name with harakat and the Arabic group names are
  byte-identical, with no U+FFFD and no normalisation.
- `ui-e2e` (axe via Playwright) is green in CI on `f795d6b`. It covers F-001's surfaces, not F-002.

## Security review summary (link security.md)

> This is not a security-reviewer sign-off; the security reviewer's phase-6 pass is separate. It
> records the state in [security.md](security.md) and status.md that G6 depends on, plus the
> security-relevant results above.
>
> **Security reviewer's phase-6 pass:** [security.md "Phase 6 security review (2026-09-26)"](security.md#phase-6-security-review-2026-09-26).
> Verdict (§P6-7): **pass with conditions**. There are no open Critical or High findings. Three new findings are Medium:
> SEC-F002-42 (`Principal` roles ignore the strong-flow admin rule and are a sign-in snapshot),
> -43 (a shared global rate-limit bucket enables an unauthenticated lockout), and -44 (no recovery for a flagged RTS
> signing key). There are seven new Low findings (-45 to -51). G6 still needs the founder's written acceptance of
> -35 (b)–(d), -36 and -37 (condition C1) and a decision on -42 (C2).

- **Tested and passing:**
  - authz bypass attempts (TC-10, -11, -25, -26, -27);
  - untrusted input on the audit paths (TC-17, -22, -37);
  - secrets custody and scans (TC-14, -33, -34, -36 and the image scan);
  - token and log hygiene (TC-07; TC-20, including the rotation logs);
  - dev-only exclusion (TC-35).
- **Remediated:**
  - SEC-F002-34 (the sealer's credential), with tests T1–T11 in `custody-fn.int.ts`, green in every
    run;
  - SEC-F002-39 and -40 (`checkpoint.test.ts`);
  - SEC-F002-35 (a): the TC-29 test "OpenBao 2.6.2 refuses to clear the flag again".
- **Accepted as open risks (C1), no longer blocking G6** (security.md §E, P6-7 and P6-8; status.md).
  Ram Mohan Rao Adduri accepted them in his own words on 2026-09-26, for dev and CI only, to be built
  before F-011 or any non-dev deployment:
  - **SEC-F002-35 (b)–(d):** checkpoint-key recovery by key epoch, `audit-verify` still verifying
    with a flagged key, and the "checkpoint key compromised" runbook;
  - **SEC-F002-36:** pin the checkpoint trust anchor;
  - **SEC-F002-37:** detect a checkpoint key recreated under the same name.
- **SEC-F002-42 (C2)**: `Principal` roles ignore the strong-flow admin rule and are a sign-in snapshot.
  Founder decision (security.md P6-8): **fix before G7**
  ([#47](https://github.com/AI-RAM-POC/Ralysa/issues/47)).
- **Open and blocking any non-dev deployment** (security.md P6-7 item 3):
  - SEC-F002-38: require `--log-checkpoints` outside dev and ship the log off-host;
  - the OpenBao audit device (SEC-F002-11);
  - SEC-F002-43 ([#48](https://github.com/AI-RAM-POC/Ralysa/issues/48));
  - SEC-F002-44 ([#49](https://github.com/AI-RAM-POC/Ralysa/issues/49));
  - SEC-F002-45 ([#50](https://github.com/AI-RAM-POC/Ralysa/issues/50));
  - SEC-F002-46 alerting ([#51](https://github.com/AI-RAM-POC/Ralysa/issues/51), which covers [#45](https://github.com/AI-RAM-POC/Ralysa/issues/45));
  - SEC-F002-49 ([#54](https://github.com/AI-RAM-POC/Ralysa/issues/54));
  - SEC-F002-22: Kubernetes auth-role rendering (F-023);
  - TC-F-002-28 run, with Q4 and Q5 answered and EXC-F002-01 closed;
  - a decision on SEC-F002-10 / Q3 before the E-1 admin consent is given.

## Defects

D-1 and D-2 were proposed in this phase and filed with the founder's approval (security.md P6-8): D-1 was added to #39, and D-2 is #57.

| ID / issue | Severity | Summary | Status |
|---|---|---|---|
| D-1 (in [#39](https://github.com/AI-RAM-POC/Ralysa/issues/39)) | Medium | Under CPU contention, the 250 ms audit-write budget fails closed in three more places than #39 lists: TC-F-002-15 (`rotation.int.ts`; 2 operations answered 503 `sign_in_audit_unavailable` in each of 2 stress runs), TC-F-002-01 (`sign-in-browser.int.ts`; the redemption answered 503) and the `audit.int.ts` `beforeAll` (the `db.migration.applied` write; the file's 12 tests are skipped). Failing closed is correct (design §5.8, REQ-071); the tests assume an unloaded database. In production, a sign-in fails with 503 whenever its success event takes more than 250 ms to commit, so sign-in availability tracks audit-DB latency. That is input for the Phase 1 capacity work (REQ-110). Related: SEC-F002-48 (#53) | Open (comment on #39) |
| D-2, [#57](https://github.com/AI-RAM-POC/Ralysa/issues/57) | Low | A fresh control-plane database against an **existing** Transit key (after a rebuild or restore) republishes every historical key version in JWKS. In TC-15 the JWKS listed `ralysa-rts-signing.v1`–`v23`, and `secret.rotated published` was written for v1–v21, because the shared dev key had rotated in earlier runs. The old versions are superseded at once but retire only after the retention (access TTL + 5 min, about 20 min), so previously retired versions verify again for that window (the poll in `src/auth/tokens/signing-keys.ts`). The impact is small because Transit keys are non-exportable, but a deliberately retired version coming back is surprising. Possible fixes: publish only the latest version on first start, honour Transit `min_decryption_version`, or document it in the restore runbook | Open (#57) |
| [#45](https://github.com/AI-RAM-POC/Ralysa/issues/45) | Medium | A spool append failure after a timed-out audit write loses the event (for example `auth.token_rejected`), and the only trace is a warning log. There is no loss metric, and metrics go to `noopMetrics`. It needs a timed-out write, a failing spool (disk full, EACCES) and a rolled-back late transaction. It weakens AC-4 and AC-7 completeness in that failure mode. Covered by SEC-F002-46 alerting ([#51](https://github.com/AI-RAM-POC/Ralysa/issues/51)), a non-dev blocker | Existing, open; not reproduced in this phase |
| [#39](https://github.com/AI-RAM-POC/Ralysa/issues/39) | Low | Signing-key pin follow-ups (R37-r2-1..3) and the load-sensitive tests (R44-4, R44-5, F43-4) | Existing, open; follow-up |
| [#38](https://github.com/AI-RAM-POC/Ralysa/issues/38) | Low | T14 scan-check gaps (R34-r2-1..5) | Existing, open; follow-up |

Observed and expected, so not defects:
- Run locally, `secret-scan-cli.ts tree` reports 2 findings in `deploy/docker/dev/.env`, the
  git-ignored local dev credentials. The file is not tracked (`git check-ignore` confirms it), and
  the CI `secret-scan` job on `f795d6b` is green.
- `check-i18n` warns that the `packages/ui` ar value for `locale.name.en` equals "English", and it
  lists strings marked `needs-native-review` (F-001, OQ-D8). Neither is F-002.

## Known limitations

- **TC-F-002-28 is blocked on E-1** (the real Entra tenant and admin consent). The MFA prompt, real
  claim shapes, disabled and deleted users at Entra, session revocation and the Arabic user are
  tested only against the Entra-shaped mock IdP.
- **Q4** (`ipaddr` semantics in the device flow) and **Q5** (whether `amr` and `acrs` are present)
  stay open.
- **EXC-F002-01:** the production default of `idp.require_mfa_claim` (unset means `true` in
  production) isn't confirmed against real tokens (T15 section).
- **Security items stay open:** SEC-F002-35 (b)–(d), -36 and -37 (C1: accepted for dev and CI only); SEC-F002-42 (fix before G7, #47); the non-dev blockers listed under Security review summary.
- **Metrics go to `noopMetrics`** in `serve` (status.md). Counters such as
  `audit_write_failures_total` and `auth_device_ip_mismatch_total` aren't exported, so alerts must
  key on log lines until F-011 or F-023.
- **Per-instance limits** on the audit paths multiply with the number of replicas (F-012).
- **There is no gateway, CLI, Desktop or Web yet:**
  - AC-6's gateway behaviour and AC-7 are proven against a fake gateway on `@ralysa/auth`;
  - AC-3's "no CLI prompt" is checked over the placeholder `apps/cli` until F-005;
  - the §12 gateway overhead is for F-004 to measure.
- **Load sensitivity:** the integration suite is reliable on an idle machine and in CI, but not
  under heavy local CPU contention (D-1).
- **No line or branch coverage figure**, because the repo has no coverage provider.
- **Environment:** the local runs used a shared, long-lived dev stack. Its Transit key already had 22
  versions before these runs, which is how D-2 showed up.
- **UAT note** (status.md): on dual-stack hosts, `access.loopback_ip_mismatch: deny` can refuse a
  genuine flow-B sign-in. The fallback is `alert`.

## Recommendation

**Go with conditions.** The two founder decisions G6 waited for are recorded in security.md P6-8
(Ram Mohan Rao Adduri, in his own words, 2026-09-26):
- **C1 (accepted):** SEC-F002-35 (b)–(d), -36 and -37 are open risks for dev and CI with synthetic
  identities only, to be built before F-011 or any non-dev deployment, whichever comes first;
- **C2:** SEC-F002-42 is **fixed before G7**
  ([#47](https://github.com/AI-RAM-POC/Ralysa/issues/47)).

The conditions follow.

The quality evidence supports a release candidate for a dev-only Phase 0 skeleton:
- Every automated TC passes in all of these:
  - 5 of 5 idle integration runs;
  - the unit, lint, build, typecheck and repo checks;
  - the scanner self-tests and the image scan;
  - CI on `f795d6b`, PR CI [run 36258446142](https://github.com/AI-RAM-POC/Ralysa/actions/runs/36258446142)
    and the 10-minute soak.
- The NFR bounds are met: token-validation p95 ≤ 0.53 ms standalone, and rotation takes 150.6 s at
  production timings with 0 failures.
- No Critical or High defect was found.

Conditions:

1. **Before G7:** SEC-F002-42 fixed ([#47](https://github.com/AI-RAM-POC/Ralysa/issues/47)), as the
   founder decided (C2).
2. **TC-F-002-28, blocked on E-1, is a condition rather than a G6 blocker**, because:
   - E-1 is an external blocker;
   - the mock IdP covers every flow and failure path that TC-28 repeats;
   - the fail-safe MFA default (EXC-F002-01) fails closed;
   - nothing is deployed outside dev before G6 and TC-28.

   TC-28 must run, and Q4, Q5 and EXC-F002-01 must close, **before any non-dev deployment and
   before G8 UAT with real users**.
3. **Before any non-dev deployment** (security.md P6-7 item 3):
   - C1's items: SEC-F002-35 (b)–(d), -36 and -37 built (or before F-011, whichever comes first);
   - SEC-F002-38: require `--log-checkpoints` outside dev and ship the log off-host;
   - the OpenBao audit device (SEC-F002-11);
   - SEC-F002-43 ([#48](https://github.com/AI-RAM-POC/Ralysa/issues/48));
   - SEC-F002-44 ([#49](https://github.com/AI-RAM-POC/Ralysa/issues/49));
   - SEC-F002-45 ([#50](https://github.com/AI-RAM-POC/Ralysa/issues/50));
   - SEC-F002-46 alerting ([#51](https://github.com/AI-RAM-POC/Ralysa/issues/51), which covers [#45](https://github.com/AI-RAM-POC/Ralysa/issues/45));
   - SEC-F002-49 ([#54](https://github.com/AI-RAM-POC/Ralysa/issues/54));
   - SEC-F002-22: Kubernetes auth-role rendering (F-023);
   - TC-F-002-28 run, with Q4 and Q5 answered and EXC-F002-01 closed;
   - a decision on SEC-F002-10 / Q3 before the E-1 admin consent is given.
4. **Tracked, not gate items:**
   - D-1, added to [#39](https://github.com/AI-RAM-POC/Ralysa/issues/39);
   - D-2, [#57](https://github.com/AI-RAM-POC/Ralysa/issues/57);
   - SEC-F002-47 (#52), -48 (#53), -50 (#55) and -51 (#56);
   - #38 and #39 remain follow-ups.

**Ready for release candidate, with conditions 1–4.** C1 is accepted, and C2 is confirmed: SEC-F002-42 is fixed
before G7 (#47).

## Approval (G6)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / product owner (QA approver) | Approved with conditions | 2026-09-26 | Standing authorization, recorded by Claude. It rests on his chat statement "I am Ram and accept C1& C2" (security.md P6-8). Conditions 1–4 above. |
