# control-plane

`@ralysa/control-plane`: Profiles, policies, skills, plugins, memory, approvals, audit API.

F-002 builds the Phase 0 slice: the Ralysa Token Service (OIDC relying party toward Entra ID,
OAuth authorization server toward Ralysa clients), users, groups and sessions, the audit store
with its sealer and signed checkpoints, and the governance feed. Design:
[docs/features/F-002-sso-control-plane-skeleton/design.md](../../docs/features/F-002-sso-control-plane-skeleton/design.md).

## Entry points

`node dist/main.js <command>` (bin `control-plane`). Each entry point loads only its own config
schema and logs in to OpenBao as its own role (SEC-F002-02). So far:

| Command                           | Runs as                                                               | Reads from OpenBao              |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| `migrate --config <file>`         | `ralysa_migrator`                                                     | `db_credentials.migrator`       |
| `migrate --audit --config <file>` | `ralysa_audit_migrator` → `SET ROLE ralysa_audit_owner` (break-glass) | `db_credentials.audit_migrator` |
| `serve --config <file>` | `ralysa_cp_app`, `ralysa_audit_writer` (and `ralysa_audit_reader` from T12) | `db_credentials.*`; signs tokens with Transit `ralysa-rts-signing` |
| `bootstrap-org --config <file>` (serve config) | `ralysa_cp_app` | `db_credentials.cp_app` |
| `sealer --config <file>` | `ralysa_audit_sealer` (its own process and deployment) | `db_credentials.audit_sealer`; signs with Transit `ralysa-audit-checkpoint` |
| `audit-verify --config <file> [--org <uuid>] [--shard <s>] [--log-checkpoints <jsonl>]` | `ralysa_audit_reader` (read-only) | `db_credentials.audit_reader`; reads the checkpoint key's public versions |

Both migrate jobs also write one `db.migration.applied` per applied migration (with the
`migrations.lock.json` checksum) through `db_credentials.audit_writer`. If that write fails the
job exits non-zero, saying the migrations were applied but not recorded.

## The API (`serve`, F-002-T07)

- **Start-up.** The entry point:
  - applies the production guards: the common ones, plus `https` for `public_base_url`, an issuer
    exactly `https://login.microsoftonline.com/<tenant_id>/v2.0`, `graph_base_url`
    `https://graph.microsoft.com`, no `0.0.0.0/0` or `::/0` in `trust_proxy_cidrs`, the MFA claim
    required unless `access.mfa_claim_exception_ref` is set, and an OpenBao `sys/seal-status`
    that is neither in-memory (a dev server) nor sealed;
  - refuses a signing key that is `exportable` or allows plaintext backup;
  - creates or checks the Organization (region, residency and deployment model can't change;
    `access.device_code_enabled` is copied into its settings);
  - with `access.device_code_enabled: false`, revokes every live flow-A session (`flow =
    idp_device`) with `auth.session.revoked cause=device_code_disabled` and logs
    `device_code_disabled` with the count. This runs on every start, so a switch turned off while
    the service was down takes effect too (SEC-F002-32, D-30);
  - polls the signing key, replays the audit spool every 30 s, runs the session cleanup every
    minute, and listens.
  - writes one `config_loaded` line with the resolved config file path and the names (never the
    values) of `RALYSA_CFG__*` overrides. Every entry point writes this line.
