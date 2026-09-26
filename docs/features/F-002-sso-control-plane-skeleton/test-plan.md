# F-002: SSO sign-in (OIDC) and control-plane skeleton: Test Plan

> Phase 6 · Owner: test-engineer · Written in `/test F-002` against `main` at `f795d6b`
> Sources: [brief.md](brief.md) (AC-1 to AC-15), [design.md](design.md) §1.1 (AC amended at G4, AC-16 and
> AC-17 added), §1.2 and §8.4 (TC-F-002-01 to -37; TC-32 is intentionally unused), [security.md](security.md).
> Results are in [test-report.md](test-report.md).

## Traceability

Every TC below was located in the code by its id (`grep -rn "TC-F-002-nn"`); the file and test name
are the ones that implement it. Paths are relative to the repository root. "cp" is
`services/control-plane`. Level: U = unit (`pnpm test`, CI `quality`), I = integration
(`test:integration`, CI `integration`, real Postgres and OpenBao dev server, in-process mock IdP),
R = repo check / CI step, S = soak (`soak.yml`), M = manual.

REQ mapping (brief, "Requirements covered"): REQ-016 (a) no password, (b) user and groups, (c) every
sign-in audited, (d) disabled user; REQ-095 (a) credentials only in the vault, (b) rotation without
downtime. AC-11, -12, -16 and -17 build the Phase 0 audit store that REQ-016(c) writes to and that
REQ-071 (Phase 1) extends; AC-13 is the spec §11 data model (DV-12).

