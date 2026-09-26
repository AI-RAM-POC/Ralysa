# control-plane

`@ralysa/control-plane`: Profiles, policies, skills, plugins, memory, approvals, audit API.

F-002 builds the Phase 0 slice: the Ralysa Token Service (OIDC relying party toward Entra ID,
OAuth authorization server toward Ralysa clients), users, groups and sessions, the audit store
with its sealer and signed checkpoints, and the governance feed. Design:
[docs/features/F-002-sso-control-plane-skeleton/design.md](../../docs/features/F-002-sso-control-plane-skeleton/design.md).

**Operator reference.** Start here:

- [Entry points](#entry-points): the commands, the database role and OpenBao policy each one uses,
  and exit codes.
- [Ports](#ports): what listens where, in production and on the dev stack.
- [Configuration reference](#configuration-reference): every key of every entry point's config, its
  default, and the production guards.
- [Entra ID configuration checklist](#entra-id-configuration-checklist): the tenant-side settings
  (design §6.7) and the config key each one feeds.
- [Runbooks](#runbooks): signing key (rotation and pin), IdP client secret, break-glass
  `migrate --audit`, checkpoint key custody violation.

The rest of this file describes what the service does: [the API](#the-api-serve-f-002-t07),
[audit endpoints](#audit-endpoints-f-002-t12), [audit core](#audit-core) and the
[database](#database). Services and clients that call the control plane use
[`@ralysa/auth`](../../packages/auth/README.md).

## Entry points

`node dist/main.js <command>` (bin `control-plane`; the image's entry point is `node dist/main.js`
with `serve --config /etc/ralysa/control-plane.yaml` as the default command). Each entry point loads
only its own config schema and logs in to OpenBao as its own role (SEC-F002-02). The config path is
`--config <file>`, or `RALYSA_CONFIG` when the flag is absent.

| Command | Database role | OpenBao policy (role) | Reads from OpenBao |
| --- | --- | --- | --- |
| `migrate` | `ralysa_migrator` | `ralysa-cp-migrate` | `db_credentials.migrator`, `db_credentials.audit_writer` |
| `migrate --audit` (break-glass) | `ralysa_audit_migrator` → `SET ROLE ralysa_audit_owner` | `ralysa-cp-migrate-audit` | `db_credentials.audit_migrator`, `db_credentials.audit_writer` |
| `serve` | `ralysa_cp_app`, `ralysa_audit_writer`, `ralysa_audit_reader` (the audit query and the client path's duplicate check) | `ralysa-cp-serve` | `db_credentials.*`, `idp.client_secret_path`, `audit_hmac_path`; signs tokens with Transit `ralysa-rts-signing`; reads `ralysa-svc-*` public keys |
| `bootstrap-org` (the serve config) | `ralysa_cp_app` | `ralysa-cp-serve` | `db_credentials.cp_app` |
| `sealer` (its own process and deployment) | `ralysa_audit_sealer` | `ralysa-cp-sealer` | `db_credentials.audit_sealer`; signs with Transit `ralysa-audit-checkpoint` |
| `audit-verify [--org <uuid>] [--shard <source>] [--log-checkpoints <jsonl>]` | `ralysa_audit_reader` (read-only) | `ralysa-cp-verify` | `db_credentials.audit_reader`; the checkpoint key's public versions |

The OpenBao policies, and the explicit denies every non-operator policy carries, are in design
§6.5. The dev stack creates them (`tooling/dev-stack/src/bootstrap-vault.ts`).

`audit-verify` options: `--org` checks another org id than `org.id`; `--shard` checks one audit
source only (`control-plane`, `model-gateway`, `mcp-gateway`, `workspace-runtime`,
`agent-host-server`, `agent-host-local`); `--log-checkpoints` compares the table with the shipped
`audit_checkpoint` log lines (JSON Lines).

Both migrate jobs also write one `db.migration.applied` per applied migration (with the
`migrations.lock.json` checksum) through `db_credentials.audit_writer`. If that write fails the
job exits non-zero, saying the migrations were applied but not recorded.

**Exit codes.** `0` success; `1` a runtime failure (an unknown option counts as one), or
`audit-verify` findings (including a checkpoint key custody violation); `2` a usage or config error
(an unknown command, no config path, an invalid config, a production-guard refusal, a signing key
that violates custody at `serve` start, an invalid `--shard` value). Every failure writes one JSON
error line naming the command, except an unknown command, which prints the plain-text usage to
stderr.

## Ports

| Process | Listens on | Notes |
| --- | --- | --- |
| `serve` | `listen.host`:`listen.port` (HTTP) | The image `EXPOSE`s 4100. TLS terminates in front of it: `public_base_url` must be `https://` in production, and `trust_proxy_cidrs` names the proxies whose `X-Forwarded-For` is believed. `/healthz` and `/readyz` are on the same port; there is no separate admin or metrics port yet. |
| `sealer`, `migrate`, `migrate --audit`, `audit-verify`, `bootstrap-org` | nothing | Outbound only: Postgres (`db.host`:`db.port`) and OpenBao (`vault.addr`). |

Outbound from `serve`: Postgres, OpenBao, the Entra issuer's origin (discovery, keys, token
endpoint) and `idp.graph_base_url` (Microsoft Graph), all over HTTPS in production.

Dev stack (`deploy/docker/dev`; every published port is bound to 127.0.0.1): `serve` 4100
(`control-plane.serve.dev.yaml`), Postgres 55432, OpenBao 58200, the mock IdP and Graph stub 59400.

## Configuration reference

A YAML file per entry point (`--config`, or `RALYSA_CONFIG`), validated by that entry point's
strict schema in `src/config/schema.ts` (the source of truth for this section). A config holds
identifiers and OpenBao **paths** only. An unknown key fails validation, and so does a credential
field whose value isn't a KV path. Validation messages name the field and the rule, never the
value. Dev configs: `deploy/docker/dev/control-plane.{serve,migrate,migrate-audit,sealer,audit-verify}.dev.yaml`.

**KV path** (every `db_credentials.*`, `idp.client_secret_path`, `audit_hmac_path`): matches
`<kv mount>/ralysa/control-plane/<path>` (lower-case letters, digits, `_`, `-`, `/`), and the first
segment must equal `vault.kv_mount`.

```yaml
# The keys every entry point shares, then the ones for this entry point (here: migrate).
env: production # dev | test | production; unset → production
org: { id: <uuid>, name: …, residency: in_country, region: qa-doha, deployment_model: on_prem }
vault:
  addr: https://openbao.internal:8200
  auth: { method: kubernetes, role: ralysa-cp-migrate } # jwt_path defaults to the SA token file
  # auth: { method: approle, role_id: …, secret_id_path: /run/secrets/secret-id }  # needs allow_approle in production
  # auth: { method: token, token_env: BAO_DEV_ROOT_TOKEN_ID }                        # dev/test only
  allow_approle: false
db: { host: …, port: 5432, database: ralysa, ssl: true }
db_credentials:
  migrator: kv/ralysa/control-plane/db/migrator
  audit_writer: kv/ralysa/control-plane/db/audit_writer
```

### Keys every entry point shares

| Key | Rule | Default | Notes |
| --- | --- | --- | --- |
| `env` | `dev`, `test` or `production` | `production` | Switches the production guards on. Can't be overridden. |
| `org.id` | UUID | required | The one Organization (ADR-0003). Unauthenticated routes act in it; a request never selects the org. |
| `org.name` | 1–200 characters | required | |
| `org.residency` | `in_country` or `in_region` | required | Fixed once the Organization exists (`serve`, `bootstrap-org` refuse a change). |
| `org.region` | `[a-z0-9-]{2,40}`, e.g. `qa-doha` | required | Fixed once the Organization exists. |
| `org.deployment_model` | `dedicated`, `on_prem` or `air_gapped` | required | Fixed once the Organization exists. |
| `vault.addr` | URL | required | `https://` in production. |
| `vault.auth.method` | `kubernetes`, `approle` or `token` | required | One of the three shapes below. |
| `vault.auth.role` (kubernetes) | `[a-z0-9-]{1,64}` | required | The entry point's OpenBao role, e.g. `ralysa-cp-serve` (see [Entry points](#entry-points)). |
| `vault.auth.jwt_path` (kubernetes) | path | `/var/run/secrets/kubernetes.io/serviceaccount/token` | The ServiceAccount token file. |
| `vault.auth.role_id` (approle) | 1–128 characters | required | Production needs `vault.allow_approle: true`. |
| `vault.auth.secret_id_path` (approle) | path | required | A file holding the unwrapped `secret_id`, written by the platform, mode 0600. |
| `vault.auth.token_env` (token) | `[A-Z][A-Z0-9_]{0,63}` | required | The **name** of the environment variable holding the token. Refused in production. |
| `vault.allow_approle` | boolean | `false` | Can't be overridden. |
| `vault.transit_mount` | `[a-z0-9_-]{1,64}` | `transit` | |
| `vault.kv_mount` | `[a-z0-9_-]{1,64}` | `kv` | Every KV path must start with it. |
| `db.host` | 1–255 characters | required | |
| `db.port` | 1–65535 | required | |
| `db.database` | `[a-z_][a-z0-9_]{0,62}` | required | The server must be UTF-8. |
| `db.ssl` | boolean | required | `true` in production. |

### `migrate` and `migrate --audit`

| Key | Rule | Notes |
| --- | --- | --- |
| `db_credentials.migrator` (`migrate`) | KV path | Password of `ralysa_migrator`. |
| `db_credentials.audit_migrator` (`migrate --audit`) | KV path | Password of `ralysa_audit_migrator` (break-glass). |
| `db_credentials.audit_writer` (both) | KV path | For the `db.migration.applied` events. |

The two jobs have separate schemas: a `migrate` config can't name `audit_migrator`, and a
`migrate --audit` config can't name `migrator`.

### `sealer`

| Key | Rule | Default | Notes |
| --- | --- | --- | --- |
| `checkpoint_key` | exactly `ralysa-audit-checkpoint` | required | The Transit key that signs checkpoints. |
| `interval_ms` | 100–60,000 | `1000` | Sealing pass per shard. |
| `sweep_interval_s` | 60–86,400 | `3600` | The sweep without lookback. |
| `checkpoint_interval_s` | 1–3600 | `60` | `audit-verify` flags gaps over 120 s. |
| `custody_poll_s` | 1–300 | `30` | Re-reads the checkpoint key's custody flags. |
| `db_credentials.audit_sealer` | KV path | required | The sealer's only credential (no writer credential, SEC-F002-34). |

### `audit-verify`

| Key | Rule | Notes |
| --- | --- | --- |
| `checkpoint_key` | exactly `ralysa-audit-checkpoint` | Public versions only. |
| `db_credentials.audit_reader` | KV path | Read-only. |

Command-line options are under [Entry points](#entry-points).

### `serve` and `bootstrap-org`

`bootstrap-org` reads the same file as `serve` and uses only the common keys and
`db_credentials.cp_app`, but the whole file must validate.

| Key | Rule | Default | Notes |
| --- | --- | --- | --- |
| `public_base_url` | URL | required | The token issuer (`iss`) and the base of every RTS URL, including the IdP redirect `<public_base_url>/oauth2/idp/callback`. `https://` in production. |
| `listen.host` | non-empty | required | |
| `listen.port` | 0–65535 | required | See [Ports](#ports). |
| `trust_proxy_cidrs` | list of CIDRs | `[]` | Proxies whose `X-Forwarded-For` is believed. No `0.0.0.0/0` or `::/0` in production. Can't be overridden. |
| `signing_key` | exactly `ralysa-rts-signing` | required | Tokens carry `kid` `ralysa-rts-signing.v<n>`. |
| `idp.kind` | `entra` | required | |
| `idp.tenant_id` | UUID | required | The Entra tenant (directory) id. |
| `idp.issuer` | URL | required | Exactly `https://login.microsoftonline.com/<tenant_id>/v2.0` in production. Discovery is fetched from here only. Can't be overridden. |
| `idp.rts_client_id` | UUID | required | The RTS app registration's client id; the Entra token's `aud`. |
| `idp.allowed_public_client_ids` | list of UUIDs, at least one | required | The CLI app registration's client id; the Entra token's `azp`. |
| `idp.signin_scope` | 1–200 characters | required | The full scope URI the RTS app exposes, e.g. `api://<app id URI>/Ralysa.SignIn`. RTS checks the part after the last `/` in `scp`, and `/v1/auth/config` hands the full value to the CLI. |
| `idp.client_secret_path` | KV path | required | The RTS client secret (see the [IdP client-secret runbook](#runbook-rotating-the-idp-client-secret-sec-f002-10)). |
| `idp.client_secret_poll_s` | 1–300 | `60` | How often each replica re-reads the client secret. |
| `idp.graph_base_url` | URL | required | Exactly `https://graph.microsoft.com` in production (a trailing `/` is allowed). |
| `idp.graph_timeout_ms` | 100–3000 | `3000` | One deadline per Graph check. |
| `idp.require_mfa_claim` | boolean | unset: `true` in production, `false` otherwise | MFA evidence: `amr` contains `mfa` or `acrs` is non-empty, else `failure mfa_claim_missing`. `false` in production needs `access.mfa_claim_exception_ref` (Q5). Can't be overridden. |
| `access.access_group_id` | UUID | required | Object id of the group that may use Ralysa (role `user`). |
| `access.admin_group_id` | UUID | required | Object id of the admin group (role `platform_admin`, strong sign-in only). |
| `access.device_code_enabled` | boolean | `true` | Flow A. `false` revokes every live flow-A session at start. The config is authoritative in Phase 0 (D-30). |
| `access.loopback_ip_mismatch` | `deny` or `alert` | `deny` | Flow B: redemption IP differs from the callback IP. |
| `access.admin_auth_context` | up to 64 characters | unset | An Entra authentication context id (for example `c1`); `acrs` containing it makes a flow-A sign-in strong. |
| `access.phishing_resistant_amr` | list of strings | `['fido', 'wia']` | `amr` values that make a flow-A sign-in strong. To confirm against the real tenant (TC-F-002-28). |
| `access.mfa_claim_exception_ref` | 1–100 characters | unset | A documented exception id; required to run production with `idp.require_mfa_claim: false`. Can't be overridden. |
| `tokens.access_ttl_s` | 60–3600 | `900` | User access-token lifetime. |
| `tokens.service_ttl_s` | 60–900 | `300` | Service-token lifetime. |
| `tokens.refresh_idle_s` | integer | `43200` (12 h) | Refresh-token idle expiry. |
| `tokens.refresh_absolute_s` | integer | `604800` (7 d) | Session absolute expiry. |
| `tokens.key_poll_s` | 1–300 | `30` | Signing-key poll. |
| `tokens.activation_delay_s` | 0–3600 | `120` | Publish-to-activate delay for a new signing-key version. |
| `tokens.signing_key_pin_version` | integer ≥ 1 | unset | Rollback pin (see the [signing-key runbook](#runbook-rotating-the-rts-signing-key-ac-10)). |
| `rate_limits.per_ip_per_minute` | integer ≥ 1 | `60` | On `/oauth2/*`, `/v1/auth/*`, `/.well-known/*`, per client IP (IPv6 per /64). |
| `rate_limits.global_per_minute` | integer ≥ 1 | `1200` | The same routes, per instance. |
| `audit.spool_dir` | non-empty | `/var/lib/ralysa/audit-spool` | A dedicated `0700` directory on a persistent volume. |
| `audit.spool_persistent` | boolean | `true` | `false`: no persistent volume, loss on restart accepted (SEC-F002-24). |
| `audit_hmac_path` | KV path | required | The HMAC key for `attempted_identifier_hmac`. |
| `db_credentials.cp_app`, `.audit_writer`, `.audit_reader` | KV paths | required | A migrator or sealer path fails validation. |
| `services[].name` | `[a-z][a-z0-9-]{1,40}`, unique | `[]` | A service allowed to get service tokens. Only `model-gateway`, `mcp-gateway`, `workspace-runtime` and `agent-host` have an audit source; another name can call the internal routes but write no audit (`service_without_audit_source` at start). |
| `services[].client_id` | exactly `svc:<name>` | | |
| `services[].transit_key` | exactly `ralysa-svc-<name>` | | The key the service signs its client assertion with. |
| `services[].audit_actions` | at least one `a.b[.c[.d]]` | | Actions it may write through `POST /v1/audit/events`. Reserved namespaces are refused except `auth.token_rejected` and `secret.rotated`. |

### Production guards

With `env: production` an entry point refuses to start (exit 2) and names each setting, never a
value:

- **Every entry point** (`serve`, `bootstrap-org`, `migrate`, `migrate --audit`, `sealer`,
  `audit-verify`): `vault.auth.method: token`; `approle` without `vault.allow_approle`; a
  `vault.addr` that isn't `https://`; `db.ssl: false`; and OpenBao `sys/seal-status` at
  `vault.addr` reporting in-memory storage (a dev server), sealed, or unreachable (checked with a
  3 s timeout, before any OpenBao login or database connection). `vault.addr` may be overridden
  with `RALYSA_CFG__VAULT__ADDR`, and a dev server can serve TLS, so the seal-status check is what
  keeps a dev OpenBao away from the sealer's Transit key and `audit-verify`'s public keys (#41).
- **`serve` and `bootstrap-org` also:** a `public_base_url` that isn't `https://`; an `idp.issuer`
  other than `https://login.microsoftonline.com/<tenant_id>/v2.0`; an `idp.graph_base_url` other
  than `https://graph.microsoft.com`; `0.0.0.0/0` or `::/0` in `trust_proxy_cidrs`;
  `idp.require_mfa_claim: false` without `access.mfa_claim_exception_ref`.
- **`serve` only:** in every environment, a Transit `ralysa-rts-signing` key that is `exportable`
  or allows plaintext backup.

A process that can't reach `vault.addr/v1/sys/seal-status` within 3 s at start doesn't start in
production (fail closed); the endpoint is unauthenticated, so the network path is all it needs.

### Environment variables

| Environment variable | Read by | Effect |
| --- | --- | --- |
| `RALYSA_CONFIG` | every entry point | Config file path when `--config` is absent. **Production pins it** (SEC-F002-12): pass a fixed `--config` in the container command, or mount the file read-only at a path the pod spec sets. Nothing that can change at runtime may choose which file is read. |
| `RALYSA_CFG__<PATH>` | every entry point | Overrides one config value; `__` separates segments (`RALYSA_CFG__DB__HOST=db`). Scalar values only: numbers and `true`/`false` are JSON-parsed, anything else is a string, and a JSON object, array or `null` is **refused**. Validated like the file, so it can't carry a credential. **Refused** for `env`, `vault.auth.*`, `vault.allow_approle`, `trust_proxy_cidrs`, `idp.issuer`, `idp.require_mfa_claim` and `access.mfa_claim_exception_ref`, and for any path above one of them (`RALYSA_CFG__VAULT`, `RALYSA_CFG__IDP`, `RALYSA_CFG__ACCESS`). The production guards still apply to overridable values. |
| the one named by `vault.auth.token_env` | token auth (dev/test only) | The OpenBao token. |
| `RALYSA_SOAK_REPORT`, `RALYSA_SOAK_DURATION_MS` | `test:soak` only | See [Scripts](#scripts). |

Every entry point writes one `config_loaded` line at start with the resolved config file path and,
in `overrides`, the names (never the values) of the `RALYSA_CFG__*` overrides it applied.

## Entra ID configuration checklist

What the Entra tenant needs before `serve` can sign anyone in (design §6.7; external blocker E-1
for the test tenant). The development stack and CI use the mock IdP instead
(`tooling/dev-stack`); the real tenant is exercised by TC-F-002-28.

| Item | Setting in Entra | Feeds config |
| --- | --- | --- |
| **RTS app registration** (web, confidential) | Redirect URI `<public_base_url>/oauth2/idp/callback`. A client secret with a lifetime of **at most 180 days**, its expiry recorded in the [register](#runbook-rotating-the-idp-client-secret-sec-f002-10) (SEC-F002-10). Expose the scope `Ralysa.SignIn`. Manifest `requestedAccessTokenVersion: 2`. Groups claim "Groups assigned to the application" for ID and access tokens. Optional claims `email` and `ipaddr` (SEC-F002-05). | `idp.tenant_id`, `idp.issuer`, `idp.rts_client_id`, `idp.signin_scope`, `idp.client_secret_path` (the value goes to KV, never to config) |
| **Graph application permissions** | `User.Read.All` and `GroupMember.Read.All` with **admin consent** (Q3). Where licensed: Conditional Access for workload identities or a named-location restriction on the service principal; Graph activity logs enabled (SEC-F002-10). A separate app registration for the Graph reads is recommended but not supported by the config yet (implementation notes T13-5). | `idp.graph_base_url`, `idp.graph_timeout_ms` |
| **CLI app registration** (public client) | "Allow public client flows" on (device code). Delegated permission to the RTS app's `Ralysa.SignIn`. | `idp.allowed_public_client_ids` |
| **Groups** | The access group and the admin group, referenced by **object id** (SEC-F002-08). | `access.access_group_id`, `access.admin_group_id` |
| **Conditional Access** | MFA required for both apps. For the admin group: a phishing-resistant authentication strength and an authentication context (TM-49, SEC-F002-06). Device code allowed only from named locations or compliant devices, or blocked (CQ-02, SEC-F002-05). | `idp.require_mfa_claim`, `access.admin_auth_context`, `access.phishing_resistant_amr`, `access.device_code_enabled` |
| **Test users** (test tenant) | In-group, not-in-group, disabled, deleted, admin, and an Arabic-named user in an Arabic-named group. | none (TC-F-002-28) |

Microsoft references (accessed 2026-09-25, design §6.7):
[app manifest](https://learn.microsoft.com/en-us/entra/identity-platform/reference-microsoft-graph-app-manifest),
[optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference),
[credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials),
[Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference),
[device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code),
[Conditional Access authentication flows](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-authentication-flows).

**Still to confirm against a real tenant** (TC-F-002-28, blocked on E-1):

- Q4: whether `ipaddr` in a device-flow access token is the approving browser's address or the
  polling client's. Until then a flow-A mismatch only alerts (`auth_device_ip_mismatch`).
- Q5: whether `amr` and `acrs` are reliably present in v2 access and ID tokens. Until then
  `idp.require_mfa_claim` stays on by default in production (the fail-safe choice): if the claims
  turn out to be missing, every sign-in fails `mfa_claim_missing` rather than admitting users
  without MFA evidence. The test report records this as an exception to revisit at TC-28.
- The `amr` values Entra sends for phishing-resistant methods (`access.phishing_resistant_amr`),
  and whether Conditional Access blocks device code in the test and pilot tenants (E-2).

## The API (`serve`, F-002-T07)

- **Start-up.** The entry point:
  - applies the production guards (common and serve-only, see
    [Production guards](#production-guards)), including the OpenBao `sys/seal-status` check;
  - refuses a signing key that is `exportable` or allows plaintext backup;
  - creates or checks the Organization (region, residency and deployment model can't change;
    `access.device_code_enabled` is copied into its settings);
  - with `access.device_code_enabled: false`, revokes every live flow-A session (`flow =
    idp_device`) with `auth.session.revoked cause=device_code_disabled` and logs
    `device_code_disabled` with the count. This runs on every start, so a switch turned off while
    the service was down takes effect too (SEC-F002-32, D-30);
  - polls the signing key, starts the IdP client-secret watcher, replays the audit spool every
    30 s, runs the session cleanup and the client-session sweep every minute, and listens;
  - logs `service_without_audit_source` for a registered service whose name has no audit source
    (see "Audit endpoints"): such a service can use the internal routes but write no audit;
  - writes the `config_loaded` line, like every entry point (see
    [Environment variables](#environment-variables)).
- **Routes:**

  | Route | What it returns |
  |---|---|
  | `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata |
  | `GET /.well-known/jwks.json` | Public keys from `cp.signing_key_version`, with `Cache-Control: public, max-age=60, must-revalidate` |
  | `GET /v1/auth/config` | The enabled flows and IdP endpoints |
  | `GET /oauth2/authorize` | Flow B leg 1: sets the browser-binding cookie and redirects to the IdP (T10) |
  | `GET /oauth2/idp/callback` | Flow B leg 2: redirects to the CLI's loopback with a single-use `rly_ac_` code, or an OAuth error (T10) |
  | `POST /oauth2/token` | `authorization_code` with PKCE and token exchange of an IdP device-flow token (T10), `refresh_token` and `client_credentials` (T08) |
  | `POST /v1/auth/sign-in-failures` | 202: the CLI's report of an IdP-side flow-A failure, audited as `auth.sign_in failure` (T10) |
  | `POST /oauth2/revoke` | RFC 7009 sign-out: revokes the refresh token's whole session; always 200 |
  | `GET /v1/me` | The signed-in user, the calling session's roles and the user's groups (user token) |
  | `GET /v1/internal/principals/:user_id[?sid=]` | A user's status, directory roles and groups; with `sid`, also `session_roles` (that session's roles ∩ current memberships), the roles PEPs authorize on. An unknown, foreign, revoked, pending or expired `sid` is 403 (service token; #47) |
  | `GET /v1/internal/governance` | Revocations, kill switches and `epoch` for every PEP (service token) |
  | `POST /v1/audit/events` | 201: service audit ingestion within the service's action allow-list (service token, T12) |
  | `POST /v1/audit/client-events` | 201 (or 423 when a kill-switch halts an intent): client-attested local-tool audit with intent acks (user token, T12) |
  | `GET /v1/audit/events` | An audit page for a platform admin, after `audit.query` is committed (user token, T12) |
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
  - `/v1/me` and the audit routes check the user token against revocation in the database, not
    through the feed. Since T12 the control plane uses `@ralysa/auth`'s verifiers (user and
    service tokens) over its own JWKS rows with a database `RevocationSource`; the Bearer scheme
    is case-insensitive, and an unreadable key set answers 503.
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
    `checkMemberGroups` for exactly `access.access_group_id` and `access.admin_group_id`
    (one `graph_timeout_ms` deadline per check, token and secret read included). Graph
    decides membership, whatever the token's `groups` claim says; non-GUID claim values are
    ignored (`idp_group_claims_ignored_total`) and `_claim_sources` is never followed. `404` is a
    deleted user (denied, and a known user is disabled and revoked). Every call is bounded by
    `idp.graph_timeout_ms` (≤ 3 s). After 5 consecutive failures the circuit opens for 30 s.
    Graph is called with an app-only token from the tenant's token endpoint, using the client
    secret from the secret watcher (see the IdP client-secret runbook). Group display names
    are read for display only (2 s, 20 per sign-in, refreshed daily).
  - **Roles** (`identity-mapping.ts`): `user` for the access group; `platform_admin` for the
    admin group only on a strong sign-in (flow B, `acrs` with `access.admin_auth_context`, or
    `amr` in `access.phishing_resistant_amr`). A user in both groups on a weak sign-in gets
    `user` with `admin_role_withheld`; an admin-only user is denied
    `admin_requires_strong_flow`. Other audiences than `control-plane` need `user`.
  - **Roles a PEP sees** (design §3.4.2, §6.1, revision 10; #47, SEC-F002-42):
    `Principal.roles` are directory roles, from the user's current memberships of the two
    configured groups, and are **never enough on their own for `platform_admin`**.
    `Principal.session_roles` (with `?sid=`) are the session's roles ∩ those memberships:
    PEPs authorize on them, and `GET /v1/audit/events` applies the same rule
    (`src/directory/membership.ts`). A device-code sign-in of an admin therefore has no
    `platform_admin` for its `sid`, whatever its memberships.
  - **Memberships follow Graph at every refresh**: the refresh grant writes Graph's answer for
    the two configured groups back to `cp.group_membership` (`source = graph_check`), and a
    change writes `directory.group_membership.changed` (`privileged: true` when the admin
    group changed). A removal in Entra reaches `Principal` at the user's next refresh.
  - **Group roles follow config at start**: `serve` reconciles `cp.idp_group.role` with
    `access.access_group_id` and `access.admin_group_id` before it serves, so after changing
    either id the old group loses its role at the restart, not at someone's next sign-in. Each
    change writes `directory.group_role.changed` (actor `rts`, `details.from`, `to`,
    `cause: config`, `privileged` when `platform_admin` is involved) through the spool-backed
    path, and `group_roles_reconciled` is logged. Changing either id is a reviewed deployment
    change (design §6.2); expect two privileged events on the first start of a new org.
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
    These limits are **per serve instance** (in memory): N replicas allow up to N × 60 events a
    minute. A shared limiter needs Redis (F-012).
  - A tenant key-set fault (discovery or JWKS unreachable) is `error idp_unavailable` with 503;
    the IdP token is not burned, so the client can retry.
  - Group memberships: a token with a group list replaces the user's memberships. A token with
    overage markers or no `groups` claim only updates the Graph-checked ones.
  - Display text keeps ZWNJ/ZWJ (Persian, Urdu, emoji) and strips ZWSP, the word joiner and BOM.
- **Sign-in, flow B** (`/login --browser`; F-002-T10; `src/auth/flow-b.ts`,
  `grants/authorization-code.ts`, `idp/oidc-client.ts` on `openid-client`):
  - `/oauth2/authorize` accepts only `client_id=ralysa-cli` and an IP-literal loopback
    `redirect_uri` (`http://127.0.0.1:<port>/callback` or `[::1]`). Anything else about those two
    is never redirected: the answer is `400 text/plain` with the English and Arabic sentences for
    `auth.error.invalid_authorize_request` (`src/i18n/{en,ar}.json`; the Arabic is marked
    `needs-native-review` in `src/i18n/review.json`). Other bad parameters go back to the
    loopback as `invalid_request`.
  - It stores the request for 10 minutes with the authorize IP, sets the browser-binding cookie
    `__Host-rts_tx_<id>` (Secure, HttpOnly, SameSite=Lax, Path=/, 10 min; `<id>` is derived from
    RTS's state, so concurrent flows in one browser don't collide; `rts_tx_<id>` without Secure
    only outside production on plain-http loopback), and redirects to the IdP with RTS's own state, nonce and
    PKCE (scope `openid profile email`).
  - `/oauth2/idp/callback` consumes the request with one `DELETE … RETURNING` and requires the
    cookie (else `auth.sign_in failure browser_binding_failed` and a plain-text 400: this browser
    didn't start the flow). It redeems the IdP code with the client secret from the secret
    watcher (openid-client
    checks state, nonce, PKCE and the ID token), applies the pinned ID-token rules, MFA
    evidence, Graph and the access decision, and creates a **pending** session and a 60-second
    `rly_ac_` code bound to the client, the exact redirect URI, the CLI's PKCE challenge and the
    callback IP. Refusals are redirected with `error=access_denied` (or `temporarily_unavailable`)
    and `error_description=<SignInReason>`. Responses carry `Cache-Control: no-store` and
    `Referrer-Policy: no-referrer`.
  - **Redemption** (`authorization_code`): the code is consumed only by a matching client,
    redirect URI and `code_verifier` (a mismatch leaves it for its owner); a second redemption
    revokes the session (`auth.token.reuse_detected`). The redemption IP must equal the callback
    IP: with `access.loopback_ip_mismatch: deny` (default) the pending session is revoked and
    `auth.sign_in denied loopback_ip_mismatch` written; with `alert` the sign-in succeeds with
    `details.ip_mismatch: true`, `auth_loopback_ip_mismatch_total` and an
    `auth_loopback_ip_mismatch` log line. **`auth.sign_in success` is written here**, fail-closed,
    not at the callback; a code never redeemed is recorded by cleanup as `code_not_redeemed`, and
    a redeemed code whose session is still pending 5 minutes after expiry (a crash mid-redemption)
    as `error internal_error` (`redemption_incomplete`). Every flow-B event carries
    `authorize_ip`, and redemption also `callback_ip` and `client_ip`. On dual-stack hosts,
    `deny` can refuse a genuine sign-in reached over two IP families; `alert` is the fallback.
  - Flow B is a strong sign-in: members of the admin group get `platform_admin`.
- **Org source** (SEC-F002-31): unauthenticated routes act in `config.org.id`. A header, host,
  path or body never selects the org.

## Audit endpoints (F-002-T12)

- **`POST /v1/audit/events`** (services, AC-11). A registered service's token only; a user token
  or an unregistered service is 403 (recorded as `auth.token_rejected wrong_token_use`).
  - 1–100 events and 256 KB per body; each event must pass the envelope schema, I-JSON `details`
    and the `failure`-on-`auth.*`-only rule (else 422), and a user `actor.user_id` must exist in
    the org (422). Every `event_id` must be a lower-case **version 7** UUID, here and on the client
    path (else 422): the server derives version 8 ids for its own idempotent events
    (`secret.rotated observed`, sign-in failure reports, client-session events), and no external
    writer may claim one first (R35-1).
  - **Allow-list** (SEC-F002-03): every action must be in the service's `services[].audit_actions`
    and outside the reserved namespaces (`auth.`, `audit.`, `secret.`, `directory.`, `db.`,
    `policy.`, `kill_switch.`; only `auth.token_rejected` and `secret.rotated` may be listed).
    Otherwise the whole batch is 403 and one `audit.ingest_rejected` (`details.service`,
    `details.action`) is written per disallowed action.
  - **Source** comes from the service name, never the body: `model-gateway`, `mcp-gateway`,
    `workspace-runtime`, and `agent-host` → `agent-host-server`. A registered service with any
    other name has no audit source: its batches are 403 (`audit.ingest_rejected`,
    `reason_code = no_audit_source`).
  - A `service` actor must be the calling service itself, and a `system` actor is refused (422).
  - Each event is a plain `INSERT` in a savepoint as `ralysa_audit_writer` (a repeated `event_id`
    is `duplicate`), all within 250 ms, else 503 `audit_unavailable` and nothing is stored.
  - **Rejection reports**: `auth.token_rejected` events from a verifying service (built by
    `@ralysa/auth`'s `createRejectionReporter`, `details` = `TokenRejectedReportDetails`) are not
    inserted as sent. They go to a per-service aggregator (`src/audit/service-rejections.ts`): the
    first 20 per client /24 or /64, reason and audience a minute are written individually, the
    rest summarised with `suppressed_count`, at most 600 individual events per service a minute;
    `dropped_count` reports go to the overflow summary. They are answered `aggregated` (or
    `duplicate` for a report id seen in the last 10 minutes on this instance), and stored under
    the service's source, never blocking the report.
- **`POST /v1/audit/client-events`** (the local Agent Host, AC-16), user token (`aud =
  control-plane`):
  - The actor, org, `source = agent-host-local`, `attestation = client`, `surface` and `ts` are
    the server's. Client data goes under `details.client`, server facts under `details.server`;
    a reserved key in the client data is 422. Display strings lose bidi and control characters.
  - Only the client allow-list (422 otherwise), 1–50 events, 4 KB per event in canonical form
    (413), 256 KB per body (413).
  - **Sessions:** a batch without `session_id` must start with `session.started` and gets a new
    session bound to the token's `sid`. An unknown, another user's, another `sid`'s or an ended
    session is 409 (a retry made only of stored events is still answered). A retried opening
    batch whose `session.started` is already stored continues that session. At most 20 open
    sessions per `sid` (429).
  - **`client_seq`** per session: a jump is stored with `details.server.seq_gap` and the range is
    kept open; an event inside an open range is stored with `details.server.late = true`; any
    other seq at or below the last is 409; a repeated `event_id` is `duplicate`. At
    `session.ended` every open range, and the tail up to `final_seq`, becomes one
    `audit.client_seq_gap`.
  - **Intents:** every `tool.call.requested` gets an `IntentAck` with the governance epoch. While
    an active kill-switch covers the tenant, the user's department, or the host-declared
    `details.client.pack_id` / `agent_id`, the intent is stored as `tool.call.denied`
    (`reason_code = kill_switch`) and the answer is 423 with `halted = true`.
  - **Fail closed:** if the insert fails or exceeds 250 ms, nothing is stored or advanced and the
    answer is 503 `audit_unavailable` with `acks` (`ack = false` for every intent).
  - 600 events a minute per user (per instance), then 429 with `Retry-After`. A null `outcome`
    (an intent, a session event) is stored as `success` with `details.server.outcome_defaulted`;
    a client `failure` outside `auth.*` is 422. A retried event already stored in this session
    still advances the cursor (its write may have committed after a 503), and a retried intent
    that was stored as `tool.call.denied` stays refused.
  - **Sweep** (every minute, `FOR UPDATE SKIP LOCKED`): open gaps idle for 15 minutes become final
    `audit.client_seq_gap` events; a session idle for 24 hours without `session.ended` gets
    `audit.client_session_unterminated` and is closed. Event ids are derived from the session and
    range, so a retried pass writes nothing twice.
- **`GET /v1/audit/events`** (AC-12): `from` and `to` (at most 31 days), `user_id`, `action`,
  `outcome`, `limit` (1–500, default 100), `cursor` (keyset on `ts`, `event_id`). It needs the
  **session** role `platform_admin` and a current admin-group membership, checked before the
  parameters are validated and both read at request
  time. `audit.query success` (the filters and the policy version) is committed **before** any
  result is read; if it can't be, the answer is 503. A non-admin gets 403 after
  `audit.query denied not_platform_admin`. Reads use `ralysa_audit_reader` in a read-only
  transaction; each event carries its seal (`shard`, `seq`) once sealed. `Cache-Control:
  no-store`. Paging is not a snapshot: `ts` is set at insert and a row becomes visible at commit,
  so an event whose write commits late with a `ts` before the last key of a page already read is
  not on the next page; re-running the query over the same range returns every committed event
  (R33-9; exports page on `ingest_seq` in F-011).
- No `PUT`, `PATCH` or `DELETE` exists under `/v1/audit`. The per-instance limits (the client
  rate limit, the rejection caps, the report de-duplication) multiply with replicas; a shared
  limiter needs Redis (F-012). No new configuration or environment variables.

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
- **Metrics and logs** go through small interfaces in `src/observability/`. Logs are JSON lines
  (pino in `serve`). No metrics exporter is wired yet: the counters and gauges named in this file
  go to a no-op sink (status.md open item, R29-n5), so alert rules key on the log lines named
  next to them.

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

## Scripts

| Script                             | What it runs                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`                             | Hermetic unit tests (`test/**/*.test.ts`).                                                                                                     |
| `test:integration`                 | `test/integration/**/*.int.ts` against the dev stack (`deploy/docker/dev`, see `tooling/dev-stack`). Each file gets its own migrated database. |
| `migrate`, `migrate:audit`         | The migrate entry points (pass `--config`).                                                                                                    |
| `migrate:dev`, `migrate:audit:dev` | The same against the dev stack, loading `deploy/docker/dev/.env`.                                                                              |
| `start`, `start:dev` | The API (`serve`); the dev variant uses `deploy/docker/dev/control-plane.serve.dev.yaml`. |
| `start:sealer`, `start:sealer:dev` | The `sealer`; the dev variant uses `control-plane.sealer.dev.yaml`. |
| `audit-verify`, `audit-verify:dev` | `audit-verify`; the dev variant uses `control-plane.audit-verify.dev.yaml`. |
| `build`, `typecheck`, `lint` | `tsc` build to `dist`, type check including tests, ESLint. |
| `check:generated` | Builds and rewrites `openapi/control-plane.v1.json`. |
| `test:soak` | `test/soak/**/*.soak.ts` against the dev stack: the 10-minute AC-10 rotation soak (TC-F-002-16); also the `soak` workflow (`workflow_dispatch`). `RALYSA_SOAK_REPORT` names the report file (default `test-results/rotation-soak.json`); `RALYSA_SOAK_DURATION_MS` shortens a local run. |

## Runbooks

| Runbook | When |
| --- | --- |
| [Rotating the RTS signing key](#runbook-rotating-the-rts-signing-key-ac-10), including the rollback pin | Scheduled rotation; rolling back to an earlier key version |
| [Rotating the IdP client secret](#runbook-rotating-the-idp-client-secret-sec-f002-10), with the expiry register | At least 30 days before the secret expires (≤ 180-day lifetime) |
| [Break-glass `migrate --audit`](#runbook-break-glass-migrate---audit) | A release ships audit-set migrations |
| [Checkpoint key custody violation](#runbook-checkpoint-key-custody-violation) | `secret.custody_violation` for `ralysa-audit-checkpoint`, or `audit-verify` refusing the key |

## Runbook: rotating the RTS signing key (AC-10)

**Who.** An operator identity with the `ralysa-operator` OpenBao policy. It is the only policy that
may call `transit/keys/+/rotate`; every service and entry-point policy denies it (SEC-F002-11). The
operator can't export, back up or reconfigure the key.

**Steps.**

1. Rotate: `bao write -f transit/keys/ralysa-rts-signing/rotate`. Nothing else changes: no config,
   no restart.
2. Within `tokens.key_poll_s` (30 s) the first replica to poll stores the new version with its
   public key: `secret.rotated kind=signing_key phase=published version=<n>` (once, whichever
   replica wins). JWKS lists it at once, next to the key in use.
3. RTS keeps signing with the previous version until `published_at + tokens.activation_delay_s`
   (120 s) on the database clock. Verifiers refresh JWKS every 60 s or on an unknown `kid` (at most
   every 5 s), so each holds the new key before the first token signed with it exists. Then
   `phase=activated` is recorded once, and each replica logs `signing_key_active version=<n>` at
   its next poll. New tokens carry `kid ralysa-rts-signing.v<n>` within 2 × `key_poll_s` +
   `activation_delay_s` (≤ 180 s at the defaults; AC-10 allows 5 minutes).
4. The previous version stays in JWKS until its last token has expired (superseded +
   `access_ttl_s` + 5 min), then `phase=retired` is recorded and it leaves JWKS.
5. Check: `GET /v1/audit/events?action=secret.rotated&from=…&to=…` shows `published`, `activated`
   and, later, `retired` once each; `GET /.well-known/jwks.json` lists both kids during the overlap.

**Don't.** Don't raise `min_decryption_version` or `min_available_version` before the previous
version is retired: verifiers treat those versions as gone and in-flight tokens fail. Don't delete
and recreate the key: RTS detects the changed public key (`key_replaced`), stops signing and makes
`/readyz` unready. To go back to a version (a rollback, design §9) set
`tokens.signing_key_pin_version` and restart every replica:
- The pinned version signs and is never retired while pinned. If it had been superseded, the
  first poll clears that and records `secret.rotated phase=pinned` once.
- Every newer version that was ever active is superseded on that poll, so the bad version stays
  in JWKS for `access_ttl_s` + 5 min (its tokens verify until they expire), then retires
  (`phase=retired`) and leaves JWKS while the pin still holds. A newer version that was only
  published (never active) stays in JWKS and activates once the pin is removed.
- Removing the pin (and restarting): if the newer version has **not** retired yet, it is selected
  again, signs, and records `phase=reactivated`; the former pin is superseded and retires after
  the retention. So keep the pin until `phase=retired` has been recorded for the bad version
  (rotating to a good version before that doesn't help: until the new version's activation delay
  has passed, the newest **active** version, the bad one, would sign again). If the bad version
  has retired, the former pin stays the newest live version and keeps signing, and a version
  rotated in while pinned activates after its delay as usual.
- While a rolling restart changes the pin, replicas with the old and the new setting disagree:
  both versions stay in JWKS and `pinned`/`reactivated` may be recorded more than once until the
  rollout ends.

A version already retired can't be pinned. Rotation is not revocation: tokens signed with the old
version stay valid until they expire, so a suspected key compromise is an incident, not a rotation.

Evidence: TC-F-002-15 (CI, compressed timings under load) and TC-F-002-16 (the 10-minute soak at
these timings, `test:soak`).

## Runbook: rotating the IdP client secret (SEC-F002-10)

RTS authenticates to Entra with the client secret of its app registration, kept in OpenBao KV v2 at
`idp.client_secret_path`. Graph (app-only token) and flow B (code redemption) use it. Each `serve`
process holds it in the secret watcher (`src/secrets/runtime.ts`):

- it re-reads the KV entry every `idp.client_secret_poll_s` (60 s) and adopts a newer version only;
  an OpenBao outage keeps the value in hand (`idp_client_secret_read_failed` once per failure
  streak);
- each replica logs `idp_client_secret_observed version=<n>` when it adopts a version (the gauge
  `idp_client_secret_version` is emitted too, but `serve` has no metrics exporter yet, R29-n5, so
  the log line is what to watch); `secret.rotated kind=idp_client_secret phase=observed` is
  recorded **once per version** across replicas (the event id is derived from the org, the path and
  the version);
- when Entra answers `invalid_client`, the replica re-reads KV at once and retries the request
  once, only with a newer version (`idp_invalid_client retry=true`). `retry=false` means KV holds
  no newer value: the stored secret is wrong or expired, and sign-in (flow B) and Graph (every
  sign-in and refresh) fail closed until it is fixed;
- if KV answers an **older** version than the one a replica holds (the entry's metadata was
  deleted and the path rewritten, so versions restarted at 1, or a store was restored), the
  replica keeps its value and logs `idp_client_secret_version_regressed` with `held_version` and
  `store_version` once per streak. It adopts nothing until the store passes the held version.

**Lifetime.** Every client secret is created with an expiry of **at most 180 days**, and its expiry
is recorded in the register below. Rotate at least 30 days before it expires. The preferred end
state is a certificate credential signed through Transit, which removes the static secret
(SEC-F002-10; not built in Phase 0).

**Steps** (the operator identity: KV create/update only, it can't read a value back).

1. In Entra, add a **second** client secret to the RTS app registration with an end date at most
   180 days out, keeping the current one. Capture the password into a shell variable so it is
   never printed:
   `NEW_SECRET=$(az ad app credential reset --id <rts_client_id> --append --display-name rts-<yyyymmdd> --end-date <yyyy-mm-dd> --query password -o tsv)`.
   Read its key id for the register (never the value):
   `az ad app credential list --id <rts_client_id> --query "[?displayName=='rts-<yyyymmdd>'].{keyId:keyId, end:endDateTime}" -o table`.
   Allow a few minutes for Entra to propagate the new credential before step 2 (a replica that
   adopts it too early gets `invalid_client` with no newer version to retry).
2. Write it to KV from stdin, never as a command-line argument, then drop the variable:
   `printf '%s' "$NEW_SECRET" | bao kv put kv/ralysa/control-plane/idp-client-secret value=-; unset NEW_SECRET`
   (`;`, so the variable is dropped even if the write fails).
   `bao kv metadata get …` shows the new version number.
3. Wait until every replica reports it: `idp_client_secret_observed version=<n>` from each `serve`
   instance (at most one poll, 60 s), and the one `secret.rotated … phase=observed version=<n>`
   in `GET /v1/audit/events?action=secret.rotated`.
4. Remove the **old** secret in Entra:
   `az ad app credential delete --id <rts_client_id> --key-id <old key id>`. A replica that hadn't
   polled yet recovers on its next `invalid_client` without failing the request.
5. Update the register: the old key id removed, the new one in use.

**Don't** delete the KV entry's metadata (`bao kv metadata delete`) or recreate the path: KV
versions restart at 1, and every running replica ignores the "older" versions and keeps the old
secret (`idp_client_secret_version_regressed`). If a version ever goes backwards, write the correct
value and **restart every `serve` replica** so each reads the entry afresh.

**Register** (one per environment, kept with the deployment's operations records):

| Environment                                            | App registration (client id) | Key id | Created | Expires (≤ 180 d) | KV version | Rotated by |
| ------------------------------------------------------ | ---------------------------- | ------ | ------- | ----------------- | ---------- | ---------- |
| (none yet: the E-1 test tenant is an external blocker) |                              |        |         |                   |            |            |

**Also for SEC-F002-10**: the tenant-side controls on the service principal (Conditional Access
for workload identities or a named location, Graph activity logs) are in the
[Entra ID configuration checklist](#entra-id-configuration-checklist). A separate app registration
for the Graph reads is not supported by the config yet (one `rts_client_id`, one secret path;
implementation notes T13-5).

## Runbook: break-glass `migrate --audit`

The audit schema (`audit`, `ralysa_meta_audit`) is owned by the NOLOGIN role `ralysa_audit_owner`.
Only the `migrate --audit` job reaches it: it logs in as `ralysa_audit_migrator` and runs
`SET ROLE ralysa_audit_owner` on its one connection. The credential is readable only by the
`ralysa-cp-migrate-audit` OpenBao role (bound to that job's ServiceAccount). The owner could
disable the audit triggers, so this is a break-glass path (SEC-F002-01, D-37).

**When.** Only to apply audit-set migrations shipped in a release (they are listed in
`migrations.lock.json` under `audit/…` and in the release notes), before `migrate` (design §9).
Never for an ad hoc change.

**Steps.**

1. Open a change record naming the operator, the release and the audit migrations it adds.
2. Run the job once with its own config and role:
   `control-plane migrate --audit --config <migrate-audit config>`. It reads only
   `db/audit_migrator` and `db/audit_writer`. Running it again is a no-op.
3. Check the evidence in the audit store (`GET /v1/audit/events`, as a platform admin):
   - one `db.migration.applied` per applied migration with `set: audit` and the lock-file
     checksum;
   - `audit.schema_changed` per changed object from the DDL event trigger
     (`actor.service = dba-event-trigger`, `session_user = ralysa_audit_migrator`,
     `current_user = ralysa_audit_owner`).

   If the job reports "applied but not recorded", the migrations are in: record the gap in the
   change record and check that `audit.schema_changed` covers the DDL.

4. Run `audit-verify --config <audit-verify config> --log-checkpoints <shipped checkpoint log>`
   afterwards; it must pass.
5. Remove the job. Rotating the `db/audit_migrator` password afterwards is recommended.

Any `audit.schema_changed` outside such a window, or by another `session_user`, is a security
incident.

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
2. Run `audit-verify --config <audit-verify config> --log-checkpoints <shipped log>` against a restored copy of the key's
   public versions, taken from the log or an earlier `describe`, so history up to the flip can
   still be checked against the logged checkpoints.
3. Recovery by key epoch (a new key name, pinned thumbprints, a checkpoint payload that names
   the key) is designed in SEC-F002-35 (b) and not built yet. Until then, don't recreate a key
   under the same name: the sealer treats a flagged key that later reads as clean as still
   violated and logs `checkpoint_key_clean_after_violation` (SEC-F002-37).