- **Routes:**

  | Route | What it returns |
  |---|---|
  | `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata |
  | `GET /.well-known/jwks.json` | Public keys from `cp.signing_key_version`, with `Cache-Control: public, max-age=60, must-revalidate` |
  | `GET /v1/auth/config` | The enabled flows and IdP endpoints |
  | `POST /oauth2/token` | Token exchange of an IdP device-flow token (T10), `refresh_token` and `client_credentials` (T08); `authorization_code` arrives with the second part of T10 |
  | `POST /v1/auth/sign-in-failures` | 202: the CLI's report of an IdP-side flow-A failure, audited as `auth.sign_in failure` (T10) |
  | `POST /oauth2/revoke` | RFC 7009 sign-out: revokes the refresh token's whole session; always 200 |
  | `GET /v1/me` | The signed-in user, the calling session's roles and the user's groups (user token) |
  | `GET /v1/internal/principals/:user_id` | A user's status, roles and groups (service token) |
  | `GET /v1/internal/governance` | Revocations, kill switches and `epoch` for every PEP (service token) |
  | `GET /healthz` | Liveness |
  | `GET /readyz` | Readiness: database, an active and freshly polled signing key, no custody violation |

  Every response carries `traceparent`. Errors are `application/problem+json` with a stable
  `urn:ralysa:problem:*` type (OAuth routes: RFC 6749 errors). `openapi/control-plane.v1.json`
  is generated from `src/http/contracts.ts` (`check:generated`).
- **Signing keys** (`src/auth/tokens/signing-keys.ts`), polled every `tokens.key_poll_s`:
  - a new Transit version is **published** at once (a row in `cp.signing_key_version`, so it is
    in JWKS);
  - it is **activated** `tokens.activation_delay_s` later on the database clock (the first key
    ever is active at once);
  - the previous version is **retired** from JWKS after `access_ttl_s` + 5 min;
  - each phase writes `secret.rotated`;
  - a custody flag, or a stored version whose public key no longer matches Transit (the key was
    recreated), stops minting **for the life of the process** and makes `/readyz` 503.
    `secret.custody_violation` is recorded with every flag and retried until it lands;
  - `tokens.signing_key_pin_version` forces a version (rollback).
- **Tokens** are minted by `mintAccessToken` with the header exactly `{alg: ES256, typ: at+jwt,
  kid}`. The claims are validated against the protocol contract before signing.
- **Logging** (AC-14):
  - One JSON line per request with method, **route template**, status, latency and request id.
    A URL the router can't decode gets one line with `route: bad_url`.
  - The URL, query, headers and body are never logged.
  - pino `redact` covers credential headers and body fields. A scrubber removes JWTs,
    `rly_rt_`/`rly_ac_` tokens, OpenBao tokens and URL credentials from every record and from
    message strings. Anything nested deeper than 8 levels is dropped as `[REDACTED:depth]`.
  - The whole process (Fastify, the key watcher, the spool, start-up) writes through one pino
    instance with these rules.
- **Rate limits** (SEC-F002-16): `/oauth2/*`, `/v1/auth/*` and `/.well-known/*` have
  `rate_limits.per_ip_per_minute` (60) per client IP and `rate_limits.global_per_minute` (1200)
  per instance. A throttled request gets 429 with `Retry-After`.
  - Limiting is decided on the matched route template, so percent-encoded paths are limited like
    the route they reach.
  - Clients are keyed by IP address, and IPv6 clients by /64.
  - The client IP honours `X-Forwarded-For` only from `trust_proxy_cidrs`.
- **Sessions and grants** (F-002-T08; `src/auth/`):
  - A session (`sid`) is one refresh-token family. Refresh tokens are `rly_rt_` + 43 characters,
    stored as SHA-256 hashes only, and expire after `tokens.refresh_idle_s` (12 h) or at the
    session's absolute expiry (`tokens.refresh_absolute_s`, 7 d).
  - **Refresh** rotates the token with one guarded statement. Presenting a rotated token is
    **reuse**: the whole family is revoked (`auth.token.reuse_detected`, `auth.session.revoked`,
    `auth.refresh denied reuse_detected`) and the answer is `invalid_grant`. There is no grace
    window.
  - **One refresher per device** (SEC-F002-17, a contract on F-003 and F-005): only the CLI (or
    the Desktop main process) refreshes. It hands access tokens to the local Agent Host through
    the `TokenProvider` over IPC. When two processes refresh the same token, exactly one gets new
    tokens and the other gets `invalid_grant` with `ralysa_error.code = reuse_detected`, and the
    family is revoked, so the user signs in again. The same happens when a refresh **response is
    lost** (a network drop after RTS rotated the token) and the client retries with the old token:
    that retry is reuse too. The refresher must treat a lost response as a sign-out, not retry it.
    A refresh that fails **before** rotation (signing unavailable, IdP unreachable) answers `503
    temporarily_unavailable` and consumes nothing, so that one is safe to retry.
  - Every refresh re-checks the user at the IdP directory. If the directory is unreachable, the
    answer is `503 temporarily_unavailable` and the token is **not** consumed. A disabled or
    deleted user, Entra sessions revoked after sign-in, or a user in no configured group is
    refused, and the session (or the user, with `revoked_before` = DB clock + 30 s) is revoked.
    The directory is Microsoft Graph (see "Sign-in" below).
  - `audience` (default `control-plane`): other audiences need the session role `user`, else
    `invalid_scope`.
  - **Services** use `client_credentials` with an RFC 7523 assertion signed through their own
    Transit key (`kid` = `ralysa-svc-<name>.v<n>`, `aud` = `<public_base_url>/oauth2/token`,
    `exp - iat` at most 60 s, `exp` at most 60 s ahead of RTS's clock, a fresh `jti`, kept in the
    replay table until `exp` + 30 s skew + 60 s drift margin). RTS verifies it only against
    versions at or above both `min_available_version` and `min_decryption_version`. It caches
    each key's list for 60 s, so a retired version stops verifying within a minute. An unknown
    version re-reads the list at most every 5 s. A service key that is exportable or allows
    plaintext backup verifies nothing, and `secret.custody_violation` is written for it. The
    answer is a 5-minute service token. A refused assertion is `401 invalid_client` and an
    aggregated `auth.token_rejected`.
  - No client secret exists: a `client_secret` parameter or `Authorization: Basic` is
    `invalid_client`, and `password` and every unlisted grant are `unsupported_grant_type`.
  - **Governance feed:** `issued_at` is the database clock. `epoch` comes from
    `cp.governance_epoch_seq`: it never decreases and advances with every revocation. A response
    is cached for at most 1 s. Without `since`, the feed covers the last 65 minutes (the maximum
    access-token TTL + 5 min). `cursor` lags `issued_at` by 60 s, so a revocation that commits
    just after a poll is still delivered. PEPs de-duplicate the overlap. **Invariant:** no
    revocation transaction may stay open longer than that overlap, so each one caps itself with
    Postgres `transaction_timeout` = 15 s from its first revocation statement (a transaction that
    runs out revokes nothing and the request fails).
  - `/v1/me` checks the user token against revocation in the database, not through the feed.
  - **Cleanup** (every minute, every replica, one statement per batch):
    - a pending session whose authorization code expired unused is revoked, and
      `auth.sign_in failure code_not_redeemed` is written once;
    - replay keys are deleted at expiry;
    - `idp_auth_request` rows and code tombstones are deleted one hour after expiry;
    - sessions that ended more than 30 days ago are purged with their refresh tokens. A session
      ends when it is revoked, or at the earlier of its last refresh token's idle expiry and its
      absolute expiry.
- **Sign-in, flow A** (F-002-T10; `src/auth/idp/`, `sign-in.ts`, `grants/token-exchange.ts`):
  - The pinned tenant's discovery document is fetched from `idp.issuer` only. Its `issuer` must
    equal it, and its keys and endpoints must be on the issuer's origin.
  - The exchange validates the Entra access token: header exactly `alg: RS256`, `typ: JWT`,
    `kid` (and Entra's `x5t`); an RS256 signature by the tenant's keys; `iss` and `tid` pinned
    (a token RTS issued is `untrusted_issuer`); `exp`/`nbf` with 60 s skew and `iat` at most
    10 minutes old; `ver` 2.0, `aud` = `idp.rts_client_id`, `azp` in
    `idp.allowed_public_client_ids`, `scp` with the sign-in scope, a GUID `oid` and a `uti`.
  - **Consume first:** the SHA-256 of `uti` is inserted into `cp.idp_token_replay` and committed
    before anything else, so every presentation burns the IdP token, whatever happens next.
  - Then: the device-code switch (`unauthorized_client`), MFA evidence when
    `idp.require_mfa_claim` (default on in production: `amr` has `mfa` or `acrs` is non-empty),
    Microsoft Graph, the access decision, and provisioning.
  - The token's `ipaddr` is compared with the client IP. A difference is recorded
    (`details.ip_mismatch`), counted (`auth_device_ip_mismatch_total`) and logged as
    `auth_device_ip_mismatch` for the alert rule; it doesn't deny (Q4).
  - Users are keyed by `(issuer, oid)`; `sub` is never used. Display names are stored as sent
    (UTF-8, not normalised).
  - **Microsoft Graph** (`graph-directory.ts`) at every sign-in and refresh:
    `GET /v1.0/users/{oid}?$select=accountEnabled,signInSessionsValidFromDateTime` and
    `checkMemberGroups` for exactly `access.access_group_id` and `access.admin_group_id`. Graph
    decides membership, whatever the token's `groups` claim says; non-GUID claim values are
    ignored (`idp_group_claims_ignored_total`) and `_claim_sources` is never followed. `404` is a
    deleted user (denied, and a known user is disabled and revoked). Every call is bounded by
    `idp.graph_timeout_ms` (≤ 3 s). After 5 consecutive failures the circuit opens for 30 s.
    Graph is called with an app-only token from the tenant's token endpoint, using the client
    secret at `idp.client_secret_path` (re-read once on `invalid_client`). Group display names
    are read for display only (2 s, 20 per sign-in, refreshed daily).
  - **Roles** (`identity-mapping.ts`): `user` for the access group; `platform_admin` for the
    admin group only on a strong sign-in (flow B, `acrs` with `access.admin_auth_context`, or
    `amr` in `access.phishing_resistant_amr`). A user in both groups on a weak sign-in gets
    `user` with `admin_role_withheld`; an admin-only user is denied
    `admin_requires_strong_flow`. Other audiences than `control-plane` need `user`.
  - **Audit:** every attempt writes exactly one `auth.sign_in` with the `policy_version`. A
    success is written fail-closed after the session is committed: if the write fails, the
    session is revoked (`audit_unavailable`), the events are spooled, and the answer is 503. A
    failure before the subject is validated carries `attempted_identifier_hmac` (HMAC-SHA-256 of
    the unverified `preferred_username` under the key at `audit_hmac_path`) and
    `identifier_verified: false`, never the name. Device labels and user agents lose control,
    bidi and zero-width characters.
  - `POST /v1/auth/sign-in-failures`: 10 per minute per client (a throttled report writes
    nothing), idempotent per `attempt_id`, at most 60 events a minute for the org, and identical
    failures per /24 or /64 aggregated past 10 a minute into one event with `suppressed_count`.
- **Org source** (SEC-F002-31): unauthenticated routes act in `config.org.id`. A header, host,
  path or body never selects the org.

## Audit core

- **`AuditWriter`** (`src/audit/writer.ts`), as `ralysa_audit_writer`:
  - `write()` fails closed. Each event goes in with a plain INSERT inside a savepoint; SQLSTATE
    `23505` means `duplicate`. The whole call is bounded by 250 ms (`statement_timeout` as well),
    and any failure throws `AuditUnavailableError`, which maps to 503 `audit_unavailable`.
  - `writeOrSpool()` is for denials and non-blocking events: when the store is down, the batch
    goes to the disk spool.
- **Spool** (`src/audit/spool.ts`):
  - It lives in a dedicated `0700` directory (default `/var/lib/ralysa/audit-spool`, on a
    persistent volume) and writes one `0600` file per batch, written atomically.
  - Replay adds `details.server.original_ts` and `details.server.spooled = true`.
  - Without a persistent volume, `audit_spool_lost_total` is emitted at start.
- **Rejections** (`src/audit/rejections.ts`): `auth.token_rejected` is aggregated per client
  /24 or /64, reason and audience. The first 20 per minute are written individually, then one
  summary with `suppressed_count`, capped at 600 individual events per minute per instance.
- **Sealer** (`src/audit/sealer/`): one hash chain per org and source.
  - Every second, each shard is sealed in one transaction under
    `pg_try_advisory_xact_lock(hashtext(org:shard))`, with a 10,000-row lookback so a
    late-committing event is sealed on the next pass. An hourly sweep has no lookback.
  - Metrics: `audit_seal_lag_seconds` (alert above 5 s; the loop also logs
    `audit_seal_lag_high`) and `audit_seal_late_total`.
  - `verifyChain()` recomputes a chain from genesis and reports the first divergent `seq`.
- **Checkpoints** (`src/audit/sealer/checkpoint.ts`, D-28):
  - Every `checkpoint_interval_s` (60 s), for each shard with new seals, the sealer signs
    `JCS({org_id, shard, seq, hash, checkpoint_ts})` with the latest version of
    `ralysa-audit-checkpoint`. It inserts `audit.audit_checkpoint` and logs the same record as
    one `audit_checkpoint` line, the off-host copy.
  - Every `custody_poll_s` (30 s) it re-reads the key's `exportable` and
    `allow_plaintext_backup`. If either is set, checkpoint signing stops **for the life of the
    process** (sealing continues). `secret.custody_violation` is recorded with both flags through
    `audit.record_custody_violation()` (audit/0002, the sealer's only way to add an event),
    retried every poll until the database confirms it, and the `secret_custody_violation` gauge
    goes to 1. See the runbook below.
- **`audit-verify`** (`src/audit/verify/audit-verify.ts`) checks, per shard, and prints the
  first divergent `seq`, exiting non-zero on any finding:
  - every checkpoint signature against its key version;
  - the chain recomputed from the events (not trusted from the seals);
  - agreement between that chain and each signed hash;
  - cadence (≤ 120 s between checkpoints with seals between them, and no seal older than
    120 s left uncovered: `checkpoint_gap`);
  - with `--log-checkpoints`, that every logged checkpoint is still in the table unchanged.
  - Metrics and logs go through small ports (`src/observability/`) that T07 binds to the
    service's exporter and pino.

## Database

1. **Once per database, as a superuser (the DBA):** `src/db/sql/bootstrap-roles.sql`. It is
   plain SQL and idempotent. It refuses a non-UTF-8 server, creates the roles with no elevated
   attributes, creates the NOLOGIN `ralysa_audit_owner` (reachable only through `SET ROLE` from
   `ralysa_audit_migrator`), grants CONNECT/CREATE on the database, locks schema `public`, and
   installs the superuser-owned event trigger that writes `audit.schema_changed` for any DDL on
   the audit schemas (SEC-F002-01 b). It sets **no passwords**: set each login role's password
   from `kv/ralysa/control-plane/db/<role>` separately, as a SCRAM verifier over stdin.
2. **`migrate --audit`**, then **`migrate`**. Each set runs all its pending migrations in one
   transaction under Kysely's lock (a failure rolls back the batch), is up-only, and refuses a
   non-UTF-8 server. Running either twice is a no-op. History lives in `ralysa_meta_audit` and
   `ralysa_meta`.

Released migrations never change: `migrations.lock.json` and the `check-migrations-immutable`
repo check enforce it (add a migration, then `pnpm migrations:lock`). Application code reaches
org data only through `withOrg()` (`src/db/kysely.ts`), which sets `app.org_id`
transaction-locally; outside it every query on a `cp` or `audit` table fails (FORCE RLS).

## Configuration

A YAML file per entry point (`--config`, or `RALYSA_CONFIG`), validated by that entry point's
strict schema in `src/config/schema.ts`. It holds identifiers and OpenBao **paths** only; a value
that isn't a `<kv mount>/ralysa/control-plane/…` path fails validation, and so does any unknown
key.

```yaml
env: production # dev | test | production; unset → production
org: { id: <uuid>, name: …, residency: in_country, region: qa-doha, deployment_model: on_prem }
vault:
  addr: https://openbao.internal:8200
  auth: { method: kubernetes, role: ralysa-cp-migrate } # jwt_path defaults to the SA token file
  # auth: { method: approle, role_id: …, secret_id_path: /run/secrets/secret-id }  # needs allow_approle in production
  # auth: { method: token, token_env: BAO_DEV_ROOT_TOKEN_ID }                        # dev/test only
  allow_approle: false
db: { host: …, port: 5432, database: ralysa, ssl: true }
db_credentials: # migrate: migrator + audit_writer; migrate --audit: audit_migrator + audit_writer;
  # sealer: audit_sealer; audit-verify: audit_reader; serve: cp_app + audit_writer + audit_reader
  migrator: kv/ralysa/control-plane/db/migrator
  audit_writer: kv/ralysa/control-plane/db/audit_writer
```

The **serve** config adds `public_base_url`, `listen`, `trust_proxy_cidrs`,
`signing_key: ralysa-rts-signing`, `idp` (Entra tenant, issuer, client ids, scope,
`client_secret_path`, `graph_base_url`, `require_mfa_claim`), `access` (group object ids,
`device_code_enabled`, `loopback_ip_mismatch`, `mfa_claim_exception_ref`), `tokens` (TTLs,
`key_poll_s`, `activation_delay_s`, `signing_key_pin_version`), `rate_limits`, `audit`
(`spool_dir`, `spool_persistent`), `audit_hmac_path` and `services[]` (name, `svc:` client id,
`ralysa-svc-<name>` key, allow-listed audit actions). See `src/config/schema.ts`.

After parsing, cross-field checks apply to every entry point: every KV path must start with
`vault.kv_mount`, and a service may not be allow-listed for reserved audit actions other than
`auth.token_rejected` and `secret.rotated`.

In production every entry point refuses to start with token auth, AppRole without
`allow_approle`, a non-`https` vault address or `db.ssl: false`, plus the serve guards above.
Dev configs: `deploy/docker/dev/control-plane.{serve,migrate,migrate-audit,sealer,audit-verify}.dev.yaml`.

| Environment variable                    | Read by                    | Effect                                      |
| --------------------------------------- | -------------------------- | ------------------------------------------- |
| `RALYSA_CONFIG`                         | every entry point          | Config file path when `--config` is absent. The resolved path is logged at start (`config_loaded`). **Production pins it** (SEC-F002-12): pass a fixed `--config` in the container command, or mount the file read-only at a path the pod spec sets. Nothing that can change at runtime may choose which file is read. |
| `RALYSA_CFG__<PATH>`                    | every entry point          | Overrides one config value; `__` separates segments (`RALYSA_CFG__DB__HOST=db`). Scalar values only: numbers and `true`/`false` are JSON-parsed, anything else is a string, and a JSON object, array or `null` is **refused**. Validated like the file, so it can't carry a credential. **Refused** for `env`, `vault.auth.*`, `vault.allow_approle`, `trust_proxy_cidrs`, `idp.issuer`, `idp.require_mfa_claim` and `access.mfa_claim_exception_ref`, and for any path above one of them (`RALYSA_CFG__VAULT`, `RALYSA_CFG__IDP`, `RALYSA_CFG__ACCESS`). The names of applied overrides (never the values) are logged at start as `config_overrides`. |
| the one named by `vault.auth.token_env` | token auth (dev/test only) | The OpenBao token.                          |

## Scripts

| Script                             | What it runs                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`                             | Hermetic unit tests (`test/**/*.test.ts`).                                                                                                     |
| `test:integration`                 | `test/integration/**/*.int.ts` against the dev stack (`deploy/docker/dev`, see `tooling/dev-stack`). Each file gets its own migrated database. |
| `migrate`, `migrate:audit`         | The migrate entry points (pass `--config`).                                                                                                    |
| `migrate:dev`, `migrate:audit:dev` | The same against the dev stack, loading `deploy/docker/dev/.env`.                                                                              |
| `start`, `start:dev` | The API (`serve`); the dev variant uses `deploy/docker/dev/control-plane.serve.dev.yaml`. |
| `check:generated` | Builds and rewrites `openapi/control-plane.v1.json`. |

## Runbook: checkpoint key custody violation

**What happened.** Someone set `exportable` or `allow_plaintext_backup` on the Transit key
`ralysa-audit-checkpoint`. OpenBao (like Vault) **cannot turn either flag off again**: a request
to clear it answers 200 and changes nothing (checked on 2.6.2). Assume the private key may
have been exported.

**What the system does.**
- The sealer stops signing checkpoints for good and keeps sealing. It records
  `secret.custody_violation`, and the gauge `secret_custody_violation{key=…}` is 1.
- `audit-verify` refuses to verify with a flagged key and exits 1.
- Checkpoints made while the key was flagged prove nothing.

**Recovery (manual until SEC-F002-35 b–d land).**
1. Treat it as a security incident. Find who flipped the flag in the OpenBao audit device log
   (SEC-F002-11), and preserve the sealer's `audit_checkpoint` log lines (the off-host copy).
2. Run `audit-verify --log-checkpoints <shipped log>` against a restored copy of the key's
   public versions, taken from the log or an earlier `describe`, so history up to the flip can
   still be checked against the logged checkpoints.
3. Recovery by key epoch (a new key name, pinned thumbprints, a checkpoint payload that names
   the key) is designed in SEC-F002-35 (b) and not built yet. Until then, don't recreate a key
   under the same name: the sealer treats a flagged key that later reads as clean as still
   violated and logs `checkpoint_key_clean_after_violation` (SEC-F002-37).