| AC | REQ | Test case | Level | Automated file :: test name | Surface |
|---|---|---|---|---|---|
| AC-1 | REQ-016(b) | TC-F-002-01 | I | cp/test/integration/sign-in-browser.int.ts :: "TC-F-002-01: flow B end to end; success is written at redemption; /v1/me; a group change"; cp/test/integration/sign-in.int.ts :: "TC-F-002-01 (flow A): a membership change is stored and audited at the next sign-in" | Service (RTS), `@ralysa/auth` client |
| AC-2 | REQ-016 | TC-F-002-02 | I + U | cp/test/integration/sign-in.int.ts :: "TC-F-002-02: device flow through @ralysa/auth, then the exchange, /v1/me and a refresh"; packages/auth/test/client-flows.test.ts :: "TC-F-002-02: config → IdP device flow (pending, slow_down) → exchange → Ralysa tokens" | Service, `@ralysa/auth` |
| AC-2 | REQ-016 | TC-F-002-03 | I + U | cp/test/integration/sign-in.int.ts :: four tests "TC-F-002-03: an expired device code …", "… a used device code is refused by the IdP; the same IdP token twice is replay", "… a first exchange that fails after the replay key (Graph fault) burns the token", "… missing uti, alg other than RS256, ver 1.0 and an RTS-issued token are refused"; cp/test/entra-token-validator.test.ts (validator matrix) | Service |
| AC-2 | REQ-016 | TC-F-002-04 | I | cp/test/integration/sign-in.int.ts :: "TC-F-002-04: device code off → config says so, the grant is unauthorized_client, flow-A sessions are revoked" | Service |
| AC-3 | REQ-016(a) | TC-F-002-05 | U + I | cp/test/openapi.test.ts :: "no path, parameter or schema property is a password, PIN, OTP or client secret (AC-3)"; tooling/repo-scripts/test/check-no-password.test.ts :: describe "check-no-password over OpenAPI (TC-F-002-05)"; cp/test/integration/sessions.int.ts :: "the token endpoint refuses password, unknown grants, client secrets and Basic auth (AC-3)"; cp/test/app.test.ts :: "RFC 8414 metadata advertises only ES256, S256, public and private_key_jwt clients" | Service API |
| AC-3 | REQ-016(a) | TC-F-002-06 | R + U + M | tooling/repo-scripts/test/check-no-password.test.ts :: describe "check-no-password (TC-F-002-06)"; `check-no-password` runs in `pnpm repo:check`. Manual: MFA is IdP configuration (design §6.7), confirmed in TC-28 | Clients (`packages/auth`; `apps/cli` is a placeholder until F-005) |
| AC-4 | REQ-016(c) | TC-F-002-07 | I | cp/test/integration/sign-in.int.ts :: "TC-F-002-07 (flow A, client reports): every attempt yields exactly one auth.sign_in; no secrets stored"; cp/test/integration/sign-in-browser.int.ts :: "TC-F-002-07 (flow B): 10 sign-ins → exactly 10 success events, no tokens or codes stored"; exit enumeration: cp/test/sign-in-exits.test.ts (53 tests) | Service |
| AC-5 | REQ-016 | TC-F-002-08 | I | cp/test/integration/sign-in.int.ts :: "TC-F-002-08: bob (no group) is denied with the i18n key; no user, no session"; cp/test/integration/sign-in-browser.int.ts :: "TC-F-002-08: bob is refused through the loopback redirect; no user, no session" | Service |
| AC-6 | REQ-016(d) | TC-F-002-09 | I + U | cp/test/integration/sign-in.int.ts :: "TC-F-002-09: carol, refused at the IdP …", "… disabled after the IdP token was minted → user_disabled; a disabled user cannot refresh", "… dora (Graph 404) is refused and, once known, revoked; Entra \"revoke sessions\" stops refresh", "… Graph slower than 3 s → error idp_unavailable", "… the circuit opens after 5 consecutive Graph failures and answers at once", "… Entra \"revoke sessions\" stops refresh and older IdP tokens"; cp/test/integration/gateway.int.ts :: "TC-F-002-09 (gateway part): a user disabled at the IdP is refused after the next feed poll, and after exp"; cp/test/graph-directory.test.ts | Service, fake Model Gateway on `@ralysa/auth` |
| AC-7 | REQ-016 | TC-F-002-10 | I | cp/test/integration/gateway.int.ts :: "TC-F-002-10: a valid token yields user id, org_id and (through PrincipalResolver) groups", "TC-F-002-10: 20 negative cases → 20 rejections, stored as 20 auth.token_rejected events" | Fake gateway (`@ralysa/auth`) |
| AC-7 | REQ-016 | TC-F-002-11 | U | packages/auth/test/access-token-verifier.test.ts :: describe "createAccessTokenVerifier (TC-F-002-11)"; packages/auth/test/revocation-feed.test.ts (G-1 staleness, replayed or stale feed) | `@ralysa/auth` |
| NFR (latency) | — | TC-F-002-12 | U | packages/auth/test/access-token-verifier.test.ts :: "1,000 verifications with a warm JWKS and feed: p95 ≤ 10 ms (target ≤ 2 ms)" | `@ralysa/auth` |
| AC-8 | REQ-016 | TC-F-002-13 | I | cp/test/integration/sessions.int.ts :: "TC-F-002-13: revoke signs out; a later refresh is invalid_grant (revoked) and audited; /v1/me and the feed see it" | Service |
| AC-9 | REQ-095(a) | TC-F-002-14 | I + R | cp/test/integration/scans.int.ts :: "TC-F-002-14: pg_dump --data-only of the test database scans clean", "… cp.credential holds vault paths only", "… the RTS signing and checkpoint keys are non-exportable with no plaintext backup", "… the tracked deploy/** files (committed configs) scan clean"; cp/test/integration/serve.int.ts :: "startup refuses a key that violates custody (TC-F-002-14 part)"; tooling/repo-scripts/test/secret-scan-image.test.ts :: describe "scanImage (TC-F-002-14 image part)"; CI step "Image secret scan (AC-9)" (`secret-scan-cli.ts image`) | Service, image, DB, config |
| AC-10 | REQ-095(b) | TC-F-002-15 | I | cp/test/integration/rotation.int.ts :: "TC-F-002-15: key and IdP secret rotated under 5 rps with 0 failed requests" (harness cp/test/soak/rotation-harness.ts) | Service (two replicas), fake gateway |
| AC-10 | REQ-095(b) | TC-F-002-16 | S | cp/test/soak/rotation.soak.ts via `.github/workflows/soak.yml` | Service |
| AC-11, AC-13 | REQ-016(c) | TC-F-002-17 | I + U | cp/test/integration/audit-routes.int.ts :: describe "POST /v1/audit/events (TC-F-002-17)"; cp/test/openapi.test.ts :: "TC-F-002-17: /v1/audit has POST ingestion and GET query only, no PUT, PATCH or DELETE (AC-11)" | Service API |
| AC-12 | REQ-016(c) | TC-F-002-18 | I | cp/test/integration/audit-routes.int.ts :: describe "GET /v1/audit/events (TC-F-002-18)" | Service API |
| AC-13 | — (spec §11, DV-12) | TC-F-002-19 | I | cp/test/integration/db.int.ts :: describe "schema (TC-F-002-19)" | Data store |
| AC-14 | REQ-095 | TC-F-002-20 | I | cp/test/integration/scans.int.ts :: "TC-F-002-20: the captured logs hold no token, code, verifier, secret or email; users are UUIDs"; the rotation (TC-15) logs: cp/test/integration/rotation.int.ts :: "TC-F-002-20 (rotation logs): the two replicas' logs during TC-15 hold no token or secret; users are UUIDs" (added in this phase, see note 1) | Service logs |
| AC-15 | REQ-016(b) | TC-F-002-21 | I | cp/test/integration/sign-in.int.ts :: "TC-F-002-21: fatima's Arabic name and group names are byte-identical in /v1/me" | Service API |
| AC-16 | REQ-016(c) | TC-F-002-22 | I | cp/test/integration/audit-routes.int.ts :: describe "POST /v1/audit/client-events (TC-F-002-22)" | Service API |
| AC-17 | REQ-016(c) | TC-F-002-23 | I | cp/test/integration/db.int.ts :: describe "insert-only audit store (TC-F-002-23: grants, triggers, seal table, DDL)"; cp/test/integration/audit.int.ts :: describe "sealer (TC-F-002-23 sealing parts; SEC-F002-26)" | Data store |
| AC-1, AC-5 | REQ-016(b) | TC-F-002-24 | I | cp/test/integration/sign-in.int.ts :: "TC-F-002-24: tenant pinning, overage through Graph, look-alike names and non-GUID claims" | Service |
| SR-07 | — | TC-F-002-25 | I | cp/test/integration/sessions.int.ts :: "TC-F-002-25: presenting a rotated token revokes the family; both tokens then fail", "… two concurrent refreshes of one token → exactly one succeeds …", "… a second redemption of a used authorization code revokes its session (SEC-F002-20)" | Service |
| AC-11, SR-07 | REQ-095(a) | TC-F-002-26 | I | cp/test/integration/sessions.int.ts :: "TC-F-002-26: a valid assertion → a 5-minute service token; replay, a foreign key, a wrong aud and a retired version are refused"; tooling/dev-stack/test/integration/policies.int.ts :: describe "OpenBao per-entry-point policies (SEC-F002-02, -22)" | Service, OpenBao |
| ADR-0003 | — | TC-F-002-27 | I | cp/test/integration/db.int.ts :: describe "org isolation (TC-F-002-27)" | Data store |
| AC-1, AC-2, AC-6 | REQ-016 | TC-F-002-28 | M | **No automated test by design** (manual, against the real Entra tenant). Procedure: test-report.md "TC-F-002-28 (AC-1, AC-2, AC-6): BLOCKED on E-1". **Blocked on E-1.** | Real Entra ID, CLI |
| AC-17 | REQ-016(c) | TC-F-002-29 | I | cp/test/integration/checkpoint.int.ts :: describe "checkpoints and audit-verify (F-002-T16, TC-F-002-29)" (signed checkpoints, `checkpoint_gap`, owner rewrite caught, deleted checkpoints detected) | Data store, `audit-verify` |
| AC-1 | REQ-016 | TC-F-002-30 | I | cp/test/integration/sign-in-browser.int.ts :: five tests "TC-F-002-30: …" (binding cookie, other IP denied, `alert` mode, wrong verifier / reuse, unredeemed code) | Service |
| AC-12, SR-08 | REQ-016 | TC-F-002-31 | I | cp/test/integration/sign-in.int.ts :: "TC-F-002-31: admin rights only on strong sign-ins; MFA evidence; ipaddr mismatch flagged"; cp/test/integration/sign-in-browser.int.ts :: "TC-F-002-31: admin rights on flow B (a strong flow), for admin-only and both-group users" | Service |
| — | — | TC-F-002-32 | — | Intentionally unused (design §8.4) | — |
| AC-9, SR-26 | REQ-095(a) | TC-F-002-33 | I | cp/test/integration/serve.int.ts :: "TC-F-002-33: flipping exportable at runtime stops minting, /readyz 503, one custody_violation", "TC-F-002-33: the same for allow_plaintext_backup"; cp/test/integration/checkpoint.int.ts :: "flipping exportable on the checkpoint key stops signing and records ONE secret.custody_violation (TC-F-002-33, T10)" | Service, sealer |
| AC-9 | REQ-095(a) | TC-F-002-34 | U | cp/test/config-serve.test.ts :: describe "production guards (TC-F-002-34; SEC-F002-12)"; cp/test/entry-point-guards.test.ts :: describe "every entry point refuses an in-memory OpenBao in production (TC-F-002-34; #41)" | All entry points |
| T-12 | — | TC-F-002-35 | U + R | tooling/repo-scripts/test/check-imports.test.ts :: "TC-F-002-35: shipped code importing @ralysa/dev-stack or oidc-provider fails; tests and tooling may (SEC-F002-13 a)"; tooling/repo-scripts/test/check-banned-deps.test.ts :: describe "check-banned-deps production closure (TC-F-002-35)"; tooling/repo-scripts/test/secret-scan-image.test.ts :: describe "dev-only exclusion (TC-F-002-35, SEC-F002-13 c)"; tooling/dev-stack/test/mock-idp.test.ts :: "refuses a request without the per-run bearer, or with another one" | Repo, image, mock IdP |
| AC-9 | REQ-095(a) | TC-F-002-36 | U | cp/test/config-serve.test.ts :: describe "serve config (TC-F-002-36; SEC-F002-02)" | Config |
| AC-11 | REQ-016(c) | TC-F-002-37 | U | cp/test/audit-ingest.test.ts :: describe "TC-F-002-37: service allow-list validation at config load" | Config |

