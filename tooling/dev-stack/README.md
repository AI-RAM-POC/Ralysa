# dev-stack

`@ralysa/dev-stack`: the local development and test stack for the control plane (F-002 design
§8.2, §8.3). `kind: "tooling"`, `shipped: false`.

**Never shipped.** No `shipped: true` workspace may depend on `@ralysa/dev-stack` or on
`oidc-provider`, directly or through another workspace's production dependencies
(`check-workspaces` rule `deps/dev-only-in-shipped`, SEC-F002-13, [AR-12]).

## Commands

The CLI runs on plain Node 24 (type stripping) and needs no installed packages:

```sh
node tooling/dev-stack/src/cli.ts env [--out <file>] [--force] [--github-mask]
docker compose -f deploy/docker/dev/compose.yaml --env-file deploy/docker/dev/.env up -d --wait
node tooling/dev-stack/src/cli.ts bootstrap [--env-file <file>]
```

- **`env`** writes `deploy/docker/dev/.env` with `POSTGRES_PASSWORD` and `BAO_DEV_ROOT_TOKEN_ID`:
  48 random `[A-Za-z0-9]` characters each, mode `0600`. It refuses any path outside
  `deploy/docker/dev/` or not named `.env*`, never overwrites without `--force`, and never writes
  through a symlink. `--github-mask` prints `::add-mask::` lines for GitHub Actions (SEC-F002-29).
- **`bootstrap`** is idempotent:
  - OpenBao: Transit and KV v2 mounts; Transit keys `ralysa-rts-signing`, `ralysa-audit-checkpoint`
    and `ralysa-svc-<service>` (`ecdsa-p256`, `exportable=false`, `allow_plaintext_backup=false`,
    checked after creation); random DB role passwords at `kv/ralysa/control-plane/db/<role>` and
    the audit HMAC key; one ACL policy per entry point (`ralysa-cp-serve`, `-sealer`, `-migrate`,
    `-migrate-audit`, `-verify`; the sealer also reads the insert-only `audit_writer`), per service (`ralysa-svc-<service>`) and `ralysa-operator`, each
    with the explicit custody denies; a dev AppRole per non-operator policy (single-use
    `secret_id`, short TTLs, bound CIDRs).
  - Postgres: checks the UTF-8 server encoding and creates the login roles
    (`ralysa_migrator`, `ralysa_audit_migrator`, `ralysa_cp_app`, `ralysa_audit_writer`,
    `ralysa_audit_reader`, `ralysa_audit_sealer`) with no elevated attributes. Passwords go to
    `psql` over stdin as SCRAM verifiers, never on a command line and never in plaintext.
  - Then `services/control-plane/src/db/sql/bootstrap-roles.sql` over the same stdin: the
    NOLOGIN `ralysa_audit_owner` (reachable only by `SET ROLE` from `ralysa_audit_migrator`),
    database grants, `public` locked, and the superuser-owned DDL event trigger on the audit
    schemas.
  - The migrations are not run here: bootstrap runs before any build, and the migrate commands
    are the control plane's own (`pnpm --filter @ralysa/control-plane migrate:audit:dev`, then
    `migrate:dev`). Integration tests migrate their own databases.

`kubernetesAuthRoles()` in `src/bootstrap-vault.ts` renders the Kubernetes-auth role template for
real deployments: one ServiceAccount, one namespace and an audience per role (SEC-F002-22). F-023
packages it.

## Harness for `test:integration`

`@ralysa/dev-stack/harness` (a devDependency of the workspaces with integration tests):

- `devStackOrSkip()` returns the stack's connection details, or `undefined` after one message
  naming what to start, so the tests skip on a machine without Docker.
- `roleBao(stack, role)` logs in through an entry point's or service's AppRole; `rootBao(stack)`
  is the dev root token (operator actions in tests only); `uniqueName()` gives per-test key names.
- `roleCredentials(stack, role)` returns an AppRole's `role_id` and a fresh single-use `secret_id`
  for adapters that log in themselves; `dbPassword(stack, key)` reads a DB role's password from
  KV; `BOOTSTRAP_ROLES_SQL` is the path of the control plane's DBA script.

| Variable | Effect |
|---|---|
| `RALYSA_REQUIRE_DEV_STACK=1` (or `CI=1`/`CI=true`) | A missing or unbootstrapped stack fails the integration tests instead of skipping them. The CI `integration` job sets it. |

No other environment variables are read.
