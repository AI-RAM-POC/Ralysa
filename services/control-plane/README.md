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
  - polls the signing key, replays the audit spool every 30 s, and listens.
- **Routes so far:**

  | Route | What it returns |
  |---|---|
  | `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata |
  | `GET /.well-known/jwks.json` | Public keys from `cp.signing_key_version`, with `Cache-Control: public, max-age=60, must-revalidate` |
  | `GET /v1/auth/config` | The enabled flows and IdP endpoints |
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
| `RALYSA_CONFIG`                         | every entry point          | Config file path when `--config` is absent. |
| `RALYSA_CFG__<PATH>`                    | every entry point          | Overrides one config value; `__` separates segments (`RALYSA_CFG__DB__HOST=db`). JSON-parsed when possible. Validated like the file, so it can't carry a credential. **Refused** for `env`, `vault.auth.*`, `vault.allow_approle`, `trust_proxy_cidrs`, `idp.issuer`, `idp.require_mfa_claim` and `access.mfa_claim_exception_ref`. The names of applied overrides (never the values) are logged at start as `config_overrides`. |
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