**TCs with no implementing automated test:** only **TC-F-002-28**, which is manual by design and
blocked on E-1. TC-F-002-32 is unused. Every other TC (35 of 36 in use) has at least one test that
names it.

Notes:
1. **TC-F-002-20 partial gap closed in this phase.** Design §8.4 says TC-20 scans the logs of TC-07
   **and TC-15**. `scans.int.ts` scans its own flows' logs; the rotation harness only counted
   warning messages and dropped their content (status.md, T14-11). This phase adds an optional log
   capture to `rotation-harness.ts` (both replicas' pino lines at `info`, the same logger the
   signing-key watcher and the IdP-secret watcher use in `serve`) and one test in
   `rotation.int.ts` that scans the captured lines for token shapes and for the exact IdP client
   secret values of the run.
2. **AC-3's "no CLI prompt"** can only be fully checked once `apps/cli` exists (F-005).
   `check-no-password` already runs over the placeholder.
3. **AC-6's "the Model Gateway accepts no request after expiry"** is tested against a fake gateway
   built on `@ralysa/auth` (TC-09 gateway part, TC-10). The real gateway is F-004.

## Governance & security cases

- [x] **Unauthorized group denied at API**: TC-08 (bob, flows A and B, no user and no session
  created), TC-24 (look-alike group, other tenant), TC-18 (non-admin audit query → 403 and audited),
  TC-31 (admin only on strong flows), TC-17 (user token at the service path → 403). All server-side.
