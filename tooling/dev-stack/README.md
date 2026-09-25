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
node tooling/dev-stack/src/cli.ts mock-idp [control <METHOD> <path> [json]]   # needs pnpm install
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
    `-migrate-audit`, `-verify`), per service (`ralysa-svc-<service>`) and `ralysa-operator`, each
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

## Mock IdP (`@ralysa/dev-stack/mock-idp`, F-002-T09)

An Entra v2-shaped OpenID provider and Microsoft Graph stub on
[`oidc-provider`](https://github.com/panva/node-oidc-provider) (design §8.3, D-9). Tests start it
in-process; the compose service and the CLI are for manual runs.

```ts
import { approveDeviceCode, signInAtAuthorize, startMockIdp } from '@ralysa/dev-stack/mock-idp';

const idp = await startMockIdp({ deviceCodeTtlSeconds: 10, accessGroupId, adminGroupId });
// idp.issuer, idp.endpoints.*, idp.graphBaseUrl, idp.rtsClientId, idp.cliClientId,
// idp.clientSecret, idp.control.{url,token}; idp.patchUser(), idp.revokeSessions(),
// idp.addClientSecret(), idp.setGraphFault(), idp.mintAccessToken(); await idp.close();
```

- **Per run**: RSA signing key (RS256, `kid` random, never committed), user object ids, the RTS
  client secret, and the test-control bearer [SEC-F002-13 d, e].
- **Paths** are Entra's: issuer `<base>/<tenant>/v2.0` (discovery under it),
  `<base>/<tenant>/oauth2/v2.0/{authorize,token,devicecode,deviceauth}`,
  `<base>/<tenant>/discovery/v2.0/keys`. Graph is at `<base>/graph/v1.0/…`, so
  `idp.graph_base_url` is `<base>/graph`.
- **Clients**: the CLI (public, device code only) and RTS (confidential, `client_secret_post`:
  authorization code with PKCE S256 required, and client credentials for Graph). Any of the
  currently valid RTS secrets is accepted, so two can be valid during a rotation.
- **Tokens**: RS256, header `typ: JWT`, Entra v2 claims (`ver`, `tid`, `oid`, pairwise `sub`,
  `azp`, `scp`, `uti`, `ipaddr`, `amr`, `acrs`, `name`, `preferred_username`, `groups`). Past 200
  groups the token carries `_claim_names`/`_claim_sources` instead. Graph app tokens are Entra v1
  app tokens (`idtyp: app`, `roles`).
- **Device authorization response** as Entra's: `interval` (default 5) and `message`, and no
  `verification_uri_complete`.
- **Sign-in** asks for a fixture username only. There is no password field; MFA is implied by the
  fixture's `amr`. A disabled user is refused with `access_denied`.
- **Fixtures**: alice (access group), bob (no group), carol (disabled), dora (Graph 404), dana
  (admin group only), erin (access + admin, `amr: ["fido"]`, `acrs: ["c1"]`), fatima (Arabic name
  with harakat, Arabic-named group), olga (250 groups: overage), mallory (look-alike group: the
  access group's name, another object id), sam (synced group emitted as `CONTOSO\Ralysa Users`).
- **Graph stub**: `GET /v1.0/users/{id}` (`accountEnabled`, `signInSessionsValidFromDateTime`,
  404), `POST /v1.0/users/{id}/checkMemberGroups`, `POST /v1.0/users/{id}/getMemberObjects`,
  `GET /v1.0/groups/{id}`; app token required. Faults: `error` (any 4xx/5xx), `hang`, and
  `latencyMs`.
- **Headless browser**: `approveDeviceCode()` and `signInAtAuthorize()` play the user's part in
  flows A and B.

**Test-control API** (127.0.0.1 only, `Authorization: Bearer <per-run token>`, JSON bodies
validated with zod):

| Route | Effect |
|---|---|
| `GET /users` | fixture users (no secrets) |
| `PATCH /users/:username` | `enabled`, `deletedInGraph`, `groups`, `groupClaimOverride`, `amr`, `acrs`, `ipaddr`, `displayName` |
| `POST /users/:username/revoke-sessions` | Entra "revoke sessions" |
| `POST /client-secrets` / `DELETE /client-secrets` | add a secret (returned once) / remove `{ secret }` |
| `PUT /graph-fault` | `{ mode: "none" \| "error" \| "hang", status?, latencyMs? }` |
| `POST /tokens` | mint an Entra-shaped token: `{ username, claims?, header?, expiresInSeconds?, signWith?: "idp" \| "foreign" }` |

**Manual runs** use the ids in `deploy/docker/dev/control-plane.serve.dev.yaml`:

```sh
pnpm --filter @ralysa/dev-stack build
docker compose -f deploy/docker/dev/compose.yaml --env-file deploy/docker/dev/.env --profile idp up -d --wait mock-idp
docker compose -f deploy/docker/dev/compose.yaml --env-file deploy/docker/dev/.env exec mock-idp \
  node tooling/dev-stack/dist/mock-idp/main.js control GET /users
# or on the host, without Docker:
node tooling/dev-stack/src/cli.ts mock-idp            # and, in another shell:
node tooling/dev-stack/src/cli.ts mock-idp control POST /client-secrets
```

The RTS client secret is per run: get one with `control POST /client-secrets` and write it to
`kv/ralysa/control-plane/idp-client-secret`.

| Variable (mock IdP process only) | Default | Effect |
|---|---|---|
| `MOCK_IDP_HOST` | `127.0.0.1` | IdP and Graph listener. Must be loopback unless `MOCK_IDP_IN_CONTAINER=1` |
| `MOCK_IDP_IN_CONTAINER` | `0` | Set by the compose service so the listener can bind the container's `0.0.0.0` |
| `MOCK_IDP_PORT` | `59400` | IdP and Graph port |
| `MOCK_IDP_CONTROL_PORT` | `59401` | Test-control port (always bound to 127.0.0.1) |
| `MOCK_IDP_PUBLIC_BASE_URL` | `http://127.0.0.1:59400` | Issuer base; must be a loopback URL |
| `MOCK_IDP_DEVICE_CODE_TTL_S` | `900` | Device-code lifetime |
| `MOCK_IDP_CONTROL_TOKEN_FILE` | `<tmpdir>/ralysa-mock-idp/control-token` | Where the per-run bearer is written (mode 0600; never logged) |

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

The harness reads no other environment variables; the mock IdP's are listed above.
