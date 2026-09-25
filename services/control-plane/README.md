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
| `sealer --config <file>` | `ralysa_audit_sealer` (its own process and deployment); `ralysa_audit_writer` for its own `secret.custody_violation` | `db_credentials.audit_sealer`, `.audit_writer`; signs with Transit `ralysa-audit-checkpoint` |
| `audit-verify --config <file> [--org <uuid>] [--shard <s>] [--log-checkpoints <jsonl>]` | `ralysa_audit_reader` (read-only) | `db_credentials.audit_reader`; reads the checkpoint key's public versions |

Both migrate jobs also write one `db.migration.applied` per applied migration (with the
`migrations.lock.json` checksum) through `db_credentials.audit_writer`. If that write fails the
job exits non-zero, saying the migrations were applied but not recorded.

`serve` and `bootstrap-org` arrive with F-002-T07.

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
    `allow_plaintext_backup`. If either is set, checkpoint signing stops (sealing continues),
    `secret.custody_violation` is written once, and the `secret_custody_violation` gauge goes
    to 1.
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
db_credentials: # migrate: migrator + audit_writer; migrate --audit: audit_migrator + audit_writer
  migrator: kv/ralysa/control-plane/db/migrator
  audit_writer: kv/ralysa/control-plane/db/audit_writer
```

In production every entry point refuses to start with token auth, AppRole without
`allow_approle`, a non-`https` vault address or `db.ssl: false`. Dev configs:
`deploy/docker/dev/control-plane.migrate.dev.yaml` and `…migrate-audit.dev.yaml`.

| Environment variable                    | Read by                    | Effect                                      |
| --------------------------------------- | -------------------------- | ------------------------------------------- |
| `RALYSA_CONFIG`                         | every entry point          | Config file path when `--config` is absent. |
| the one named by `vault.auth.token_env` | token auth (dev/test only) | The OpenBao token.                          |

## Scripts

| Script                             | What it runs                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`                             | Hermetic unit tests (`test/**/*.test.ts`).                                                                                                     |
| `test:integration`                 | `test/integration/**/*.int.ts` against the dev stack (`deploy/docker/dev`, see `tooling/dev-stack`). Each file gets its own migrated database. |
| `migrate`, `migrate:audit`         | The migrate entry points (pass `--config`).                                                                                                    |
| `migrate:dev`, `migrate:audit:dev` | The same against the dev stack, loading `deploy/docker/dev/.env`.                                                                              |