- [x] **Approval gate blocks side effect until approved**: N/A. F-002 has no side-effecting agent
  actions (brief, Governance). The client-attested path refuses intents under a kill-switch (TC-22,
  423).
- [x] **Audit event written for every call**: no model or tool calls in F-002. Every sign-in attempt
  (TC-07, 50 attempts reconciled; `sign-in-exits.test.ts` enumerates every exit), every token
  rejection (TC-10, 20/20), sign-out (TC-13), refresh denial (TC-09, TC-13), audit query (TC-18),
  rotation (`secret.rotated`, TC-15), custody violations (TC-33), modification attempts (TC-23).
- [x] **PII masked in logs/traces**: TC-20 (no email, users by UUID, no tokens or codes), TC-14
  (DB dump and logs scanned).
- [x] **Residency / model routing enforced**: N/A for enforcement (REQ-096, F-023). `residency`,
  `endpoint_region` and `inference_region` exist (TC-19) and are stored by the ingestion path (TC-17).
- [x] **Prompt-injection cases**: no model in F-002. The untrusted-input analogues are covered:
  forged `actor` in client events replaced by the token subject (TC-22); reserved `details` keys
  refused (TC-22); a service writing another service's actions refused (TC-17, TC-37); bidi-control
  stripping on untrusted display fields (design §3.5, protocol unit tests); Entra tokens with wrong
  `alg`, `ver`, missing `uti`, other tenant (TC-03, TC-24).
