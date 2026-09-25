# control-plane

`@ralysa/control-plane`: Profiles, policies, skills, plugins, memory, approvals, audit API.

F-002 builds the Phase 0 slice: the Ralysa Token Service (OIDC relying party toward Entra ID,
OAuth authorization server toward Ralysa clients), users, groups and sessions, the audit store
with its sealer and signed checkpoints, and the governance feed. Design:
[docs/features/F-002-sso-control-plane-skeleton/design.md](../../docs/features/F-002-sso-control-plane-skeleton/design.md).

## Entry points

`node dist/main.js <command>` (bin `control-plane`). Each entry point loads only its own config
schema and logs in to OpenBao as its own role (SEC-F002-02). So far:

| Command | Runs as | Reads from OpenBao |
|---|---|---|
| `migrate --config <file>` | `ralysa_migrator` | `db_credentials.migrator` |
| `migrate --audit --config <file>` | `ralysa_audit_migrator` → `SET ROLE ralysa_audit_owner` (break-glass) | `db_credentials.audit_migrator` |

`serve`, `sealer`, `audit-verify` and `bootstrap-org` arrive with F-002-T06, T07 and T16.

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
env: production            # dev | test | production; unset → production
org: { id: <uuid>, name: …, residency: in_country, region: qa-doha, deployment_model: on_prem }
vault:
  addr: https://openbao.internal:8200
  auth: { method: kubernetes, role: ralysa-cp-migrate }   # jwt_path defaults to the SA token file
  # auth: { method: approle, role_id: …, secret_id_path: /run/secrets/secret-id }  # needs allow_approle in production
  # auth: { method: token, token_env: BAO_DEV_ROOT_TOKEN_ID }                        # dev/test only
  allow_approle: false
db: { host: …, port: 5432, database: ralysa, ssl: true }
db_credentials:            # migrate: migrator + audit_writer; migrate --audit: audit_migrator + audit_writer
  migrator: kv/ralysa/control-plane/db/migrator
  audit_writer: kv/ralysa/control-plane/db/audit_writer
```

In production every entry point refuses to start with token auth, AppRole without
`allow_approle`, a non-`https` vault address or `db.ssl: false`. Dev configs:
`deploy/docker/dev/control-plane.migrate.dev.yaml` and `…migrate-audit.dev.yaml`.

| Environment variable | Read by | Effect |
|---|---|---|
| `RALYSA_CONFIG` | every entry point | Config file path when `--config` is absent. |
| the one named by `vault.auth.token_env` | token auth (dev/test only) | The OpenBao token. |

## Scripts

| Script | What it runs |
|---|---|
| `test` | Hermetic unit tests (`test/**/*.test.ts`). |
| `test:integration` | `test/integration/**/*.int.ts` against the dev stack (`deploy/docker/dev`, see `tooling/dev-stack`). Each file gets its own migrated database. |
| `migrate`, `migrate:audit` | The migrate entry points (pass `--config`). |
| `migrate:dev`, `migrate:audit:dev` | The same against the dev stack, loading `deploy/docker/dev/.env`. |
