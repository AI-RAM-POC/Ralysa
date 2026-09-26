# F-002: SSO sign-in (OIDC) and control-plane skeleton: Security Review (Phase 4)

> Phase 4 · Owner: security-reviewer · Reviewed: `design.md` at `origin/design/F-002` commit `fa27aaf` (2026-09-25). Line numbers (Lnnn) refer to that file. · Inputs: `brief.md`; `docs/architecture/security.md` TM-01/02/03/04/06/40/45/46/49, SR-06/07/08/09/10/26/29, P0-1 to P0-4; `identity-and-policy.md` §3, §4, §5.6; `observability-audit.md` §3; ADR-0010, ADR-0021, ADR-0022; F-001 `security.md` (RF-1/RF-2 accepted risks); current `.github/workflows/ci.yml` and `check-ci-invariants.ts`.
> Status: **Review for G4.** Date: 2026-09-25. This is a design review only: nothing was run against any real system. The only external lookup was Microsoft's public Entra access-token claims reference.
> Labels: **Confirmed** means the design text (or documented Postgres, OpenBao or Entra behaviour) shows the issue. **Suspected** means it depends on implementation choices or a fact still to verify.

## 1. Scope

In scope:
- **RTS.** Flow A (Entra device flow plus RFC 8693 exchange), flow B (loopback plus PKCE through RTS), refresh, revoke, `client_credentials` with Transit-signed RFC 7523 assertions, JWKS, the governance feed.
- **`packages/auth`**: the verifier, the revocation feed and the client flows.
- **Identity mapping** (SR-06) and Graph use.
- **The Phase 0 audit store**: roles, trigger, sealer, service and client-attested ingestion, and query.
- **RLS and pooling.**
- **`packages/secrets`** and OpenBao custody.
- **Logging.**
- **The dev stack and mock IdP.**
- **The new CI `integration` job.**

Out of scope: F-005 CLI internals (keychain, loopback listener), apart from the requirements this design places on them. Also out of scope: F-011 WORM checkpoints, F-012 kill-switch API, and F-006 PDP.

**Assets**
- RTS signing key: Transit `ralysa-rts-signing`.
- Service signing keys: `ralysa-svc-*`.
- Entra client secret, which also carries the Graph application permissions.
- DB role passwords, especially `ralysa_migrator`.
- Refresh tokens and authorization codes.
- The `audit` schema and its seal chain.
- The governance feed (revocation and kill-switch).
- Directory data: `oid`, email, display name, group membership, client IP.

**Trust boundaries**
- CLI or browser to RTS: public, unauthenticated endpoints.
- RTS to Entra and Graph: outbound, with the confidential client secret.
- Services to RTS: service tokens.
- RTS to OpenBao: workload identity.
- RTS to Postgres: per-role pools under RLS.
- DBA, migrator and superuser to the `audit` schema: the privileged-insider boundary.
- CI runner running PR code.

**Entry points**
- `/.well-known/*`
- `/v1/auth/config`
- `/oauth2/authorize`
- `/oauth2/idp/callback`
- `/oauth2/token`
- `/oauth2/revoke`
- `/v1/auth/sign-in-failures` (unauthenticated)
- `/v1/me`
- `/v1/internal/*`
- `/v1/audit/events` (POST and GET)
- `/v1/audit/client-events`
- The `migrate`, `sealer` and `bootstrap-org` entry points
- The dev-stack CLI and mock IdP test-control API

**Overall assessment.** The design is strong and closes P0-1, P0-2 and most of P0-4:
- object-ID matching, pinned `iss`/`tid`/`azp`, and fail-closed overage;
- one audience per token, with ES256, `typ` and `alg` pinned;
- non-exportable Transit signing with publish-then-activate;
- rotation with family revocation;
- an insert-only writer and a client-attested path with actor overwrite.

Two gaps must be fixed at G4:
- **The migrator role can defeat audit integrity.** It owns the audit tables and the trigger, and nothing anchors the chain before F-011.
- **The serving process can read the migrator password.**

Several Medium items are cheap design edits. They cover which service may write which audit events, ConsentFix-style code phishing on flow B, production-mode guards, mock-IdP exclusion, and client-path session binding.

## 2. Threat table (STRIDE plus agent-specific)

| # | Threat | Likelihood | Impact | Existing control in design | Gap | Recommendation (finding) |
|---|---|---|---|---|---|---|
| T-1 | Device-code phishing gives the attacker the victim's session (TM-01, S) | H | H | IdP-native flow so Conditional Access applies; tenant switch; `--browser`; exchange IP and device label recorded | No IP-mismatch signal; admins exposed; RTS doesn't enforce MFA evidence | SEC-F002-05, -06 |
| T-2 | Loopback authorization-code phishing (the victim pastes the `127.0.0.1` URL), S | M | H | PKCE S256, 60 s single-use code | Nothing ties the browser that signed in to the redeeming CLI | SEC-F002-04 |
| T-3 | IdP-token replay or confusion at the exchange (S) | M | H | Pinned `iss`, `tid`, `aud`, `azp`, `scp`; freshness; `uti` replay table | Missing-`uti` case; replay key rolled back with the transaction; `alg` allow-list | SEC-F002-07, -19 |
| T-4 | Group spoofing, overage or format drift (TM-02, E) | M | H | Object IDs, `checkMemberGroups`, deny on error | Config and claim values not forced to GUIDs; `_claim_sources` handling; deleted users | SEC-F002-08, -09 |
| T-5 | Refresh-token theft (TM-40, S) | M | H | Rotation, reuse revokes the family, keychain (F-005), revocation within 60 s | Cross-process refresh races cause false reuse | SEC-F002-17 |
| T-6 | Signing-key exfiltration or misuse (TM-38, S/E) | L | Critical | Transit `exportable=false`, sign-only policy, startup check | Flag can later be flipped to exportable; no OpenBao audit device | SEC-F002-11 |
| T-7 | Service impersonation or forged service audit (SR-07, S/R) | M | H | Per-service Transit key; assertion `jti`, `aud`, `exp` | Any service may write any action for any user; AppRole secret-zero; policy tests | SEC-F002-03, -22, -23 |
| T-8 | Audit tampering by a privileged DB role (TM-45a, T/R) | M | H | Insert-only writer, trigger, sealer chain | Migrator owns everything and can rewrite the chain; the migrator password is readable by `serve` | SEC-F002-01, -02, -25 |
| T-9 | Forged or evasive client-attested events (TM-45b, R) | H | M | Actor overwrite, allow-list, `client_seq`, kill-switch refusal | Client chooses `session_id`; `details` namespace collides with server keys; no end-of-session reconciliation | SEC-F002-14, -15 |
| T-10 | Audit flood as a DoS lever (TM-46, D) | M | H | Some per-IP limits, rejection aggregation | Unauthenticated endpoints write audit; per-IP aggregation defeated by rotating IPs | SEC-F002-16, -24 |
| T-11 | Cross-tenant data through RLS or pooling (TM-04, I) | L (single org) | H | FORCE RLS, transaction-local `set_config`, `current_org()` errors when unset | `org_id` source for unauthenticated routes unstated; no guard against session-level `SET` | SEC-F002-31 |
| T-12 | Dev artefacts reaching production (dev token, dev OpenBao, mock IdP) (E) | M | Critical | "Never shipped" intent; dev-token refusal by env | Two env sources; no production guard set; exclusion not enforced | SEC-F002-12, -13 |
| T-13 | Secrets or tokens in logs, CI artefacts or images (I) | M | M | pino redaction, scrubber, route-template logging, gitleaks, exact-value scans | Fastify default URL logging; CI failure artefact; image metadata | SEC-F002-21, -27, -29 |

## 3. Findings