- [x] **Authz bypass attempts**: `alg: none`, HS256 with the public JWK, `jku`/`jwk`/`x5u`/`x5c`/`crit`
  headers, wrong or array audience, refresh token as bearer, Entra token presented directly,
  service token at a user route (TC-10, TC-11); `X-Org-Id` and body `org_id` ignored (TC-27);
  refresh-token and code reuse (TC-25); client-assertion replay and foreign key (TC-26); OpenBao
  policy boundaries (TC-26).

## LLM evals

N/A: F-002 has no model behaviour (design §8.1). No eval set.

| Eval ID | Input | Expected behaviour | Rubric | Models |
|---|---|---|---|---|
| — | — | — | — | — |

## Cross-surface

F-002 ships the service and `@ralysa/auth`. CLI sign-in is F-005; Desktop PKCE and Web sign-in are
F-006. The client half of flows A and B is exercised through `@ralysa/auth` (TC-02, TC-01), which
the CLI will wrap. No Desktop or Web surface to compare.

## NFR checks

| NFR | Target | Method |
|---|---|---|
| Token validation added to a gateway request | ≤ 10 ms p95 (design target ≤ 2 ms, warm cache) | TC-12: 1,000 verifications, warm JWKS and feed; run in the full `pnpm test` and standalone |
| Gateway overhead p95 (§12) | < 100 ms | Not in F-002: measured with the real gateway in F-004. TC-12 is F-002's share of that budget |
| New credentials in use after rotation (AC-10) | ≤ 5 min (design ≤ 150 s) | TC-15 (compressed, per run) and TC-16 (soak at production timings) |
| Failed requests during rotation (AC-10) | 0 | TC-15, TC-16 |
| Revocation reaches a verifying service | ≤ 60 s (`revoked_before` feed, G-1 staleness after 60 s) | TC-09 gateway part, TC-11, TC-13 |
| Event sealed into the hash chain (AC-17) | ≤ 5 s | TC-23 ("the running sealer loop seals a new event within 5 s") |
| Access-token lifetime (AC-6) | ≤ 15 min | Config default `tokens.access_ttl_s` 900 and TC-09 (expiry with `access_ttl_s=5`) |
| Sign-in audit completeness (AC-4) | 100 % | TC-07 |
| Workspace cold start (§12) | < 15 s | N/A: no workspace in F-002 |
| Accessibility | WCAG 2.1 AA | N/A: F-002 has no HTML page (design §7). The one browser-facing response is a `text/plain` en + ar body (checked in sign-in-browser.int.ts). axe/Playwright (`ui-e2e`) has nothing of F-002's to scan |
| RTL / Arabic | Correct text | TC-21 (Arabic display and group names byte-identical, harakat intact); `Content-Language: en, ar` plain-text error with an Arabic sentence; `services/control-plane/src/i18n/en.json` and `ar.json` have identical key sets |

## Test data & environment

- **Local:** macOS (Darwin 27, arm64), Node 24.21.0, pnpm 11.27.1, Docker dev stack from
  `deploy/docker/dev/compose.yaml` (Postgres 17 on 127.0.0.1:55432, OpenBao dev server on
  127.0.0.1:58200), bootstrapped by `tooling/dev-stack` (`bootstrap`). `.env` is local and git-ignored.
  `RALYSA_REQUIRE_DEV_STACK=1` so a missing stack fails instead of skipping. gitleaks 8.30.1 from
  `pnpm tools:install`.
- **Identities:** the mock IdP fixtures only (design §8.3: alice, bob, carol, dora, dana, erin,
  fatima, olga, mallory, sam), with per-run signing keys and a per-run control bearer. No real
  identities, no customer data (PRD A-5).
- **Isolation:** a fresh database per integration worker from a migrated template; per-worker
  OpenBao prefixes and Transit key names.
- **CI:** `quality`, `integration` (with the image scan) and `soak.yml` (TC-16, dispatched on `main`).
- **Real Entra ID tenant (E-1):** not available. TC-28 waits for it.
- **Repetition:** the full integration suite is run at least 3 times to measure flakiness (known
  flaky classes: #39).