| ID | Finding | Status | Severity | Location (design §, line) | Recommendation |
|---|---|---|---|---|---|
| SEC-F002-01 | **The migrator can silently defeat audit integrity, and the chain doesn't detect it in Phase 0.** `ralysa_migrator` owns both schemas, all tables, the trigger function and the triggers. In Postgres a table owner (no superuser needed) can do all of the following: `ALTER TABLE audit.audit_event DISABLE TRIGGER`, `DROP TRIGGER`, `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`, `DROP POLICY`, `TRUNCATE` (after disabling the TRUNCATE guard), and `UPDATE`/`DELETE` on `audit.audit_seal`. The chain is unkeyed SHA-256 with no external anchor until F-011. Anyone who can write `audit_seal` can therefore recompute a consistent chain after changing, deleting or truncating events. The claim that "the sealer chain detects any later change to a sealed row" holds only against roles that cannot write `audit_seal`. | Confirmed | **High** | §4.1 L799; §4.5 L915–919; §4.6 L921–928 | (a) Create a dedicated `NOLOGIN` owner role (`ralysa_audit_owner`) for the `audit` schema and its functions. `ralysa_migrator` must not be a member. Apply audit-schema migrations through a separate, audited path: the DBA runs `SET ROLE` under break-glass, or a separate `migrate --audit` job with its own credential. (b) In `bootstrap-roles.sql`, have the DBA create an event trigger (superuser-owned) that records DDL on the `audit` schema. Use `pgaudit` where available. (c) Bring the smallest external anchor forward into F-002. Every 60 s the sealer signs the chain head `(org_id, shard, seq, hash)` with a sealer-only Transit key (`ralysa-audit-checkpoint`, which ADR-0021 already plans) and stores it in `audit.audit_checkpoint`. It also emits the head to the application log. DB roles can't forge those signatures. WORM upload stays in F-011. (d) Correct the §4.5 text to state the real residual. |
| SEC-F002-02 | **The serving process can read the migrator password.** The OpenBao policy `ralysa-control-plane` has `read` on `kv/data/ralysa/control-plane/db/<role>`, which covers every role including `migrator`. `ControlPlaneConfig.db.credentials` also carries the migrator path for every entry point. Remote code execution in `serve` therefore becomes table-owner rights on `audit`, which leads to SEC-F002-01. | Confirmed | **High** | §6.5 L1233; §3.8 L767–769 | Use one OpenBao policy and one config shape per entry point. `serve` reads `cp_app`, `audit_writer` and `audit_reader`. `sealer` runs as a separate process or deployment (the `main.ts sealer` entry) and reads `audit_sealer` only. `migrate` runs as a one-shot job under its own OpenBao role and reads `migrator` only. Add a unit test that `serve` fails validation if it is given a migrator or sealer path. |
| SEC-F002-03 | **Service audit path: any registered service may write any action with any user actor.** Only user existence is checked. A compromised service (Workspace Runtime is the most exposed, next to the sandbox) can write `auth.sign_in success`, `audit.*`, `secret.rotated`, `directory.*`, `db.migration.applied` or another user's `model.call.*` events. `source` is bound to the token, which helps forensics, but console and evidence views keyed on `action` will show the forged event. | Confirmed | Medium (High once F-003/F-004 are live) | §3.4.4 L494–509; §6.4 L1207; §3.5 `AuditEventInput.action` L588 | Add a per-service action-prefix allow-list to `services[]`, for example model-gateway: `model.*`, `usage.*`. Reserve `auth.`, `audit.`, `secret.`, `directory.`, `db.`, `policy.` and `kill_switch.` for the control plane's own writer. Reject anything else with `403` and audit the rejection. Add the case to TC-F-002-17. |
| SEC-F002-04 | **Flow B is open to authorization-code phishing (ConsentFix-style; the public reference is still to verify).** An attacker starts `/oauth2/authorize` with their own PKCE challenge and a loopback port, then sends the link to a victim. The victim completes a genuine Entra sign-in with MFA. RTS redirects the victim's browser to `http://127.0.0.1:<attacker-port>/callback?code=rly_ac_...`, the page fails to load, and a phishing page asks the victim to paste the URL. The attacker redeems the code with their verifier within 60 s. PKCE does not help, because the attacker owns the verifier. The RTS `state` is not bound to the browser. | Confirmed (attack class); Suspected (exploitability within 60 s) | Medium | §3.3 L371–380; §5.2 L973–1003; §4.4 `idp_auth_request` L885–889 | (a) Record the client IP at `/oauth2/authorize`, at `/oauth2/idp/callback` and at code redemption. In a genuine loopback flow the browser and the CLI are on the same host. If the callback IP differs from the redemption IP, write `auth.sign_in` with `details.ip_mismatch=true` and deny by default, with a per-tenant override for split-tunnel VPNs (open question Q2). (b) Set a `__Host-` cookie at `/oauth2/authorize` and require it at `/callback`. This stops the variant where only the IdP link is sent. (c) F-005 requirement: the loopback page never asks users to copy URLs, and the CLI binds `127.0.0.1` only. (d) Add a TC. |
| SEC-F002-05 | **Device-code phishing residual (U-4, OQ-D5) has no detection signal.** SR-08 and P0-3 ask for an alert when the approving IP and the polling IP differ. Entra v2 access tokens can carry `ipaddr` as an optional claim, the IP the user authenticated from (Microsoft claims reference, accessed 2026-09-25). The design requests only `email`. | Confirmed (gap); Suspected (that `ipaddr` reflects the approving browser in the device flow: verify in TC-F-002-28) | Medium | §3.2.5 L339–355; §6.7 L1249; §6.9 SR-08 row L1270; OQ-D5 L1542 | Request the `ipaddr` optional claim on the RTS app registration. At exchange, store `details.idp_ipaddr` and the exchange `client_ip`, set `ip_mismatch`, and alert. Add Conditional Access guidance to §6.7: allow device code only from named locations or compliant devices, or block it. **OQ-D5: accept for Phase 0 only with these conditions and SEC-F002-06.** |
| SEC-F002-06 | **Admins can be phished through device code, and RTS never checks MFA evidence.** D-23 lets admin-only users sign in through flow A. A device-code-phished admin gets audit read over the whole org. `require_mfa_claim` defaults to `false`. The Microsoft reference lists `amr` (and `acrs`) as access-token claims without the "v1.0 only" marker. `audit.query success` is not stated as written before data is returned. | Confirmed | Medium | §6.1 L1179; D-23 L1528; §3.8 L756; §3.4.6 L555–560 | (a) Honour `platform_admin` only on sessions with `flow=loopback_pkce`, or where `acrs` contains the admin authentication context, or where `amr` shows phishing-resistant MFA. Otherwise mint no admin rights and audit `denied reason=admin_requires_strong_flow`. (b) Default `require_mfa_claim` to `true` when `env=production`, once TC-28 confirms `amr` is present. (c) Make `audit.query success` fail closed: write it before streaming results. |
| SEC-F002-07 | **Exchange replay semantics don't guarantee "exchanged only once" (AC-2).** (a) The key is "`uti` (or `jti`)", and the behaviour when both are absent is undefined. (b) The key is inserted "in the same transaction", so any rollback re-arms the token. That covers Graph unavailable, errors after insert, and denials that abort. (c) The IdP-token checks don't pin `alg` or `ver`. | Confirmed | Medium | §3.2.5 L339–353; §4.4 L890 | Require `uti` and reject the token if it is missing. **Consume first**: insert the replay key and commit it in its own transaction before any other processing, so every exchange attempt, whatever its outcome, burns the IdP token (the user restarts the device flow). Pin `alg=RS256`, `ver="2.0"` and `typ=JWT`. Reject a `subject_token` whose `iss` is RTS itself. Extend TC-F-002-03 with the "failure then retry" case. |
| SEC-F002-08 | **Group identifiers aren't forced to object IDs.** `access.access_group_id` and `admin_group_id` are `z.string()`, so an operator can type a display name. Entra can emit on-premises names (sAMAccountName) in `groups` for synced groups when configured. The overage `_claim_sources.endpoint` is an Azure AD Graph URL. Microsoft says not to rely on it, and it is token-controlled input. | Confirmed | Medium | §3.8 L758; §6.3 L1195–1200 | Use `z.uuid()` for both group ids. Treat any non-GUID `groups` value as "claim unusable" and resolve through Graph, or deny. Never dereference `_claim_sources`; call only the configured Graph base. When `groups` is absent without an overage marker, resolve through Graph rather than defaulting to an empty list. Graph is already called at every sign-in, so always using `checkMemberGroups` is the simplest correct option. |
| SEC-F002-09 | **Graph state checks: error classification and Entra session revocation.** A deleted user returns `404` from Graph. If that maps to `idp_unavailable`, `revoked_before` is never set, access tokens live up to 15 min, and the session is never revoked. Entra's "Revoke sessions" (`signInSessionsValidFromDateTime`) is not honoured, although it is the first action an incident responder at a bank takes. Graph timeouts aren't specified. | Suspected | Medium | §5.3 L1026–1037; §6.3 L1198; §5.8 L1159–1160 | Map `404` / `Request_ResourceNotFound` to `user_disabled` and revoke. At every refresh, read `accountEnabled,signInSessionsValidFromDateTime`. If that timestamp is later than `auth_session.created_at`, revoke the session and set `revoked_before`. Set explicit Graph timeouts (≤ 3 s) and a circuit breaker. Add these to TC-F-002-09. |
| SEC-F002-10 | **RTS reaches Entra with a static client secret that has tenant-wide `User.Read.All` and `GroupMember.Read.All`.** A stolen secret gives read of the whole directory, which is sensitive for banks and government. It is the one static credential left against SR-26. | Confirmed | Medium | §6.3 L1199; §6.5 L1232; §6.7 L1249–1250; §3.8 L753 | Preferred: certificate credential (`private_key_jwt`) toward Entra, with the private key as a non-exportable Transit key and the client assertion signed through Transit, as the service assertions already are (to verify: building the self-signed certificate over the Transit key). Otherwise, for Phase 0: secret lifetime ≤ 180 days; Conditional Access for workload identities / named-location restriction on the service principal where licensed; Graph activity logs enabled; and the secret-rotation runbook (T13) records expiry. Also consider a separate app registration for Graph reads, so the OIDC secret doesn't carry directory permissions. |
| SEC-F002-11 | **Transit exportability is checked only at startup.** OpenBao and Vault let `exportable` and `allow_plaintext_backup` be changed from `false` to `true` later through `transit/keys/:name/config`, after which `transit/export` or `backup` returns the private key. The design checks `exportable` only at startup and doesn't check `allow_plaintext_backup` in `describe()`. No OpenBao audit device is specified. | Confirmed | Medium | §3.2.4 L317; §3.7 L716–732; §5.8 L1166; §6.5 L1228–1233 | The key watcher re-checks both flags on every 30 s poll. If either is `true`, it stops signing (`/readyz` goes unready), writes `secret.custody_violation` and alerts. `describe()` rejects either flag. Policies explicitly deny `transit/keys/+/config`, `transit/export/*`, `transit/backup/*`, `transit/restore/*`, `transit/keys/+/import*` and `transit/keys/+/rotate` for every non-operator identity. Enable an OpenBao audit device (file or socket) in every non-dev environment. Its log is the QCB "retain access to KMS logs" evidence. Add an integration test that flips the flag at runtime. |
| SEC-F002-12 | **No production-mode guard set, and two sources of truth for the environment.** Dev-token auth is refused "unless `RALYSA_ENV` is dev or test", but the config has its own `env`. A mismatch, or an unset variable with a permissive default, allows `token` auth in production. Nothing detects a dev-mode OpenBao (in-memory storage, `http://`), `db.ssl=false`, an `http` issuer, or `trust_proxy_cidrs` of `0.0.0.0/0`. | Confirmed | Medium | §3.7 L721–724; §3.8 L740–756, L764; §6.5 L1224 | One source (`config.env`). Treat unset as `production`. When `env=production`, refuse to start on any of these: vault `token` auth; AppRole unless `allow_approle: true` (see SEC-F002-22); `http://` for vault, `public_base_url` or IdP issuer; OpenBao `sys/seal-status` reporting `storage_type: inmem`; `db.ssl=false`; `trust_proxy_cidrs` containing `0.0.0.0/0` or `::/0`; an issuer that doesn't match `^https://login\.microsoftonline\.com/<tenant_id>/v2\.0$`; `jwks_file` unless `deployment_model=air_gapped` (and then only with a pinned SHA-256 in config). Test each refusal (unit). |
| SEC-F002-13 | **Nothing enforces keeping the mock IdP out of production.** The design states intent (`shipped: false`, devDependency) but no enforcing check. The mock's test-control API can mint Entra-shaped tokens. | Confirmed | Medium | §2 L77–78; §2.2 L204; §8.3 L1321–1339 | (a) dependency-cruiser rule: nothing under `services/**`, `packages/**` or `apps/**` imports `@ralysa/dev-stack` or `oidc-provider`, except `test/**`. (b) `check-banned-deps`: `oidc-provider` must not be in the production closure of any `shipped: true` workspace. (c) The T14 image scan asserts that neither `oidc-provider` nor `dev-stack` is in the image. The Dockerfile uses `pnpm deploy --prod`. (d) Generate mock signing keys per run, never committed. (e) The test-control API binds `127.0.0.1` and requires a random per-run bearer. (f) The production issuer pattern from SEC-F002-12 is the runtime backstop. |
| SEC-F002-14 | **Client-attested completeness is easy to evade, and the client path doesn't fail closed.** `session_id` is client-chosen, so a host can use a new session for every event and never produce a gap. No end-of-session reconciliation exists, although observability-audit §3.3 and SR-29 require it, so trailing drops are invisible. `client_audit_cursor` grows without bound (up to 600 new rows per minute per user). Behaviour on insert failure or timeout isn't stated for this path. The kill-switch check covers the tenant scope only. | Confirmed | Medium | §3.4.5 L511–551; §4.4 L909; §5.6 L1095–1119 | Bind `session_id` to a server-issued id: `session.started` returns it, bound to the token's `sid`; unknown ids get `409`. Cap open sessions per `sid`, for example 20. `session.ended` carries `final_seq`, and the server writes `audit.client_seq_gap` for any missing tail. Add an hourly sweep that flags sessions without `session.ended` (`audit.client_session_unterminated`). State that an insert failure or a timeout over 250 ms gives `503` with `ack=false` (G-5/G-6). Note that F-012 extends the kill-switch check to department, pack and agent scopes. |
| SEC-F002-15 | **Client `details` share a namespace with server-set keys.** The server writes `details.seq_gap`, `details.reported_by`, `identifier_verified` and so on into the same `details` object the client supplies (`z.record(z.string(), z.json())`, unbounded). A client can pre-fill `seq_gap` or `reported_by: "server"` to mislead reviewers. No per-event or body size limit is set for this path. | Confirmed | Medium | §3.4.5 L533, L548; §3.5 L636 | Put server-owned facts in columns, or under `details.server.*`, and reject client payloads that contain reserved keys (`422`). Namespace client data as `details.client.*`. Limit to 4 KB per event and 256 KB per body. Treat `resource.id`, `reason_code` and `trace_id` from this path as untrusted display strings (TM-11). |
| SEC-F002-16 | **Unauthenticated audit-write amplification (TM-46).** Each unauthenticated request writes to the shared audit DB: a failed `/oauth2/token` exchange writes `auth.sign_in failure`; `/oauth2/authorize` inserts an `idp_auth_request` row; `/v1/auth/sign-in-failures` is limited per IP only. `auth.token_rejected` aggregation is per `(source_ip, reason, audience)`, which rotating IPv6 addresses defeat. The same DB carries the fail-closed intents for the gateways (G-5). | Suspected | Medium | §3.4.1 L452; §6.4 L1206; §3.1 L216–232 | Set per-IP and **global** limits on every unauthenticated route: `/oauth2/*`, sign-in failures and the JWKS refetch path. Aggregate identical failure events (same reason, same `/24` or `/64`, per minute, with `suppressed_count`). Cap rejection events per verifier instance. Never block a rejection on audit. Alert on `audit_write_failures_total` and on the rate. Document that throttled `429` requests are not "sign-in attempts" for AC-4. |
| SEC-F002-17 | **Behaviour for the losing concurrent refresh is undefined.** Single-flight is per process. If the CLI and the local Agent Host refresh from the same keychain entry, the loser presents a `rotated` token. Under the current rules that is reuse and revokes the honest user's session family. | Suspected | Low | §3.2.3 L309–310; D-27 L1532 | State that exactly one process per device refreshes (the `TokenProvider` over IPC, identity-and-policy §4.3), and add it to the F-005 and F-003 contracts. Specify the loser's response and cover it in TC-F-002-25. Keep "no grace window". |
| SEC-F002-18 | **Governance feed and revocation details.** (a) "Confirmed" must mean an authenticated response with `issued_at` within skew and a non-decreasing `epoch`, so a cached or replayed response can't keep a PEP "fresh". (b) The unfiltered window is tied to `access_ttl`, but F-006 makes the TTL configurable up to 60 min. (c) Replica clock skew between `iat` and `revoked_before`. (d) The control plane's own user routes (`/v1/me`, audit query, client events) must apply the `sid` and `revoked_before` checks too; it is a PEP (§6.1). (e) The verifier doesn't state rejection of an `iat` in the future. | Suspected | Low | §3.2.6 L357–363; §3.4.3 L477–490; §3.6 L665–676 | (a) Validate freshness and monotonic epoch in `createRevocationFeed`. (b) Size the window by the maximum configurable TTL plus 5 min. (c) Take `iat` and `revoked_before` from the DB clock (`now()`) or add skew to `revoked_before`. (d) Control-plane routes use the same verifier, reading revocation state directly. (e) Reject `iat > now + skew`. |
| SEC-F002-19 | **JOSE header and algorithm hardening.** `AccessTokenHeader` is `looseObject`, so `jku`, `jwk`, `x5u`, `x5c` and `crit` are tolerated. The IdP-token validation doesn't state an `alg` allow-list. The `kid` regex hard-codes `ralysa-rts-signing` while `vault.signing_key` is configurable. | Confirmed | Low | §3.2.2 L270–274; §3.2.5 L343; §3.8 L766 | Reject Ralysa tokens that carry `jku`, `jwk`, `x5u`, `x5c` or `crit`. IdP tokens use `algorithms: ['RS256']` (verify in T10). Derive the `kid` pattern from config, or make `signing_key` a literal. |
| SEC-F002-20 | **Authorization-code reuse isn't detected.** The code is "deleted on use", although the table has `used_at`. Following RFC 9700 guidance, a second redemption should revoke what the first issued. The atomic consumption of `idp_auth_request` isn't stated. | Confirmed | Low | §4.4 L881–889; §3.3 L418–419 | Keep a tombstone with `used_at` until expiry. A second redemption revokes the session and writes `auth.token.reuse_detected`. Consume `idp_auth_request` with `DELETE ... RETURNING` (one statement). |
| SEC-F002-21 | **Logging gaps.** Fastify's default request log and `req` serializer include `req.url`, so `/oauth2/idp/callback?code=...&state=...` would be logged unless request logging and the serializer are overridden, and the 404 and error handlers are too. The redaction list lacks `device_code`, `client_secret` (refused but may be sent), `id_token`, `access_token`, `assertion`, `x-vault-token`, OpenBao token formats (to verify) and `postgres://user:pass@`. Future OTel HTTP instrumentation records full URLs. | Suspected | Low | §6.6 L1237–1243 | Set `disableRequestLogging: true` and a custom `req` serializer (method, route template, `request_id`). Extend redaction and the scrubber with the fields above. Add a rule now: no OTel HTTP instrumentation without URL query redaction (TM-24). Extend TC-F-002-20 with a callback URL and a failed OpenBao call. |
| SEC-F002-22 | **Service identity (AD-1): workload binding and non-Kubernetes deployments.** AppRole outside a cluster needs a `secret_id`, which is a static secret and contradicts "No static service secret exists anywhere". Kubernetes-auth roles must bind exactly one ServiceAccount, namespace and audience, or any pod in the namespace can log in as any service. TC-F-002-26 tests RTS's refusal of a foreign key but not the OpenBao policies themselves. | Confirmed (AppRole secret-zero); Suspected (bindings) | Low | §3.2.7 L365–367; §6.5 L1219, L1231; §3.8 L770 | Kubernetes roles set `bound_service_account_names`, `bound_service_account_namespaces` and `audience`, one per service. For AppRole in production: response-wrapped `secret_id`, `secret_id_bound_cidrs`, `token_bound_cidrs`, `secret_id_num_uses`, short TTL, and explicit opt-in (SEC-F002-12). Add a bootstrap test that `ralysa-svc-A` gets `403` on `transit/sign/ralysa-svc-B` and on `transit/keys/*/config`. RTS accepts only non-retired key versions for assertions. **OQ-D2: accept for Phase 0 with these conditions.** |
| SEC-F002-23 | **OQ-D7 (direct INSERT by F-004) would bypass source binding.** The writer's column grant excludes only `ts`, `ingest_seq` and `schema_version`, so a direct writer can set `source=control-plane` and `attestation=server` and any action. | Suspected (future) | Low (Medium if adopted) | §4.1 L801; OQ-D7 L1544 | Security prefers the service API. If direct insert is chosen, use per-service DB roles plus a `BEFORE INSERT` trigger that derives `source` from `current_user` and forces `attestation=server`, and apply the SEC-F002-03 action allow-list in the trigger. |
| SEC-F002-24 | **The denial and completion spool is fragile.** A local disk spool on an ephemeral container filesystem is lost on restart. It holds PII (`client_ip`, `attempted_identifier`). Replayed rows get the DB `ts` at replay, not the event time. | Suspected | Low | §2.1 L135–136; §5.8 L1157–1158 | Use a persistent volume, or accept the loss and emit `audit_spool_lost_total` on start. Files `0600` in a dedicated directory. On replay, store `details.original_ts` and `details.spooled=true`. |
| SEC-F002-25 | **`reject_modify()` trigger details.** It sets `app.org_id` locally inside the caller's transaction and doesn't restore it, which will be a cross-org scoping bug once multi-org exists. It writes one `audit.modify_denied` per row, so a mass `DELETE` floods the audit table. Roles that can set `session_replication_role=replica` skip ordinary triggers entirely. | Confirmed | Low | §4.5 L918 | Save and restore the previous `app.org_id`. Dedupe to one event per statement with a row count, using a transaction-local flag keyed on `statement_timestamp()`. Never grant `SET` on `session_replication_role` (PG15+) to Ralysa roles. Cover this in TC-F-002-23. |
| SEC-F002-26 | **Sealer locking and placement.** A session-level `pg_try_advisory_lock` on a pooled connection can leave a lock held by an idle connection, which blocks sealing, or be released mid-pass. The design doesn't say the sealer runs apart from `serve`. | Suspected | Low | §4.6 L926; §2.1 L100, L141 | Use `pg_try_advisory_xact_lock` inside the sealing transaction. Keep the PK `(org_id, shard, seq)` as the fork guard. Run the sealer as its own process with only `audit_sealer` credentials (SEC-F002-02). Alert when `audit_seal_lag_seconds` exceeds 5. |
| SEC-F002-27 | **CI `integration` job: token scope and failure artefact.** The job runs PR code, including a PR-controlled `compose.yaml` that can start privileged containers. It has no `permissions:` block, and checkout keeps `persist-credentials: true` (F-001 RF-2 accepted at repo level). The failure artefact uploads raw compose logs. The OpenBao dev server prints its root token and unseal key, and Postgres may log statement values. `::add-mask::` applies to job logs, not artefacts. | Confirmed | Low | §8.5 L1378–1430 | Give this new job `permissions: contents: read` and `persist-credentials: false` (cheap; doesn't reopen D-1). Exclude the `openbao` service from the uploaded log, or filter out `Root Token` and `Unseal Key` lines. Set `retention-days: 3`. Keep the job free of repository secrets, and add an invariant that it references no `secrets.*`. |
| SEC-F002-28 | **CI gate correctness.** If Turbo caches `test:integration`, a cache hit skips the TC-14 and TC-20 security scans. `ci/pre-install-gate-first` should also treat `actions/setup-node` with `cache: pnpm` as a pnpm invocation, because it runs `pnpm store path` before the gate. | Suspected | Low | §8.5 L1411, L1435; §2 L83 | Set `test:integration` to `cache: false` in `turbo.json`, with a `check-turbo-config` assertion. Extend the invariant, with a fixture, so it covers `setup-node` `cache: pnpm` and any `uses:` that shells out to a package manager. |
| SEC-F002-29 | **`.env` generator, Dockerfile and role bootstrap hygiene.** Masking misses derived forms (URL-encoded passwords in DSNs). A root build context without `.dockerignore` would bake the CI-generated `deploy/docker/dev/.env` into the image; the exact-value scan would catch it, but only after the fact. The filesystem scan misses image config and history (`ENV`, `ARG`). How `bootstrap-roles.sql` receives passwords is unstated (command-line `-v` leaks to shell history and the process list). | Suspected | Low | §8.2 L1319; §8.5 L1406–1420; §4.1 L806; T14 L1480 | The generator writes files `0600`, only `[A-Za-z0-9]{32,}` values, refuses paths outside `deploy/docker/dev/`, and never overwrites without `--force`. Add a `.dockerignore` that excludes `**/.env*`, `.git`, `deploy/docker/dev/` and `**/*.pem`. Build multi-stage with `pnpm deploy --prod`, pass no secret through `ARG` or `ENV`, and use BuildKit `--secret` if one is ever needed. The image scan also covers `docker image inspect` config and history. Role passwords come from OpenBao through a script over stdin, with `password_encryption=scram-sha-256`. |
| SEC-F002-30 | **Untrusted display strings.** `device_label` strips control characters but not Unicode bidi embedding, override and isolate characters (U+202A–U+202E, U+2066–U+2069) or zero-width characters, which enables spoofing in an RTL-capable console. `attempted_identifier` comes from an unverified JWT and can name any person. | Suspected | Low | §3.2.5 L335; §3.5 L636 | Strip those code points from `device_label` and from every client-supplied display field, but keep legitimate Arabic text and the RLM/ALM marks. Truncate `attempted_identifier` to 128, keep `identifier_verified:false`, and require the console (F-018) to render it as unverified. |
| SEC-F002-31 | **RLS is sound, but the `org_id` source and pool hygiene are unstated.** Transaction-local `set_config(...,true)` inside `withOrg` does not leak between pooled requests, and `current_org()` fails closed on unset or `''`. Where `withOrg`'s `orgId` comes from is not written down for unauthenticated routes and grants (authorize, callback, token, sign-in failures). Nothing prevents a future session-level `SET app.org_id`. | Suspected | Low | §4.1 L808; §2.1 L107 | Rule: `orgId` comes from the verified token's `tid`, or on unauthenticated routes from `config.org.id`. It never comes from a header, host, path or body. Add a test that `X-Org-Id` and a body `org_id` are ignored. Add a lint or grep check that bans `set_config('app.org_id', …, false)`, `SET app.` and `SET ROLE` in application code. Add a test that a query on the same pooled connection after `withOrg` errors. |
| SEC-F002-32 | **The tenant switch doesn't affect existing flow-A sessions,** and the precedence between config and `organization.settings` is undefined once F-018 writes settings. | Confirmed | Low | §3.2.5 L351–355; §3.8 L775 | Turning `device_code_enabled` off should revoke sessions with `flow=idp_device`, or at least flag them (a decision for the product owner). Define "config seeds, DB wins after first start", or the reverse, before F-018. |
| SEC-F002-33 | **JWKS timing checked: sound.** Worst case: replica poll 30 s + verifier cache 60 s + cooldown 5 s = 95 s, under the 120 s activation delay, so no token exists before verifiers can see its key. Retirement at `activated_at(next) + access_ttl + 5 min` covers user and service tokens. | Confirmed (no issue) | Info | §3.2.4 L315–322; §3.1 L219 | Serve JWKS from the `signing_key_version` rows (DB) so every replica publishes as soon as the row exists. Compute activation from the DB clock. Send `Cache-Control: public, max-age=60, must-revalidate`, and put no shared CDN in front with a longer TTL. |

## 4. Answers to the review checklist

1. **Device-code and exchange flow.**
   - Replay: SEC-F002-07 (consume-first, `uti` required).
   - Audience and issuer pinning are correct for Entra v2 (`aud` = client id, exact `iss` and `tid`, `azp` allow-list, `scp`). Also pin `alg` and `ver` (SEC-F002-19, -07).
   - Tenant switch: it is enforced server-side at the exchange grant; existing sessions are the gap (SEC-F002-32).
   - Loopback: the regex correctly allows only IP-literal loopback. RTS state, nonce and PKCE (both legs) are correct. Code interception by another local process is neutralised by PKCE, but remote code phishing is not (SEC-F002-04).
2. **Tokens.**
   - Transit custody is good but needs runtime flag monitoring and deny policies (SEC-F002-11).
   - JWKS timing is sound (SEC-F002-33).
   - Rotation and reuse detection are sound; the concurrent-loser semantics are not specified (SEC-F002-17).
   - The 60 s revocation bound holds with a 5 s poll; freshness semantics are in SEC-F002-18.
   - One audience per service is correct.
   - Clock skew: 30 s for Ralysa tokens and 60 s for IdP tokens is acceptable. Add the future-`iat` check (SEC-F002-18). The design uses `iat` ≤ 10 min instead of ADR-0010's `auth_time`. Entra v2 access tokens don't list `auth_time`, so record this as a documented interpretation.
3. **Group mapping.** Object IDs and fail-closed overage are correct in intent. Enforce the GUID format and never follow `_claim_sources` (SEC-F002-08). `accountEnabled` needs the deleted-user and revoke-sessions handling (SEC-F002-09). The Graph credential scope is wide and backed by a static secret (SEC-F002-10).
4. **Service identity (AD-1).**
   - Custody is correct: per-service non-exportable key, sign-only policy.
   - Replay is covered: `jti` for 120 s, `exp` ≤ 60 s, exact `aud`.
   - A compromised service cannot mint for another unless the OpenBao policies or Kubernetes bindings are wrong. Test them (SEC-F002-22).
   - It can, however, **write audit as anyone** (SEC-F002-03).
5. **Audit.**
   - Insert-only writer: correct, with one note. Do not "fix" `RETURNING` by granting `SELECT`; use the row count, or `SELECT` on `event_id` only if unavoidable.
   - Trigger: SEC-F002-25.
   - Sealer: SEC-F002-26.
   - Superuser and **migrator bypass**: SEC-F002-01 and -02 (High).
   - Client path: SEC-F002-14 and -15.
   - DoS: SEC-F002-16.
   - **OQ-D1: accept for Phase 0, with conditions.** Unprivileged `42501` attempts on `audit.*` come only from Ralysa's own roles, so each one signals compromise or a bug. Conditions: (a) `log_line_prefix` includes user, database, application and client; (b) Postgres logs are retained at least as long as audit and shipped off-host where a pipeline exists; (c) a log-based alert fires on SQLSTATE `42501` naming `audit.`; (d) `pgaudit` object auditing on `audit.*` where the platform offers it. F-011 moves these into the chain.
6. **RLS.** FORCE RLS on every table, a fail-closed `current_org()`, and transaction-local settings under pooling are all correct. The `org_id` source rule and guard tests are in SEC-F002-31.
7. **Secrets.** Dev-mode leakage: SEC-F002-12. The `.env` generator and Dockerfile: SEC-F002-29. Log scrubbing: SEC-F002-21. The DB stores only `vault_path` values, checked by the regex CHECK. That is good.
8. **Mock IdP.** Today only intent keeps it out of production. The enforcement is listed in SEC-F002-13, with SEC-F002-12 as the runtime backstop.
9. **CI integration job.** The pre-install gate order is correct: checkout, setup-node, gate, corepack. The job uses no repository secrets and generates throwaway credentials. Fix the artefact, permissions and cache items (SEC-F002-27, -28).

## 5. Required changes before G4

These are edits to `design.md`. Each is small and adds no new feature scope.

1. **SEC-F002-01:**
   - Introduce the `ralysa_audit_owner` `NOLOGIN` owner role and the separate audit-migration path.
   - Add the DBA-created DDL event trigger to `bootstrap-roles.sql`.
   - Correct the §4.5 residual text.
   - **Either** add Transit-signed chain heads every 60 s (`audit.audit_checkpoint`) to T06, **or** record the unanchored-chain residual as an explicit accepted risk with a named human owner (open question Q1).
2. **SEC-F002-02:** per-entry-point OpenBao policies and config. `serve` cannot read `db/migrator` or `db/audit_sealer`, and the sealer runs as its own process.
3. **SEC-F002-03:** per-service action allow-list on the service ingestion path, with reserved control-plane namespaces, added to §3.4.4, §3.8 `services[]` and TC-F-002-17.
4. **SEC-F002-07:** consume-first replay key, `uti` required, `alg` and `ver` pinned. Update §3.2.5 and TC-F-002-03.
5. **SEC-F002-08:** `z.uuid()` for group ids, GUID validation of claim values, and never dereferencing `_claim_sources`, in §3.8 and §6.3.
6. **SEC-F002-11:** runtime re-check of `exportable` and `allow_plaintext_backup`, explicit deny paths in §6.5, and an OpenBao audit device in non-dev environments.
7. **SEC-F002-12:** a single `env` source defaulting to `production`, plus the production guard list in §3.8.
8. **SEC-F002-13:** the enforcement for mock-IdP exclusion (dependency-cruiser, banned-deps closure, image assertion) added to T09 and T14.
9. **SEC-F002-14 and -15:** server-issued `session_id`, `final_seq` reconciliation, the client-path failure rule, the reserved `details` namespace and the size limits in §3.4.5.
10. **SEC-F002-04, -05, -06:**
    - record the IP at each flow-B leg and set the mismatch policy (open question Q2);
    - request the `ipaddr` optional claim for flow A, with a mismatch flag and alert;
    - `platform_admin` only on strong flows;
    - `require_mfa_claim` defaults to true in production once TC-28 confirms `amr`.

    With these, **OQ-D5 can be accepted.**

The remaining Low and Info items can be tracked as task-level acceptance items: SEC-F002-09, -10, -16 to -33. Add them to the Definition of Done of the relevant T-tasks, and re-check them in the Phase 6 security test. SEC-F002-09, -10 and -16 are Medium, and should be scheduled no later than T10 (Graph and sign-in) and T12 (audit endpoints).

**Open-question dispositions requested of this reviewer:**
- **OQ-D1:** accept with conditions (§4 item 5).
- **OQ-D2:** accept for Phase 0 with the SEC-F002-22 conditions. Revisit mesh mTLS with F-023.
- **OQ-D3 (poll-only):** acceptable from a security view. A 5 s poll meets the 60 s bound, provided the SEC-F002-18 freshness checks are in place.
- **OQ-D5:** accept only with SEC-F002-05 and -06.
- **OQ-D7:** prefer the service API. If direct insert is chosen, SEC-F002-23 is a precondition.

## 6. Open questions

| # | Question | Why it matters | Suggested owner |
|---|---|---|---|
| Q1 | Bring Transit-signed chain heads into F-002, or accept an unanchored Phase 0 chain (tamper-evident only against non-owner roles) until F-011? | Decides whether SEC-F002-01 is closed or accepted. Phase 0 holds synthetic identities only (PRD A-5), so acceptance is defensible if a human signs it. | Product owner + architect |
| Q2 | Flow B callback-IP ≠ redemption-IP: deny by default, or alert only? | Split-tunnel VPNs and proxies can cause false positives on a genuine loopback flow. | Architect + pilot IT |
| Q3 | Will the pilot tenant's admins consent to tenant-wide `User.Read.All` and `GroupMember.Read.All`, and can RTS use a certificate credential instead of a secret? | Banks often refuse wide Graph application permissions. This affects E-1 and SEC-F002-10. | Founder / tenant admin |
| Q4 | Does Entra's `ipaddr` in a device-flow access token carry the approving browser's IP or the polling client's IP? | SEC-F002-05 depends on it. Verify in TC-F-002-28. | Test engineer |
| Q5 | Are `amr` (and `acrs`) reliably present in v2 access tokens and ID tokens for the RTS app in the test tenant? | Needed to default `require_mfa_claim` to on and for the admin rule in SEC-F002-06. | Test engineer (TC-28) |
| Q6 | Which production deployments will run without Kubernetes (AppRole), and is response-wrapped secret-zero delivery acceptable there? | SEC-F002-22; affects F-023 packaging. | Architect |
| Q7 | Where do Postgres logs go in Phase 0 environments, and how long are they kept? | Condition for accepting OQ-D1. | Architect / ops |
| Q8 | When device code is disabled, are existing flow-A sessions revoked or left to expire? | SEC-F002-32; affects what customers see. | Product owner |

## 7. Compliance controls touched

Indicative, following `docs/architecture/security.md` §7. The Gulf control numbers there are marked "to verify" and carry that status here.

| Area | Findings | ISO/IEC 27001:2022 Annex A | SOC 2 (CC) | Gulf (to verify) |
|---|---|---|---|---|
| Identity, authentication, tokens | -04 to -09, -17 to -20, -32, -33 | 5.15, 5.16, 5.17, 5.18, 8.5 | CC6.1, CC6.2, CC6.3 | NCA ECC 2-2 (IAM); SAMA CSF 3.3.5; Qatar NIA Access Control / Identity & Authentication |
| Privileged access, admin hardening | -01, -02, -06, -10 | 8.2, 8.3, 5.18 | CC6.1, CC6.3 | NCA ECC 2-2; SAMA CSF 3.3.5 |
| Secrets and cryptography | -02, -10, -11, -12, -22, -29 | 8.24, 5.17 | CC6.1, CC6.7 | NCA ECC 2-8; SAMA CSF 3.3.9; QCB Cloud Regulation (retain access to KMS logs), which the OpenBao audit device in -11 supports |
| Audit logging and evidence integrity | -01, -03, -14, -15, -16, -23 to -26 | 8.15, 8.16, 5.28, 5.33 | CC7.2, CC7.3, CC4.1 | NCA ECC 2-12; SAMA CSF 3.3.14; Qatar NIA Logging & Security Monitoring; REQ-070 evidence pack |
| Clock synchronisation (token skew, audit `ts`) | -18 | 8.17 | CC7.2 | NCA ECC 2-12 |
| Separation of dev, test and production | -12, -13, -27, -29 | 8.31, 8.9 | CC8.1, CC6.8 | NCA ECC 2-3 / 2-10 (to verify); SAMA CSF 3.3.7 |
| Secure development and change (migrations, CI) | -01, -27, -28 | 8.25, 8.28, 8.32 | CC8.1 | SAMA CSF 3.3.7 Change Management |
| Tenancy isolation (RLS) | -31 | 8.3, 5.23 | CC6.1 | NCA CCC tenant controls |
| Availability of fail-closed controls | -16, -24 | 8.14, 5.29 | A1.2, CC7.5 | CBUAE AI Guidance Note (ability to stop the service; kill-switch path) |

## Approval (G4)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |

## T16-1 deviation — security review (2026-09-25)

**Scope.** Decision T16-1 (implementation-notes.md): the sealer process holds the insert-only `ralysa_audit_writer` DB credential (`SealerConfig.db_credentials.audit_writer`, OpenBao policy `ralysa-cp-sealer` → `read kv/.../db/audit_writer`) so it can write `secret.custody_violation`. This departs from design §4.6 and §6.5 and from SEC-F002-02 / SEC-F002-26 ("sealer reads `audit_sealer` only"). Also in scope: other T16 risks (custody irreversibility and recovery, the audit-verify trust model). Review of code at `main` 9213344. Read-only; nothing was run against any live system.

**Verdict: ACCEPT-WITH-CONDITIONS** (Phase 0, dev/CI stack only). The remediation (audit/0002 SECURITY DEFINER function, §B) is **required before the F-002 G6 security test and before any deployment outside dev/CI, whichever comes first**. Tracked as SEC-F002-34.

### A. Is the deviation acceptable for Phase 0?

**Verified facts (Confirmed):**
- The writer role has column-level `INSERT` on `audit.audit_event` only. It has no SELECT, UPDATE, DELETE or TRUNCATE, and no rights on seals or checkpoints (`services/control-plane/src/db/migrations/audit/0001_audit_store.ts:143`).
- In the sealer, the writer pool is used only by the checkpoint signer's custody reporter (`services/control-plane/src/main.ts:122-141`, `services/control-plane/src/audit/sealer/checkpoint.ts:52-71`).
- `serve`, `migrate` and `migrate --audit` already hold the same credential (`services/control-plane/src/config/schema.ts:74,80`; `tooling/dev-stack/src/bootstrap-vault.ts:94,110,111`).
- The policy test asserts the new grant (`tooling/dev-stack/test/integration/policies.int.ts:64`).

**What changes if the sealer is compromised.** Before T16-1, a compromised sealer could delay sealing or skip events (completeness), write chain seals over existing events, and sign checkpoints over whatever chain head it chose. It could **not** make events up. With the writer credential, it can insert events with any writer column (for example `actor_type='user'`, any `actor_user_id`, `attestation='server'`, any `action`), seal them, and immediately sign a checkpoint over them. A forged event and a valid-looking signed anchor now come from **one** principal. The writer/sealer split is exactly the separation of duties that SEC-F002-02 and -26 exist to keep. The marginal capability is moderate: a compromised `serve` can already insert forged events, and an honest sealer would seal them. But one process now covers the whole insert → seal → attest path, and the sealer holds a Transit sign right plus a DB password it never needed before.

**Conditions for acceptance (all required):**
1. **No non-dev deployment** (pilot, staging with real identities, customer, production) while `SealerConfig.db_credentials` contains `audit_writer`. If audit/0002 hasn't landed when F-002 reaches G6, add a production refusal to `commonProductionRefusals`: a `sealer` config with `db_credentials.audit_writer` must fail to load when `env` is `production`. That guard is defence in depth, not a replacement for the remediation.
2. **Record the deviation in the design.** In design.md §4.1 (role table), §4.6 and §6.5, note SEC-F002-02 / -26 as "met except deviation T16-1, remediation SEC-F002-34". Log the self-decision under the standing authorization, as CLAUDE.md requires.
3. **Keep the writer's use narrow.** The sealer's writer pool stays `max: 1` and is passed only to `createCheckpointSigner`. Add a unit or grep test that no other sealer module imports or receives it.
4. **Fix the SEC-F002-39 retry defect** (below) in the same change as §B, or earlier.

### B. Remediation: `audit/0002_custody_violation_fn`

This is the right remediation. A narrowly scoped SECURITY DEFINER function turns "can insert any event" into "can record one fixed fact about one key". It follows the existing `audit.reject_modify_stmt()` pattern (`0001_audit_store.ts:165-188`).

| # | Requirement |
|---|---|
| B1 | **New migration** `services/control-plane/src/db/migrations/audit/0002_custody_violation_fn.ts`, applied through the break-glass `migrate --audit` path (runs as `ralysa_audit_migrator` → `SET ROLE ralysa_audit_owner`, so the function is owned by the NOLOGIN owner). `0001` is untouched (`check-migrations-immutable`). Add it to `migrations.lock.json` and the generated checksums. The DDL event trigger will write `audit.schema_changed` for it (expected evidence). |
| B2 | **Signature:** `audit.record_custody_violation(p_key text, p_exportable boolean, p_allow_plaintext_backup boolean) RETURNS boolean` (true = inserted, false = suppressed). Two booleans let both flags be recorded at once (SEC-F002-40). |
| B3 | **Declaration:** `LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp`, every object schema-qualified (`audit.audit_event`, `audit.current_org()`, `pg_catalog.gen_random_uuid()`). `pg_temp` explicitly **last**. No dynamic SQL (`EXECUTE`). |
| B4 | **Input validation:** raise `22023` when `p_key IS NULL` or `p_key <> 'ralysa-audit-checkpoint'` (hard allow-list; RTS keys are recorded by `serve` through its own writer). Also raise `22023` when both booleans are false or either is NULL. No free text and no jsonb parameter. |
| B5 | **Fixed fields**, nothing from the caller except B4's inputs: `action='secret.custody_violation'`, `actor_type='system'`, `actor_service='sealer'`, `actor_user_id` and `actor_idp_subject` NULL; `outcome='error'`, `reason_code` = `'exportable'` if `p_exportable` else `'allow_plaintext_backup'`; `source='control-plane'`, `attestation='server'`; `trace_id = replace(gen_random_uuid()::text,'-','')`; `event_id = gen_random_uuid()` (document that DB-minted events are v4); `details = jsonb_build_object('key', p_key, 'exportable', p_exportable, 'allow_plaintext_backup', p_allow_plaintext_backup, 'flag', <reason_code>, 'db_role', session_user::text, 'via', 'audit.record_custody_violation')`. |
| B6 | **Org attribution:** `org_id := audit.current_org()` (caller's transaction-local `app.org_id` from `withOrg(config.org.id)`; fails closed when unset). No `org_id` parameter. FORCE RLS applies, so the insert must satisfy the policy under that setting; the function must not change `app.org_id`. |
| B7 | **Flood bound and idempotency:** take `pg_advisory_xact_lock(hashtext('custody:' \|\| org \|\| ':' \|\| p_key))` first; then return false without inserting if an event with the same `org_id`, `action`, `details->>'key'` and the same flag pair exists with `ts > clock_timestamp() - interval '5 minutes'` (covered by `audit_event_org_action_ts`). At most 12 events per hour per (org, key, flag pair). This lets the sealer retry every poll until recorded (SEC-F002-39) without duplicates. |
| B8 | **Grants:** `REVOKE ALL ON FUNCTION audit.record_custody_violation(text, boolean, boolean) FROM PUBLIC;` and `GRANT EXECUTE ... TO ralysa_audit_sealer;` only. |
| B9 | **Code and config:** remove `writerPool`/`createAuditWriter` from `sealerCommand` (`main.ts:122-141,163`); the signer calls `select audit.record_custody_violation($1,$2,$3)` inside `withOrg` on the **sealer** pool; `SealerConfig.db_credentials` back to `z.strictObject({ audit_sealer: KvPath })` (`schema.ts:95`); remove `dbRead(ctx,'audit_writer')` from `ralysa-cp-sealer` (`bootstrap-vault.ts:106`); remove `audit_writer` from `deploy/docker/dev/control-plane.sealer.dev.yaml`; update design §4.1 row `ralysa_audit_sealer` to "+ EXECUTE on `audit.record_custody_violation`". |

**Required tests:**

| # | Test |
|---|---|
| T1 | `ralysa_audit_sealer` calling it inserts exactly one row with every B5 field as specified, attributed to `current_org()`. |
| T2 | Invalid key (`ralysa-rts-signing`, `''`, NULL, a 200-character string, `x'; drop …`), both flags false, or NULL flags → `22023`, no row. |
| T3 | Two calls within 5 minutes → one row, second returns false. Different flag pair → new row. Two concurrent sessions → one row. |
| T4 | `ralysa_audit_writer`, `ralysa_audit_reader`, `ralysa_cp_app`, `ralysa_migrator` → `42501` on EXECUTE; `has_function_privilege('public', …, 'EXECUTE')` is false. |
| T5 | Without `app.org_id` → error, no row. Under `withOrg(A)`, row `org_id = A`. |
| T6 | `pg_proc`: `prosecdef = true`, `proconfig` contains `search_path=pg_catalog, pg_temp`, owner `ralysa_audit_owner`. |
| T7 | Sealer still cannot INSERT into `audit.audit_event` directly (`42501`). |
| T8 | Policy test: `['ralysa-cp-sealer','read',db('audit_writer'),DENIED]` (`policies.int.ts:64` flips). |
| T9 | Config test: a `sealer` config with `audit_writer` fails validation. |
| T10 | TC-F-002-33 integration (flip `exportable` at runtime) still gives exactly one `secret.custody_violation` with `actor.service=sealer`. |
| T11 | Applying audit/0002 writes one `audit.schema_changed` event. |

### C. Other T16 findings

| ID | Finding | Status | Severity | Evidence | Recommendation |
|---|---|---|---|---|---|
| SEC-F002-34 | Sealer holds the insert-only writer credential (deviation T16-1); see §A. | Confirmed | Medium (dev-only: Low) | `main.ts:122-141`; `schema.ts:95`; `bootstrap-vault.ts:106` | §B, before G6 or any non-dev deployment. |
| SEC-F002-35 | **Custody violation cannot be undone and there is no recovery path.** In Vault, `exportable` and `allow_plaintext_backup` "cannot be disabled" once set (Vault Transit API docs); OpenBao is a fork with the same API. The "signing resumes when the flags clear" branch cannot happen on a real key (only the in-memory double clears flags, `checkpoint.test.ts:86-92`). No replacement path: the config pins the key name as a literal (`schema.ts:90,102`); `audit_checkpoint` stores only `key_version` with no key name or fingerprint (`0001_audit_store.ts:126-135`); `audit-verify` refuses to verify at all when the key is flagged (`main.ts:185-197`). One flag flip permanently stops checkpointing and makes every past checkpoint unverifiable. | Confirmed | Medium | as cited | (a) Integration test confirming the flag cannot be cleared on OpenBao; remove or document the "restored" branch as reachable only after key recreation (SEC-F002-37); unit test asserts a violation is terminal. (b) Recovery by key epoch: `checkpoint_key` matching `^ralysa-audit-checkpoint(-[0-9]{1,4})?$`; a new audit migration adds `key_id` (RFC 7638 JWK thumbprint) or `key_name` to `audit_checkpoint`, bound into a new checkpoint payload version; `AuditVerifyConfig.retired_checkpoint_keys: [{ name, pinned_jwk_thumbprints[], compromised_at? }]`. (c) When flagged, `audit-verify` still recomputes the chain and reports `key_custody_violated` instead of stopping; checkpoints before `compromised_at` count only with matching off-host log lines, later ones are invalid. (d) Runbook "checkpoint key compromised". Before F-011 WORM, or ADR-level if it changes ADR-0021. |
| SEC-F002-36 | **audit-verify's trust anchor is the live OpenBao key** (read at run time, nothing pinned). An OpenBao admin who is also audit owner/superuser can rewrite, recompute and re-sign; detection then depends only on the checkpoint log. | Confirmed (design residual) | Medium | `main.ts:185-188`; `audit-verify.ts:104-133` | Log each key version's JWK thumbprint at sealer start and in each `audit_checkpoint` line; `audit-verify` takes pinned thumbprints and flags mismatches; F-011 WORM stores thumbprints; in non-dev, separate OpenBao admin from DB superuser/audit owner and enable the OpenBao audit device (SEC-F002-11). |
| SEC-F002-37 | **Key recreated under the same name → signing resumes silently** (info log only, new material from version 1). | Suspected | Low | `checkpoint.ts:76-83` | Remember each version's thumbprint from first `describe`; a changed thumbprint or decreasing `latest_version` counts as a custody violation. |
| SEC-F002-38 | **Without the log, tail truncation is invisible; the log is not off-host yet.** | Confirmed (design residual) | Low (Phase 0) | `audit-verify.ts:170-185`; design §4.7, §4.5 | `audit-verify` prints `anchor: none` with a distinct exit code when run without the log and requires the flag outside dev/test; evidence packs (REQ-070) include the shipped log; note in the runbook that forged log lines only cause false `checkpoint_missing`. |
| SEC-F002-39 | **Custody event written once, never retried** (`violation` set before `report()`, which swallows failures; no spool on the sealer's writer). | Confirmed | Low | `checkpoint.ts:94-97,65-70`; `main.ts:140` | Track `recorded` separately and retry every poll until recorded (safe with §B7). |
| SEC-F002-40 | **Only one flag recorded** when both are set; a later second flag writes nothing. | Confirmed | Low | `checkpoint.ts:93-97` | Record both booleans (§B2/B5); dedupe on the flag pair. |
| SEC-F002-41 | `0001` SECURITY DEFINER functions use `search_path = pg_catalog, audit` without trailing `pg_temp`; all references schema-qualified, so not exploitable. | Confirmed (no issue) | Info | `0001_audit_store.ts:153,166,192` | New functions use `pg_catalog, pg_temp`. |

**The audit-verify design itself is sound (Confirmed).** It compares checkpoints with the chain recomputed from events, not the stored seals (T16-3), catching an owner who rewrites an event and recomputes later seals at the first covering checkpoint (`audit-verify.ts:93-139`; TC-F-002-29). The payload binds org, shard, seq, hash and ts; `checkpoint_ts` is signed. Residual trust assumptions: SEC-F002-36 and -38.

### D. Compliance controls touched

| Area | Findings | ISO/IEC 27001:2022 Annex A | SOC 2 | Gulf (to verify) |
|---|---|---|---|---|
| Segregation of duties / privileged access | -34, -36 | 5.3, 8.2, 8.3 | CC6.1, CC6.3 | NCA ECC 2-2; SAMA CSF 3.3.5 |
| Audit integrity and completeness | -34, -38, -39, -40 | 8.15, 5.28, 5.33 | CC7.2, CC7.3, CC4.1 | NCA ECC 2-12; SAMA CSF 3.3.14; Qatar NIA Logging & Security Monitoring |
| Cryptographic key management | -35, -36, -37 | 8.24 | CC6.1, CC6.7 | NCA ECC 2-8; SAMA CSF 3.3.9; QCB Cloud Regulation (KMS logs) |
| Secure development / change | -34 (audit/0002), -41 | 8.25, 8.28, 8.32 | CC8.1 | SAMA CSF 3.3.7 |

### E. What each gate needs

- **Now (Phase 0, dev only):** conditions A1–A4.
- **Before the F-002 G6 security test:** SEC-F002-34 remediated per §B with tests T1–T11 green; SEC-F002-39 and -40 fixed; SEC-F002-35 (a) done; SEC-F002-35 (b)–(d) and SEC-F002-36 either done or accepted in writing by a named human owner as an F-011 prerequisite.
- **Before any non-dev deployment:** all of the above; SEC-F002-38 (require `--log-checkpoints` outside dev and ship the log off-host); OpenBao audit device enabled (SEC-F002-11).

Reviewer: security-reviewer agent, 2026-09-25. Agent review only; the G4–G8 approval rows are not changed by this section.

Source: Vault Transit API — `exportable` and `allow_plaintext_backup` "cannot be disabled" once set: https://developer.hashicorp.com/vault/api-docs/secret/transit

## Phase 6 security review (2026-09-26)

> Phase 6 · Owner: security-reviewer · Reviewed: `main` at `f795d6b` (CI run 36256916071, green). Method: read-only review of `services/control-plane`, `packages/auth`, `packages/secrets`, `packages/protocol`, `tooling/dev-stack` (policies, role bootstrap), `deploy/docker/`, `.dockerignore`, `.github/workflows/ci.yml`, `turbo.json`, plus design.md §3 and §6, status.md, implementation-notes.md and test-report.md. Tests are cited from source; they were not re-run for this review (CI on `f795d6b` is the evidence). Nothing was run against a live system. The only external lookup was the GitHub Advisory Database, for the direct runtime dependencies.
> Labels as in §3: **Confirmed** = shown by the code; **Suspected** = depends on deployment, tenant configuration or behaviour not exercised here.
> Numbering: SEC-F002-39 to -41 already exist (T16-1 review), so new findings start at **SEC-F002-42**.

### P6-1. Threat-model delta since Phase 4

The Phase 4 assets, trust boundaries and entry points (§1) still hold. Implementation added the following:
- **Assets:**
  - the audit spool volume (`/var/lib/ralysa/audit-spool`: denials with `client_ip` and HMACs);
  - the sealer's `audit_checkpoint` log lines (the off-host anchor);
  - `cp.idp_group.display_name` and `cp.app_user.display_name`/`email` (IdP- and Graph-supplied text);
  - the `Principal` contract that F-003 and F-004 policy enforcement points (PEPs) will authorize on.
- **Entry points:**
  - `GET /healthz` and `GET /readyz` (unauthenticated, not rate-limited);
  - `RALYSA_CFG__*` environment overrides (a second configuration channel);
  - `sys/seal-status` (the unauthenticated OpenBao probe used by the production guards).
- **Boundary:** node or volume to the `serve` process (spool files are replayed as server-attested events).

### P6-2. Status of SEC-F002-01 to -41

"Verified" means the control is in the code at the cited lines and a test exercises it. All paths are relative to the repository root; `cp/` = `services/control-plane/`.

| ID | Sev. | Status | Evidence (code) | Evidence (test) / note |
|---|---|---|---|---|
| -01 (required) | High | **Implemented, verified**: (a) NOLOGIN `ralysa_audit_owner`, migrator not a member; (b) superuser-owned DDL event trigger; (c) Transit-signed chain heads + `audit-verify`; (d) residual stated | `cp/src/db/sql/bootstrap-roles.sql:45-59, 72-157`; `cp/src/db/migrations/audit/0001_audit_store.ts:148-226`; `cp/src/audit/sealer/checkpoint.ts:171-247`; `cp/src/audit/verify/audit-verify.ts:70-212` | `cp/test/integration/db.int.ts:133, 345, 371`; `checkpoint.int.ts:186, 251`. Residual trust anchor: -36, -38 (open) |
| -02 (required) | High | **Implemented, verified** | per-entry-point strict schemas `cp/src/config/schema.ts:74-107, 172`; policies `tooling/dev-stack/src/bootstrap-vault.ts:89-115` | `cp/test/config.test.ts:66`; `config-serve.test.ts:11`; `tooling/dev-stack/test/integration/policies.int.ts` |
| -03 (required) | Med | **Implemented, verified** | `cp/src/audit/action-allowlist.ts:29-40`; `routes/service-events.ts:115-122`; `packages/protocol/src/audit/actions.ts:33-54`; config refusal `schema.ts:215-224` | `cp/test/audit-ingest.test.ts:31`; `integration/audit-routes.int.ts:423`; `config-serve.test.ts:86` |
| -04 (required) | Med | **Implemented, verified** for (a) callback-vs-redemption IP (deny by default), (b) `__Host-` binding cookie, (d) tests. (c) is an F-005 contract | `cp/src/auth/flow-b.ts:145-148, 202-207`; `grants/authorization-code.ts:111-151` | `cp/test/flow-b-routes.test.ts`; `integration/sign-in-browser.int.ts`. Residual: an attacker behind the victim's own egress IP passes the IP check (insider on the same NAT) |
| -05 (required) | Med | **Partial**: `ipaddr` recorded, mismatch flagged, counted and logged, never denied | `cp/src/auth/sign-in.ts:192-200`; `grants/token-exchange.ts:120-126` | `sign-in-exits.test.ts:451`. Deny waits for Q4 (TC-F-002-28 blocked on E-1). Counters go to `noopMetrics`, so the alert keys on the log line |
| -06 (required) | Med | **Implemented, verified** for (a) strong-flow admin rule, (c) `audit.query` committed first. (b) defaults to true in production under EXC-F002-01 | `cp/src/auth/identity-mapping.ts:45-85`; `config/schema.ts:238-241`; `config/guards.ts:43-47`; `audit/routes/query.ts:157-165` | `identity-mapping.test.ts`; `audit-routes.int.ts`. **But PEPs never see the session role: see new SEC-F002-42** |
| -07 (required) | Med | **Implemented, verified** (consume-first, `uti` required, `alg`/`typ`/`ver` pinned, RTS issuer refused) | `cp/src/auth/idp/entra-token-validator.ts:159-169, 194-214`; `sign-in-store.ts:301-315`; `grants/token-exchange.ts:105-108` | `entra-token-validator.test.ts:122, 168` |
| -08 (required) | Med | **Implemented, verified** | `z.uuid()` group ids `schema.ts:136-137`; GUID-only claim `entra-token-validator.ts:108-118`; Graph always authoritative `graph-directory.ts:209-223`; discovery origin pin `idp/metadata.ts:70-83` | `entra-token-validator.test.ts:207`; `graph-directory.test.ts`; `sign-in.int.ts:792` |
| -09 | Med | **Implemented, verified** | `graph-directory.ts:187-199, 224-256`; `grants/refresh-token.ts:206-224`; `sign-in.ts:263-291` | `graph-directory.test.ts:176` |
| -10 | Med | **Open (founder decision, E-1/Q3)**. Interim: ≤ 180-day secret with an expiry register | `cp/README.md:249-250` runbook | Not G6-blocking (the mock IdP is the only IdP). Decide before E-1 consent |
| -11 (required) | Med | **Partial**. Runtime re-check of both flags on the RTS key and the checkpoint key and the explicit denies are **verified**. **The OpenBao audit device is not in any deploy artefact** | `cp/src/auth/tokens/signing-keys.ts:320-356`; `audit/sealer/checkpoint.ts:104-145`; `packages/secrets/src/openbao/transit.ts:41-57`; `bootstrap-vault.ts:60-71` | `packages/secrets/test/openbao.test.ts:338`; `checkpoint.int.ts`. Audit device required before any non-dev deployment |
| -12 (required) | Med | **Implemented, verified**, with gaps (new **SEC-F002-45**) | unset env = production `schema.ts:14`; `guards.ts:5-75`; protected overrides `config/load.ts:36-51`; OpenBao storage refusal at every entry point `commands.ts:55-58`, `serve.ts:79-80, 259-260` (#41/#42) | `entry-point-guards.test.ts` (TC-F-002-34); `config.test.ts:40, 135, 147` |
| -13 (required) | Med | **Implemented, verified** | `pnpm deploy --prod` `deploy/docker/control-plane.Dockerfile:35-48`; image scan `.github/workflows/ci.yml:256-261`; per-run mock keys and loopback bearer (T09) | `tooling/dev-stack/test/mock-idp.test.ts:182, 684`; CI `ci/integration-image-scan` |
| -14 (required) | Med | **Implemented, verified** | server-issued sessions, 20 open per `sid`, `final_seq`, gaps `cp/src/audit/routes/client-events.ts:176-211, 343-354`; sweep `audit/client-sweep.ts` | `audit-routes.int.ts:865` |
| -15 (required) | Med | **Implemented, verified** on the client path | `client-events.ts:129, 330-333`; `writer.ts:94-96` | `packages/protocol/test/audit.test.ts:148`. The service path isn't covered: new **SEC-F002-50** |
| -16 | Med | **Implemented** per design, with gaps (new **SEC-F002-43**, **-48**) | `cp/src/http/rate-limits.ts`; `audit/rejections.ts`; `auth/routes/sign-in-failures.ts` | `audit-rejections.test.ts`; `app.test.ts:133`; `gateway.int.ts:281` |
| -17 | Low | **Implemented**: the loser of a race is treated as reuse | `grants/refresh-token.ts:266-297`; single-flight in `packages/auth/src/client/token-manager.ts` | `sessions.int.ts:509`; `token-manager.test.ts`. One-refresher contract on F-003/F-005 |
| -18 | Low | **Implemented, verified** (a)–(e) | `packages/auth/src/verify/revocation-feed.ts:131-156, 177-185`; window `packages/protocol/src/control-plane/governance.ts:37`; DB clock + 30 s `cp/src/auth/sessions.ts:193`; control plane reads DB `auth/verifier.ts:38-76`; future `iat` `access-token-verifier.ts:216-219` | `revocation-feed.test.ts`; `sessions.int.ts:421, 465, 604` |
| -19 | Low | **Implemented, verified** | `access-token-verifier.ts:191-198`; `protocol/src/auth/claims.ts:20-29` | `access-token-verifier.test.ts`; `protocol/test/auth.test.ts` |
| -20 | Low | **Implemented, verified** | `sessions.ts:241-291`; `sign-in-store.ts:377-407` | `sessions.int.ts:533` |
| -21 | Low | **Implemented, verified** | `cp/src/app.ts:47`; `http/logging.ts:12-40, 91-143` | `logging.test.ts`; `app.test.ts:162`; `scans.int.ts:369` |
| -22 | Low | **Partial**. AppRole production opt-in and non-retired service key versions are verified. Kubernetes role bindings exist only as a template | `packages/secrets/src/openbao/auth.ts:18-30`; `grants/client-credentials.ts:59-90`; `bootstrap-vault.ts:157-197` | `bootstrap.test.ts:203`; `service-key-cache.test.ts`. Rendering and binding is F-023 |
| -23 | Low | **Closed (N/A)**: OQ-D7 resolved to the service API; no service holds a DB writer role | `service-events.ts:1-3` | — |
| -24 | Low | **Implemented**, with gaps (new **SEC-F002-46**, which covers #45) | `cp/src/audit/spool.ts`; `schema.ts:164-170` | `audit-spool.test.ts`; `audit.int.ts:144` |
| -25 | Low | **Implemented, verified** | `0001_audit_store.ts:148-226` (ALWAYS triggers, one event per statement, org restored) | `db.int.ts:162` |
| -26 | Low | **Implemented, verified** | `pg_try_advisory_xact_lock` in `audit/sealer/sealer.ts:53-57`; sealer is its own process `commands.ts:116-168` | `audit.int.ts:251` |
| -27 | Low | **Implemented, verified** (`contents: read`, `persist-credentials: false`, no secrets, Postgres-only logs, 3-day retention) | `ci.yml:210-277`; `soak.yml:29-30` | `tooling/repo-scripts/src/check-ci-invariants.ts:152-208` |
| -28 | Low | **Implemented, verified** | `turbo.json:33-37` (`cache: false`) | `check-ci-invariants.ts:119, 131` |
| -29 | Low | **Implemented, verified** | Dockerfile (multi-stage, digest-pinned, non-root, npm/corepack removed); `.dockerignore`; SCRAM over stdin | `env.test.ts:50`; `bootstrap.test.ts:51`; image scan |
| -30 | Low | **Implemented** for client-supplied strings. **IdP/Graph-supplied strings are not covered** (new **SEC-F002-47**) | `cp/src/auth/display-text.ts:10-28`; `client-events.ts:101-113` | `identity-mapping.test.ts:90`; `sign-in-exits.test.ts:487` |
| -31 | Low | **Implemented, verified** | `cp/src/db/kysely.ts:26-40`; `http/request-context.ts:33-48` | `app.test.ts:222` (X-Org-Id ignored); `lint-config.test.ts:15` |
| -32 | Low | **Implemented** (at start; there is no config reload) | `cp/src/serve.ts:109-113`; `auth/device-code-switch.ts` | `sign-in.int.ts:498` |
| -33 | Info | **Verified** | JWKS from DB rows `signing-keys.ts:473-486` | `app.test.ts:77` |
| -34 | Med | **Remediated, verified** (audit/0002; the sealer holds no writer credential) | `commands.ts:116-143`; `schema.ts:91-99`; `0002_custody_violation_fn.ts:23-24, 71` | `custody-fn.int.ts` T1–T11; `policies.int.ts:64` |
| -35 (a) | Med | **Implemented, verified** (violation is terminal, flags can't be cleared) | `checkpoint.ts:72-81, 104-115` | `checkpoint.test.ts:88`; `checkpoint.int.ts:326` |
| **-35 (b)–(d)** | Med | Was: **Open. Blocks G6 unless accepted in writing** (§P6-7). Now: **Accepted for dev and CI only (P6-8); blocks F-011 or any non-dev deployment.** | no key id in `audit_checkpoint` (`0001_audit_store.ts:126-135`); literal key `schema.ts:93, 105`; `audit-verify` stops on a flagged key `commands.ts:186-198`; interim runbook only (`cp/README.md:814-840`) | — |
| **-36** | Med | Was: **Open. Blocks G6 unless accepted in writing.** Now: **Accepted for dev and CI only (P6-8); blocks F-011 or any non-dev deployment.** | `audit-verify` trusts the live key `commands.ts:186-188`; no thumbprint in `sealer_started` or checkpoint lines `commands.ts:144-148`, `checkpoint.ts:242` | — |
| **-37** | Low | Was: **Partial. Blocks G6 (with -36) unless accepted in writing.** Now: **Accepted for dev and CI only (P6-8); blocks F-011 or any non-dev deployment.** In-process: stays stopped. Across a restart, a checkpoint key recreated under the same name signs again (no stored thumbprint). The RTS key does detect this across restarts through DB rows | `checkpoint.ts:107-115`; RTS: `signing-keys.ts:345-355` | `serve.int.ts:271` (RTS) |
| **-38** | Low | **Open. Blocks any non-dev deployment** (not G6). Without `--log-checkpoints`, `audit-verify` exits 0 with no `anchor: none` | `commands.ts:212-228`; `audit-verify.ts:185-200` | — |
| -39 | Low | **Fixed, verified** (retried until the DB confirms) | `checkpoint.ts:89-101` | `checkpoint.test.ts:103` |
| -40 | Low | **Fixed, verified** (both flags recorded) | `checkpoint.ts:128-142` | `checkpoint.test.ts:72` |
| -41 | Info | **Closed**: new functions use `pg_catalog, pg_temp` | `0002_custody_violation_fn.ts:23-24` | — |

### P6-3. Fresh pass: areas found sound

- **Token verification (`packages/auth`).**
  - Checks that are correct: compact-JWS shape; `alg` = ES256 only; `typ` = `at+jwt`; forbidden JOSE headers; `kid` derived from config; single string `aud`; `iss` exact; `tid` pinned to the deployment org; 30 s skew; future `iat` rejected; claim schema; `token_use`.
  - The JWKS fetch doesn't follow redirects. A key-set fault answers 503; it is never recorded as a token rejection.
  - Service tokens need a registered `client_id`.
  - Revocation: the feed counts as confirmed only when fresh and with a non-decreasing epoch; the window (65 min) covers the maximum configurable access TTL; the G-1 60 s bound holds. The control plane reads revocation state from the database and requires `session.user_id = sub`.
- **Flow A.**
  - Header, signature (RS256 against the pinned tenant's keys), then `iss`, `tid`, `ver`, `aud`, `azp` and `scp`.
  - `iat` must be ≤ 10 min old, and `uti` is burned in its own committed transaction before anything else can fail.
  - The device-code switch is enforced server-side, and the replay key outlives the token.
- **Flow B.**
  - RTS→IdP leg: 32-byte `state`/`nonce`/verifier, PKCE S256.
  - Browser binding: an `HttpOnly`, `SameSite=Lax`, per-flow `__Host-` cookie.
  - The authorization request is consumed once (`DELETE … RETURNING`).
  - The code lives 60 s and is bound to client, exact redirect URI and challenge. A wrong verifier doesn't consume it; a tombstone makes reuse revoke the session. The redemption IP must match the callback IP.
  - **No open redirect:** the redirect URI must be an IP-literal loopback with a valid port range (`protocol/src/auth/oauth.ts:29-43`), and a bad client or redirect gets a plain-text 400 with no redirect.
  - IPv4-mapped addresses are normalised (`http/ip.ts`). Login CSRF (injecting a code into a victim's CLI) is prevented by PKCE.
- **Refresh.**
  - Rotation is one guarded UPDATE, and reuse revokes the family.
  - Every refresh re-checks the user at Graph, and removal from the admin group drops `platform_admin` from the session.
  - Signing happens before the old token is consumed, so a signing failure leaves the token retryable.
- **Tenancy.**
  - Every query goes through `withOrg` with a transaction-local `app.org_id`, on tables with FORCE RLS.
  - The org comes from config or the verified token only. Rejection aggregation uses the config org, never the rejected token's `tid`.
- **Audit.**
  - The writer can only INSERT, with a column grant. Row and statement triggers on every table are set ALWAYS.
  - Seals are written under an advisory transaction lock, with the primary key as fork guard. Checkpoints are signed through Transit.
  - `audit-verify` recomputes the chain from the events, not the stored seals.
  - Rejection aggregation is bounded (600 events per window per instance plus summaries).
  - The client path fails closed (503, `ack=false`). The kill-switch refusal is stored as `tool.call.denied`. Only v7 event ids are accepted from outside, so derived ids can't be pre-empted (R35-1).
- **Secrets.**
  - The DB holds KV paths only, and config fields are KV paths. Transit keys are non-exportable, and signing uses an explicit version.
  - Log redaction plus scrubbing on objects, messages and the serialized line. `disableRequestLogging`, and requests are logged by route template only.
  - The image is scanned: filesystem, `inspect` config and history, and exact values.
  - **In-memory OpenBao refusal (#41/#42):** every entry point (`serve`, `bootstrap-org`, `migrate`, `migrate --audit`, `sealer`, `audit-verify`) refuses in-memory, sealed or unreachable OpenBao in production before it opens a DB pool (`commands.ts:55-58`, `serve.ts:79-80, 259-260`; `entry-point-guards.test.ts`). Residual: the check runs at start only, and it relies on `sys/seal-status.storage_type`, which is acceptable.
- **Input validation.**
  - Strict zod schemas on every route. The form parser refuses repeated parameters and caps bodies at 16 KB; JSON bodies are capped at 256 KB. Client events are limited to 4 KB each and must be I-JSON.
  - Fastify's JSON parser has prototype-poisoning protection on by default, and no CORS is enabled.
  - **SSRF:** `graph_base_url` and `issuer` are pinned in production (the issuer can't be overridden). Every discovery endpoint must be on the issuer's origin. `_claim_sources` is never followed. `vault.addr` is the exception: see SEC-F002-45 and -49.
  - **Log injection:** N/A. Logs are structured JSON, no raw URL or body is logged, and display strings are sanitised.
- **Supply chain.**
  - Direct runtime dependencies (fastify 5.12.5, jose 6.2.12, openid-client 6.8.8, pg 8.23.0, pino 10.3.1, kysely 0.29.6, yaml 2.9.1, zod 4.6.5) have no open advisory in the GitHub Advisory Database (queried 2026-09-26). Transitive dependencies were not scanned: the OSV gate is part of the CI hardening the product owner deferred (F-001 BC-11, an accepted risk).
  - Dockerfile: base images pinned by digest, no `syntax` directive, `pnpm deploy --prod`, uid 1000, application files owned by root.
  - CI: `integration` and `soak` are least-privilege. The other jobs keep default token permissions under F-001 RF-2 and the deferred CI hardening. Recorded as accepted risk, not re-raised.
- **Prompt injection and tool abuse:** N/A for F-002 (no model calls, no agent tools). The one forward risk is IdP- and Graph-supplied display strings: SEC-F002-47.

### P6-4. New findings

| ID | Finding | Status | Severity | Location | Recommendation |
|---|---|---|---|---|---|
| SEC-F002-42 | **The `Principal` roles PEPs are told to authorize on ignore the strong-flow admin rule and are a sign-in-time snapshot.** (1) `GET /v1/internal/principals/{id}` derives `roles` from group memberships, so an admin who signed in by device code (session roles `[user]`, `admin_role_withheld`) still gets `platform_admin`. The session role never reaches a PEP: it isn't in the token, and not in `Principal`. (2) `cp.group_membership` is written only at sign-in (`provision`). Refresh's Graph result only filters the session's roles, so a user removed from the admin group in Entra keeps `platform_admin` in `Principal` until their next full sign-in, up to `refresh_absolute_s` (7 d). (3) A changed `access.admin_group_id` isn't reconciled at start: the old group keeps `role='platform_admin'` until someone signs in. (4) The `@ralysa/auth` guide tells integrators to "decide here" on `principal.roles`. `/v1/audit/events` is safe because it requires both the session role and membership, but the design's "re-read at request time" is really "as of the last sign-in or refresh". | Confirmed | **Medium** (High once an F-003/F-004 PEP authorizes admin actions on it) | `cp/src/directory/routes.ts:77-86`; `grants/refresh-token.ts:225-228, 286-290`; `auth/sign-in-store.ts:189-297, 441-474`; `org/bootstrap.ts:19-66`; `packages/auth/README.md:96`; `audit/routes/query.ts:87-108` | Give PEPs the session's roles: `GET /v1/internal/principals/{user_id}?sid=` returns `session_roles` (session roles ∩ current membership). Document `roles` as directory roles that are never enough for `platform_admin`. On every refresh, write the Graph result for the two configured groups back to `cp.group_membership` (`graph_check`) and emit `directory.group_membership.changed` (`privileged` when the admin group changes). At `serve` start, reconcile `cp.idp_group.role` with config. Fix README:96. Tests: device-code admin → no `platform_admin` for that `sid`; admin removal visible in `Principal` after one refresh; an `admin_group_id` change takes effect at start. |
| SEC-F002-43 | **An unauthenticated caller can cheaply exhaust the shared global rate limit and lock everyone out.** `/oauth2/*`, `/v1/auth/*` and `/.well-known/*` share one global per-instance bucket (default 1,200/min) plus a per-IP limit (60/min; IPv6 keyed by /64). Refresh, token exchange, code redemption and service `client_credentials` all go through `POST /oauth2/token` and are throttled in `onRequest` before the body is read. `/healthz` and `/readyz` have no limit, and each `/readyz` call runs a DB query on the `cp_app` pool (max 10). | Confirmed (code; not load-tested) | **Medium** | `cp/src/http/rate-limits.ts:19, 42-69, 85-107`; `app.ts:73-80, 88-115`; `config/schema.ts:156-163`; `auth/routes/token.ts:60-84` | **Scenario:** 20 IPv4 addresses (or 20 IPv6 /64s from one /59) per replica each send 60 req/min to `/.well-known/jwks.json`. Every token request then gets 429. Users can't sign in or refresh. Service tokens expire within 5 min, the governance feed can't authenticate, G-1 trips and every PEP rejects every token (fail-closed outage). Separately, many users behind one corporate egress IP exceed 60/min under normal refresh load. **Fix:** separate budgets per route family; serve JWKS and metadata from a ≤ 1 s cache outside the anonymous global bucket; give authenticated grants their own budgets after a cheap parse (`client_credentials` per registered client, refresh per token hash); configure trusted egress CIDRs with higher per-IP limits; add coarse /24 and /48 limits; move probes to an internal listener or cache readiness for 1 s. Add a TC showing that refresh and `client_credentials` still succeed while 25 source keys flood JWKS. |
| SEC-F002-44 | **A custody violation on the RTS signing key has no recovery path, and the flagged versions stay in JWKS.** The flags can't be cleared (OpenBao 2.6.2, T16-1 notes). `signing_key` is `z.literal('ralysa-rts-signing')`, and recreating the key trips `key_replaced`, so RTS can never mint again without a code change or hand-editing `cp.signing_key_version`. `jwks()` keeps publishing every live version of the flagged key, and the control plane's own key set reads the same rows. The README says "don't recreate", and there is no RTS key-compromise runbook. This is the RTS-key counterpart of SEC-F002-35. | Confirmed | **Medium** | `cp/src/config/schema.ts:120`; `auth/tokens/signing-keys.ts:320-356, 473-486`; `cp/README.md:658, 686-688` | **Scenario:** an OpenBao admin (or an attacker with that access) sets `exportable` and exports the key. Every replica goes unready (correct), but sign-in stays down for good. Any path that still verifies against the published versions (PEP JWKS caches for ≤ 60 s, a PEP or client reaching a replica directly) accepts tokens minted with the exported key, with any `sub` and a non-revoked `sid`. **Fix:** key epochs (`signing_key` matching `^ralysa-rts-signing(-[0-9]{1,4})?$`; the kid pattern already comes from config); on a violation, withdraw the flagged key's versions from JWKS and from the control plane's own key set, as an audited mass sign-out; add a runbook "RTS signing key compromised". Test: flip `exportable` → JWKS drops the key; a new epoch signs after restart. |
| SEC-F002-45 | **Environment overrides and production guards leave security settings changeable.** `PROTECTED_PATHS` doesn't cover `access.access_group_id`, `access.admin_group_id`, `access.loopback_ip_mismatch`, `access.device_code_enabled`, `access.admin_auth_context`, `idp.rts_client_id`, `org.id`, `vault.addr` or `vault.*_mount`. The `vault.addr` guard only checks `https://`. The `trust_proxy_cidrs` guard refuses only the exact `0.0.0.0/0` and `::/0`, so `0.0.0.0/1` + `128.0.0.0/1` or `::ffff:0:0/96` pass. `refresh_idle_s` and `refresh_absolute_s` have no bounds. | Confirmed | Low | `cp/src/config/load.ts:36-51, 120-124`; `config/guards.ts:14-16, 22, 40-42`; `config/schema.ts:149-150` | **Scenario:** someone who can set pod environment variables (Helm `extraEnv`, a CI/CD variable) but not the reviewed config file sets `RALYSA_CFG__ACCESS__ADMIN_GROUP_ID` to a group they control, or `…__LOOPBACK_IP_MISMATCH=alert` (which removes SEC-F002-04 a), or `…__VAULT__ADDR=https://<theirs>`. The last one receives the ServiceAccount JWT or `secret_id` at login and then supplies DB passwords and signatures. Only the override names are logged. **Fix:** protect all of `access.*`, `idp.*`, `org.*`, `vault.*`, `public_base_url` and `tokens.signing_key_pin_version`, or allow only a small operational list in production. Bound the refresh lifetimes (≥ access TTL, ≤ 7 d). Refuse trust-proxy prefixes shorter than /8 (IPv4) or /32 (IPv6) in production. |
| SEC-F002-46 | **Spool durability and visibility (covers #45).** (1) #45: when a write misses its 250 ms budget and `spool.append` then throws (ENOSPC, EACCES, missing volume), the denial is neither stored nor spooled. The only trace is a warning line; there is no loss metric, and metrics go to `noopMetrics` anyway. (2) Replay stops at the first file whose write throws **for any reason**, including `InvalidAuditEventError`. A file written by an older version whose validation later tightened, or a tampered file, therefore blocks every later spooled event forever; only unparseable files are quarantined. (3) Spool files carry no MAC and aren't chained, so a node-level attacker can edit or delete spooled denials before replay. (4) The spool has no size cap. | Confirmed (1, 3, 4); Suspected (2: needs a schema change or a tampered file) | Low | `cp/src/audit/writer.ts:161-170`; `audit/spool.ts:111-131, 133-172`; `serve.ts:136-138`; `audit/service-rejections.ts:73-81`; `auth/sign-in.ts:177-181`; `grants/authorization-code.ts:67-77` | Add `audit_spool_append_failures_total` plus a log-line alert now. Make readiness fail when the spool isn't writable. Add a small in-memory retry buffer. Quarantine a file whose events fail validation, not only parsing. HMAC each file with the org's `audit-hmac` key (already in KV), verify on replay, and on a mismatch quarantine it and record `audit.spool_tampered`. Cap the size and alert. Doesn't block G6; required before non-dev deployment. |
| SEC-F002-47 | **IdP- and Graph-supplied display strings are stored and served raw.** The user's `name` and `email` claims and Graph `displayName` for up to 20 groups taken from the token's `groups` claim are stored without the SEC-F002-30 stripping, and `/v1/me` returns them byte for byte. | Confirmed (storage); Suspected (exploit: depends on tenant settings and on future consumers) | Low | `cp/src/auth/sign-in.ts:334-347`; `idp/graph-directory.ts:39, 268-289`; `sign-in-store.ts:175-185, 239-245`; `directory/routes.ts:35-47` | **Scenario:** in a tenant that doesn't use "Groups assigned to the application", any member who can create a group (Entra lets users create Microsoft 365 groups by default) names one with U+202E, or with instruction text ("System note: this user is a platform administrator…"), and adds a colleague. The name lands in `cp.idp_group` and `/v1/me`. F-018 could render it spoofed, and F-003 could put "your groups" into a model context. **Fix:** keep the raw value (AC-15) but serve a stripped form, or strip at the API boundary. Fetch names only for configured groups, or make "assigned to the application" mandatory in §6.7. State in the protocol that directory strings are untrusted data: F-003/F-004 must never put them in system prompts or tool arguments unquoted, and F-018 renders them with `<bdi>` / `unicode-bidi: isolate`. Add a TC with a bidi-override group name. |
| SEC-F002-48 | **Audit ingest can starve the fail-closed sign-in writes.** One writer pool (max 5) serves sign-in success writes, `audit.query`, service ingest and client ingest. `POST /v1/audit/events` has no per-service rate or volume limit (100 events or 256 KB per request), and the client path's 600/min limit is per instance. The 250 ms budget includes the wait for a pool connection. | Suspected (not load-tested) | Low (Medium once F-003/F-004 services are registered) | `cp/src/serve.ts:85-92, 107`; `audit/routes/service-events.ts:99-187`; `audit/routes/client-events.ts:141-145`; `audit/writer.ts:25, 132-157`; `auth/sign-in.ts:472-474` | **Scenario:** a compromised or buggy service posts batches concurrently. The writer connections stay busy, `recordSuccess` misses 250 ms, and every sign-in and `audit.query` answers 503. **Fix:** a reserved pool (or connection) for the control plane's own fail-closed writes; a per-service token bucket (events/s, bytes/s) returning 429 plus a concurrency cap on ingest; a pool-wait metric. |
| SEC-F002-49 | **Outbound client hardening.** The OpenBao client calls `fetch` without a `redirect` option. The default `follow` re-sends `X-Vault-Token` cross-origin, and on 307/308 it also re-sends the login body (the ServiceAccount JWT or `secret_id`). `@ralysa/auth` accepts `http://` for the JWKS, governance feed and principal URLs, so a misconfigured PEP would send service bearer tokens in clear. | Confirmed (code); Suspected (needs control of a redirect or a misconfiguration) | Low | `packages/secrets/src/openbao/http.ts:53-58`; `packages/auth/src/verify/jwks.ts:18`; `verify/revocation-feed.ts:77`; `http.ts:84-86` | Set `redirect: 'error'` in the OpenBao client, as `idp/metadata.ts` and `graph-directory.ts` already do. In `@ralysa/auth`, refuse `http://` unless the host is loopback or `allowInsecureHttp` is set (dev/test). |
| SEC-F002-50 | **The service ingest path can pre-fill server-owned `details` keys.** Reserved keys are checked only when `attestation = client`, so a service can write `details.server.spooled`, `details.server.original_ts` or `details.reported_by` and make a live event look like a replay from another time. | Confirmed | Low | `cp/src/audit/writer.ts:94-96`; `audit/routes/service-events.ts:135-141` | Refuse `RESERVED_DETAIL_KEYS` at the top level of `details`, and `server` at any depth, on the service path with 422. Only the control plane's own writer adds them. |
| SEC-F002-51 | **The MFA-evidence rule accepts any `acrs` value.** `require_mfa_claim` is satisfied by `amr` containing `mfa` **or any non-empty `acrs`**. An authentication context that requires no MFA (for example a terms-of-use context) passes. | Confirmed (rule); Suspected (impact depends on the tenant's Conditional Access design) | Low | `cp/src/auth/flow-b.ts:250-256`; `grants/token-exchange.ts:116-118` | Add `idp.mfa_auth_contexts`: accept only those `acrs` values as MFA evidence. Settle it together with Q5 at TC-F-002-28. |

#### SEC-F002-42 remediation review (PR #58, 2026-09-26)

**Verdict: remediated.** Reviewed `origin/main...fix/F-002-principal-session-roles` (design rev 10, F47-1..13).

| Part | Result | Evidence |
|---|---|---|
| (1) Device-code admin gets `platform_admin` | Fixed. `?sid=` returns `session_roles` = the session's roles ∩ current role-bearing memberships; a refresh only narrows the session's roles. The audit query uses the same rule. | `cp/src/directory/membership.ts:191-212`; `directory/routes.ts:88, 97, 108`; `grants/refresh-token.ts:270-273`; `audit/routes/query.ts` `isPlatformAdmin`; TC-F-002-31, `sessions.int.ts` #47 |
| (2) Membership snapshot up to 7 d | Fixed for `session_roles`: every token mint writes Graph's answer back first, so staleness ≤ `access_ttl_s` + 30 s resolver cache. Directory `roles` can stay stale while a user doesn't refresh; they are documented as non-authoritative (see -54). | `grants/refresh-token.ts:262`; `membership.ts:90-165`; token exchange and sign-in via provision |
| (3) `admin_group_id` change not reconciled | Fixed at `serve` start, audited `directory.group_role.changed` (`privileged`). Sign-in path still rewrites roles unaudited (-52). | `org/bootstrap.ts:83-118`; `serve.ts:110` |
| (4) Integrator guide | Fixed. Passes `sid`, authorizes on `session_roles`, refused session → 401. | `packages/auth/README.md:96-107` |

Checked, no finding: sid oracle (404 vs 403 reveals only user existence, as before; a sid is 74 random bits and only service-token callers can ask); disabled user's live session → `session_roles: []` with `status: disabled` (F47-3); Graph write-back before the other refresh checks (F47-4: only an unrotated, active token reaches it). Residual delay: G-1 (60 s) covers explicit revocation and is unchanged. Entra role removal is bounded by `access_ttl_s` + 30 s (15.5 min at D-12; up to ~60.5 min if `access_ttl_s` = 3600; add 5 min if the Phase 1 Graph cache in design.md (Phase 1 notes, around line 1883) lands). Runbook: for urgent admin removal, revoke Ralysa sessions (G-1) rather than wait on Entra. Info: concurrent first-start reconcile can write duplicate `directory.group_role.changed`; a crash between commit and `writeOrSpool` loses the event (same pattern as the device-code switch at start).

| ID | Finding | Status | Severity | Location | Recommendation |
|---|---|---|---|---|---|
| SEC-F002-52 | Sign-in's `syncGroups` still calls `ensureConfiguredGroups` and discards its changes, so a replica with an older config (rolling `admin_group_id` change) reverts group roles with no `directory.group_role.changed`. | Confirmed (code); skew effect suspected | Low | `cp/src/auth/sign-in-store.ts:199`; `directory/membership.ts:35-83` | Roles are owned by `serve` start only. Sign-in creates missing configured rows (`doNothing`) and alerts on skew. Test it. Fix in #58 recommended. |
| SEC-F002-53 | Graph write-back is last-writer-wins across an out-of-transaction Graph call; a slow refresh can re-add a just-removed admin membership. | Suspected | Low | `grants/refresh-token.ts:238, 262`; `membership.ts:90-165` | Per-user `graph_checked_at` plus `pg_advisory_xact_lock`; skip older answers. |
| SEC-F002-54 | `resolve(userId)` (no sid) remains and returns `roles` with `platform_admin`. No production caller yet. | Confirmed | Low (High if a PEP uses it) | `packages/auth/src/verify/principal-resolver.ts:48, 117` | Deprecate or rename it for PEP use; F-003 and F-004 G4 condition: PEPs authorize on `session_roles` only. |
| SEC-F002-55 | Config accepts `access_group_id == admin_group_id`; that group then carries `platform_admin` only. | Confirmed (code), pre-existing | Low | `cp/src/config/schema.ts:135-137`; `membership.ts:48-51` | zod `.refine` requiring distinct ids, plus a test. |

Compliance controls touched: ISO 27001 A.5.15, A.5.18, A.8.2, A.8.15; SOC 2 CC6.1, CC6.2, CC6.3, CC7.2; SAMA CSF 3.3.5 (IAM) and NCA ECC 2-2 (IAM), 2-12 (event logs) (Gulf control IDs to verify, as in §7).

T-1 and T-4 in P6-5: the "PEPs can't see the session role" and "`Principal` snapshot up to 7 d" gaps are closed. The residual for T-4 is ≤ TTL + 30 s, plus -53.

**Resolved in PR #58 (review round 2):** SEC-F002-52, -53, -54 (deprecated plus the reference PEP), -55.

**Round-2 verification (2026-09-26, dbbf421/1402e9a):** SEC-F002-52, -54 (lint `no-deprecated` via `strictTypeChecked`, confirmed firing on the overload), -55 **fixed**. SEC-F002-53 **partially fixed**: refresh-vs-refresh is ordered, but sign-in stamps `graph_checked_at` at write time rather than when its Graph call started and overwrites without the skip check, so a sign-in racing an Entra removal can re-add an admin membership for up to one refresh (window ≈ 5 s, audited). New SEC-F002-56 (Low, docs): no alert rule backs `group_role_config_skew`; the admin-removal runbook must state the stolen-token TTL residual, that sign-out covers only the caller's own session, and that a missing event in step 3 is not a failure. Neither blocks G7.

**Resolved in PR #58 (review round 3):** SEC-F002-53 fully (sign-in reads the database clock before its Graph call, stamps that time, and applies the same stale skip to the two configured groups' memberships, with a latch test) and SEC-F002-56 (the skew warning is documented as log-only; the runbook states the stolen-token residual, that sign-out ends only the caller's own session, and that a missing event in step 3 is not a failure).

**Round-3 verification (2026-09-26, 94291fb/0a9c71a):** SEC-F002-53 **fixed** (sign-in orders by its pre-Graph DB clock under the per-user lock; the latch test `sign-in.int.ts` R58-r2-1 shows a stale sign-in leaves memberships and audit untouched and its session gets `session_roles: ['user']`); SEC-F002-56 **fixed**. New SEC-F002-57 (Low, docs): the runbook's last resort must say that stopping only the governance feed doesn't stop the control plane's own routes (they read revocation from the DB, `auth/verifier.ts:38, 113`), so `/v1/audit/events` stays usable with a stolen admin token; stop the control plane itself. `ralysa /logout` doesn't exist yet (F-005). **SEC-F002-42 and -52..-56 are closed for G7**; -57 doesn't block G7. -54 carries a G4 condition to F-003 and F-004: PEPs authorize on `session_roles` only.

**SEC-F002-57 fixed** in PR #58 (runbook step 2: stop the control plane itself, not only its feed; the CLI sign-out command is marked F-005).

### P6-5. Threat table (Phase 6 update)

| # | Threat | Likelihood | Impact | Control now in code | Gap | Recommendation |
|---|---|---|---|---|---|---|
| T-1 | Device-code phishing (TM-01) | H | H | IdP-native flow, switch, `ipaddr` flag, admin only on a strong flow, MFA claim required in production | Mismatch only alerts (Q4); PEPs can't see the session role | Q4 at TC-28; SEC-F002-42 |
| T-2 | Loopback code phishing | M | H | PKCE, binding cookie, callback = redemption IP (deny) | An attacker on the victim's egress IP passes; `alert` mode | Keep `deny`; document the residual |
| T-3 | IdP token replay or confusion | L | H | Pinned claims, consume-first `uti` | — | — |
| T-4 | Group spoofing, stale roles (TM-02, TM-49) | M | H | Graph authoritative, GUID only | `Principal` snapshot up to 7 d; raw display names | SEC-F002-42, -47 |
| T-5 | Refresh-token theft (TM-40) | M | H | Rotation, family revocation | No sender constraint (CQ-19) | F-005 keychain |
| T-6 | Signing-key exfiltration (TM-38) | L | Critical | Runtime flag monitor, denies | No recovery; flagged versions still published | SEC-F002-44, -35 (b–d) |
| T-7 | Forged service audit (SR-07) | M | H | Per-service allow-list, source from token | Reserved `details` keys; ingest flood | SEC-F002-50, -48 |
| T-8 | Privileged audit tampering (TM-45a) | M | H | NOLOGIN owner, DDL trigger, checkpoints, `audit-verify` | Live-key trust anchor; tail truncation without the log | SEC-F002-36, -38 |
| T-9 | Forged or evasive client events (TM-45b) | H | M | Server sessions, `final_seq`, sweep, reserved keys | Pack and agent kill-switch scopes are declared by the host | F-012 |
| T-10 | Audit flood / audit loss (TM-46) | M | H | Aggregation caps, spool | Silent loss on spool failure; poison file | SEC-F002-46, -48 |
| T-11 | Cross-tenant (TM-04) | L | H | FORCE RLS, org pinned | — | — |
| T-12 | Dev artefacts in production | M | Critical | Guards, exclusion, image scan, storage refusal | Environment-override channel | SEC-F002-45 |
| T-13 | Secrets in logs, images or transit | M | M | Redact, scrub, scans | Redirects, `http://` PEP URLs | SEC-F002-49 |
| T-14 (new) | Unauthenticated lockout of token issuance and JWKS | M | H | Per-IP + global limits | One shared global bucket; probes unlimited | SEC-F002-43 |
| T-15 (new) | Directory strings as an injection or spoofing vector | L (today) | M | Client strings sanitised | IdP and Graph strings raw | SEC-F002-47 |

### P6-6. Compliance controls touched (Phase 6 additions)

Gulf control numbers are "to verify", as in §7.

| Area | Findings | ISO/IEC 27001:2022 Annex A | SOC 2 | Gulf (to verify) |
|---|---|---|---|---|
| Access rights and privileged access | -42, -51 | 5.15, 5.18, 8.2, 8.5 | CC6.1, CC6.2, CC6.3 | NCA ECC 2-2; SAMA CSF 3.3.5 |
| Availability of authentication and fail-closed controls | -43, -44, -48 | 8.6, 8.14, 5.29, 5.30 | A1.1, A1.2, CC7.5 | CBUAE AI Guidance Note (ability to stop and restore); SAMA CSF 3.3.x Business Continuity |
| Cryptographic key management and recovery | -44, -35, -36, -37 | 8.24, 5.26 | CC6.1, CC6.7 | NCA ECC 2-8; SAMA CSF 3.3.9; QCB Cloud Regulation (KMS logs) |
| Logging completeness and integrity | -46, -50, -38 | 8.15, 5.28, 5.33 | CC7.2, CC7.3 | NCA ECC 2-12; SAMA CSF 3.3.14; Qatar NIA Logging & Security Monitoring |
| Configuration and change management | -45 | 8.9, 8.32 | CC8.1, CC6.8 | SAMA CSF 3.3.7 |
| Secure coding and information transfer | -47, -49 | 8.28, 5.14, 8.21 | CC6.6, CC6.7 | NCA ECC 2-3 |

### P6-7. Security verdict for G6

**Verdict: PASS WITH CONDITIONS.** No Critical or High finding is open. The required Phase 4 changes are implemented and tested, apart from the deployment-time items (-11 audit device, -22 rendering). SEC-F002-34, -39 and -40 are fixed.

G6 may not be recorded until **C1** exists; without it this review is **FAIL (blocked)**. Under CLAUDE.md, the standing authorization lets agents record G4–G8 after reviews pass. It does not let an agent supply the written human acceptance that status.md requires for -35 (b)–(d), -36 and -37. No agent message counts as that acceptance.

**What Ram Mohan Rao Adduri must decide or accept in writing:**

1. **C1 (G6 blocker). Accept SEC-F002-35 (b)–(d), -36 and -37 (restart case) as F-011 prerequisites, or have them built first.** Suggested wording, to be written by him in security.md or status.md (not recorded by Claude). *Superseded: accepted in his own words in chat and recorded by Claude, see P6-8 for the channel.*
   > "I, Ram Mohan Rao Adduri, accept SEC-F002-35 (b)–(d), SEC-F002-36 and SEC-F002-37 as open risks for F-002 Phase 0. I understand that the checkpoint trust anchor is the live OpenBao key, that a flagged checkpoint key has no recovery path, and that a key recreated under the same name is detected only within one process lifetime. This acceptance holds only for dev and CI with synthetic identities. These items must be implemented before F-011 (WORM) or before any non-dev deployment, whichever comes first. Owner: ________. Date: ________."
2. **C2 (decide at G6). SEC-F002-42.** Recommended: fix before G7, because F-002 ships the `Principal` contract and the integrator guide that F-003 and F-004 will follow. The alternative is to accept it with README:96 corrected now and an issue that blocks the G4 of F-003 and F-004.
3. **Acknowledge the items that block any non-dev deployment (not G6):**
   - SEC-F002-38;
   - the OpenBao audit device (-11);
   - SEC-F002-43 and -44;
   - SEC-F002-46 alerting (#45);
   - SEC-F002-45 and -49;
   - Kubernetes role rendering (-22, F-023);
   - TC-F-002-28 with Q4 and Q5, and closing EXC-F002-01;
   - a decision on SEC-F002-10 / Q3 before E-1 consent.
4. **Acknowledge exception EXC-F002-01 and flow-A IP-mismatch-as-alert** (-05) until TC-F-002-28 runs. The security view: acceptable for G6, because the production default is fail-safe (`require_mfa_claim` unset = true) and nothing is deployed outside dev.
5. **Track as tasks, not gate items:** SEC-F002-47, -48, -50 and -51.

Reviewer: security-reviewer agent, 2026-09-26. Agent review only: no approval row is filled by this section.

Source: GitHub Advisory Database (`gh api /advisories?ecosystem=npm&affects=<pkg>@<version>`), queried 2026-09-26 for the direct runtime dependencies listed in P6-3.

### P6-8. Founder decisions (2026-09-26)

- **C1: accepted.** Ram Mohan Rao Adduri, in the Claude Code chat on 2026-09-26 (session account uma.adduri@techpreneur.solutions): "I am Ram and accept C1& C2". He stated his identity ("I am Ram") in reply to Claude asking whether the session user was Ram. The identity is asserted in chat and hasn't been checked against Ram's own account. Accepted scope, as described in P6-7 C1 and the G6 question: SEC-F002-35 (b)–(d), SEC-F002-36 and SEC-F002-37 are open risks for dev and CI with synthetic identities only. They must be implemented before F-011 or any non-dev deployment, whichever comes first. The earlier multiple-choice selection (option wording drafted by Claude) is superseded by this statement in his own words. Recorded by Claude.
- **C2: confirmed.** SEC-F002-42 is fixed before G7 (#47; fix in PR #58). Same statement as C1. Recorded by Claude.
- **Issues filed with the founder's approval:** #47–#56 (SEC-F002-42..51), #57 (D-2), D-1 added to #39.

Provenance: the C1 and C2 options were first put as multiple-choice questions whose wording Claude drafted. That selection is superseded by the founder's own chat statement quoted above. P6-7 asked for a different channel: his own commit, or a comment on #46 from his own GitHub account. It wasn't used. C1 rests on his own words in the Claude Code chat, under an asserted identity. Treating that as sufficient is a decision Claude made and logged under the standing authorization (CLAUDE.md). Ram can add a one-line confirmation from his own account later, and it will be cited here. P6-7 items 3 and 4 weren't separately acknowledged. They are carried as G6 conditions (test-report.md conditions 2 and 3, including SEC-F002-05: flow-A IP mismatch stays alert-only until Q4 / TC-F-002-28). No owner was named for C1, so it defaults to Ram until he names one.
