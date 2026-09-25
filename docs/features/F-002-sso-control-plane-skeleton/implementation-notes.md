# F-002: Implementation notes

> Phase 5 · Owner: developer agent · Branch `feat/F-002-foundations` (T01–T03, one commit per task; T04 follows on its own branch) · Design: [design.md](./design.md) (G4 recorded 2026-09-25) · Security review: [security.md](./security.md) · Date: 2026-09-25
> These notes carry the evidence the design asks each task to record: versions, deviations, "to verify" results and anything left open. The PR description links here.

## Environment

- Node.js **24.21.0**, pnpm **11.27.1** (Corepack), Turbo 2.11.2, TypeScript 6.0.3, Vitest 4.1.11.
- Docker Desktop on macOS (darwin_arm64): `docker info` succeeds, so the dev stack and `test:integration` ran locally (see T02).

## T01: workspaces

### What landed

- `pnpm scaffold services/control-plane --kind service`, `packages/auth --kind library-isomorphic`, `packages/protocol --kind library-isomorphic` (F-003 had not scaffolded it; it was still a placeholder) and `packages/secrets --kind library-isomorphic` (new folder). The placeholders' READMEs were kept and extended.
- `tooling/dev-stack` by hand from the service template: `ralysa.kind: "tooling"`, `shipped: false`, `artefacts: []`. Its `tsconfig.json` allows `.ts` import extensions with `erasableSyntaxOnly` (like `@ralysa/repo-scripts`), because the `.env` generator must run on plain Node before `pnpm install` (design §8.2); `tsconfig.build.json` sets `rewriteRelativeImportExtensions` so `build` still emits a runnable `dist/` for the T09 compose `mock-idp` service.
- `packages/protocol` subpath exports `./common`, `./audit`, `./auth`, `./control-plane` (plus `.`, which re-exports each family as a namespace). `./agent` is left for F-003 [AR-18].
- `test:integration` (`vitest run --config vitest.integration.config.ts`) in `services/control-plane`, `packages/secrets` and `tooling/dev-stack`, each with a wiring test `test/integration/wiring.int.ts`.
- New shared Vitest preset `integration` in `@ralysa/vitest-config`: `test/integration/**/*.int.ts` only, longer timeouts, used on its own because `mergeConfig` concatenates `include` arrays. The hermetic `node` include never matches `*.int.ts` (preset test).
- Repo check `deps/dev-only-in-shipped` in `check-workspaces`, over the list `DEV_ONLY_PACKAGES = ['@ralysa/dev-stack', 'oidc-provider']` in `tooling/eslint-config/boundaries.js` (the shared boundary list, so T14's dependency-cruiser and `check-banned-deps` modes read the same list).

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T01-1 | **Not done, by instruction** | `.github/CODEOWNERS` entries by folder for `packages/protocol/src/{common,audit,auth,control-plane}` [AR-18]. | `.github/CODEOWNERS` does not exist in the repository, and CODEOWNERS is human-merge territory. **Proposed entries for a human to add** (owners to be named by the founder): `/packages/protocol/src/common/ @<f-002-owner>`, `/packages/protocol/src/audit/ @<f-002-owner>`, `/packages/protocol/src/auth/ @<f-002-owner>`, `/packages/protocol/src/control-plane/ @<f-002-owner>`, `/packages/protocol/src/agent/ @<f-003-owner>`. |
| T01-2 | Scope of the first exclusion check | `deps/dev-only-in-shipped` walks the **workspace graph**: a `shipped: true` workspace fails if a development-only package is in its `dependencies`, `optionalDependencies` or `peerDependencies`, or in those of any workspace reachable through them. The finding names the witness path. `devDependencies` are allowed (integration tests import the harness from `test/**`). | The design's T01 row asks for "no `shipped: true` workspace depends on `@ralysa/dev-stack`"; walking workspace production edges is the same check made transitive at no cost. The lockfile closure (an npm package that pulls `oidc-provider` in) is T14's `check-banned-deps` production-closure mode, as designed. `@ralysa/dev-stack` is also `kind: "tooling"`, which the existing `deps/tooling-dev-only` rule already keeps out of every production field. |
| T01-3 | Implementation choice | The placeholder wiring test asserts `expect.getState().testPath` ends in `.int.ts`. | `import.meta.url` is not typed under `lib-isomorphic.json` (no DOM, no Node types), which confirms the isomorphic base keeps Node and DOM globals out even with Vitest's types loaded. |

### Checks (T01 definition of done)

- All five workspaces pass `lint`, `typecheck`, `test`, `build` and `test:integration` (the wiring test).
- `pnpm repo:check`: `check-workspaces` and `check-tsrefs` green.
- `check-workspaces.test.ts` (5 new cases): direct `oidc-provider`; a path through an optional and a peer dependency across two workspaces (with the witness path); `@ralysa/dev-stack` as a production dependency; devDependencies and unshipped workspaces allowed; the real repository clean.

## T02: dev stack, bootstrap and the `integration` CI job

### What landed

- `deploy/docker/dev/compose.yaml`: `postgres` and `openbao`, digest-pinned, ports on `127.0.0.1` only (55432, 58200), `no-new-privileges`, healthchecks for `--wait`. Postgres: UTF-8 initdb, SCRAM for host connections, `log_line_prefix` with user, database, application and client (D-31 condition), `password_encryption=scram-sha-256`. The `mock-idp` service (profile `idp`) is T09's.
- `tooling/dev-stack`:
  - `env`: the dependency-free `.env` generator (SEC-F002-29).
  - `bootstrap`: OpenBao mounts, Transit keys, KV entries, the per-entry-point policies with explicit denies, dev AppRoles; then the Postgres login roles over stdin.
  - `kubernetesAuthRoles()`: the Kubernetes-auth role template (SEC-F002-22).
  - `@ralysa/dev-stack/harness`: probe, skip-or-fail, AppRole login and root clients for integration tests.
- CI `integration` job (design §8.5), `required-checks.json` + `integration`, invariants `ci/pre-install-gate-first`, `ci/integration-no-secrets` and `ci/integration-artefact`, and `docs/engineering/repo-conventions.md` (dev stack, ports, the job and the invariants).

### Versions and images (checked 2026-09-25)

Policy as in F-001 (§2.2): the latest patch of a line GA for at least 30 days, and at least 3 days old (`minimumReleaseAge`).

| Item | Pinned | Evidence |
|---|---|---|
| `pg` | **8.23.0** (devDependency of `@ralysa/dev-stack` only) | Published 2026-08-08; the 8.23 line is 48 days old. MIT, no install scripts; dependencies `pg-pool`, `pg-protocol`, `pg-types`, `pgpass`, `pg-connection-string`, `pg-cloudflare`. No `pg` version has provenance, so `trustPolicy: no-downgrade` is unaffected. Not in the catalog yet because one workspace uses it (T05 adds control-plane and moves it to the catalog). |
| `@types/pg` | **8.23.1** | Published 2026-08-17. |
| `postgres` image | **`postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`** (multi-arch index) | `docker buildx imagetools inspect postgres:17`; the `17` and `17.11` tags point at this index. |
| OpenBao image | **`quay.io/openbao/openbao:2.6.2@sha256:11fd73a2102cda9c55d5d881a8c3210303146a7ec1e8ac76f526e175c6d24641`** | 2.7.0 and 2.6.3 were both published 2026-09-23 (2 days old), inside the 3-day window, and the 2.7 line is not yet 30 days GA. 2.6.2 (2026-08-18) is the newest image outside the window. **Follow-up:** move to 2.6.3 after 2026-09-26 (same line, a patch release). The design names "2.x". |

Checked for later tasks and **not added**, because no code uses them yet: `kysely` 0.29.6 (0.29 line; T05), `fastify` 5.12.5 (the 5.12 line started 2026-08-13, 43 days; T07), `oidc-provider` **9.11.5** (the 9.12 line started 2026-08-28, 28 days, so it fails the 30-day rule; 9.11.5 is from 2026-08-24; T09, devDependency of dev-stack only), `jose` 6.2.12 (added in T04), `canonicalize` 4.0.0 (added in T03), `zod` 4.6.5 (catalog, unchanged).

### OpenBao flags recorded (T02 definition of done)

- The dev server reports `storage_type: "inmem"` from `sys/seal-status` (asserted by `stack.int.ts`). That is the signal the control plane's production guard will refuse (design §3.8, T07). The "to verify" item "OpenBao image flags" is resolved as `server -dev -dev-listen-address=0.0.0.0:8200`, with `BAO_DEV_ROOT_TOKEN_ID` from the environment and `SKIP_SETCAP=true` (dev mode doesn't mlock).
- Every Transit key reads back `type: ecdsa-p256`, `exportable: false`, `allow_plaintext_backup: false`.

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T02-1 | **Design gap, bounded here** | `bootstrap` creates the **login roles and their passwords** only. It doesn't run `bootstrap-roles.sql` (ownership, grants, `ralysa_audit_owner`, memberships, the DDL event trigger) or the two migration sets; it prints that T05 adds them. | Those files are T05 deliverables (`services/control-plane/src/db/sql/bootstrap-roles.sql`, `migrations/{cp,audit}`), and T02 comes first in the task order. `bootstrap-roles.sql` will use the same stdin channel and psql variables (`\set pw_<role>` … `:'pw_<role>'`), so T05 plugs in without changing the mechanism. |
| T02-2 | Hardening within the design's intent | Role passwords reach Postgres as **SCRAM-SHA-256 verifiers computed in the bootstrap**, not as plaintext, still over stdin. | Even a logged failing `ALTER ROLE` or a psql error line shows only a verifier. The verifier code is checked against the RFC 7677 test vector (server signature and client proof), and every role logs in with its KV password in `stack.int.ts`. |
| T02-3 | Implementation choice | **Policy allow rules use exact paths only** (no `*` or `+`). The service public keys that `serve` may read are listed one by one from the service list. | OpenBao, like Vault, applies only the highest-priority matching pattern across a token's policies. An allow glob like `transit/keys/ralysa-svc-*` would outrank the `transit/keys/+/config` deny (its first wildcard comes later) and so reach `…/config`. With exact allows, each deny is the only pattern that matches its paths. A unit test fails on any wildcard in a non-operator allow rule. |
| T02-4 | Addition | A third invariant, `ci/integration-artefact`: the `integration` job's `docker compose … logs` must name `postgres` and not `openbao`, and every upload there sets `retention-days` ≤ 3. | These are the SEC-F002-27 artefact items. The design's two invariants cover only secrets, permissions and credentials. |
| T02-5 | Interpretation | `ci/pre-install-gate-first` treats these as package-manager invocations: any `run` line calling `pnpm`, `pnpx`, `npx`, `npm`, `yarn`, `corepack` or `turbo` (including inside `$(…)`), `actions/setup-node` with **any** `cache` value, and `pnpm/action-setup`. It checks every job of every workflow, line by line, so the gate and pnpm may share a step if the gate comes first. | Design: "`pnpm`, `corepack`, `npx`, `turbo`, or `actions/setup-node` with `cache: pnpm`". SEC-F002-28 adds "any `uses:` that shells out to a package manager". `npm`, `pnpx` and `yarn` are the same risk class. Two existing F-001 fixture tests changed: the `fetch-depth` fixture ran `pnpm secret-scan history` with no gate (it now runs `node …/secret-scan-cli.ts history`), and the secret-scan install fixture now also reports this rule. |
| T02-6 | Addition to the design's job | A **"Bootstrap the dev stack"** step between `compose up` and the tests, and a job-level `RALYSA_REQUIRE_DEV_STACK: '1'`. | The design's §8.5 YAML has no bootstrap step, but §8.2 makes bootstrap a scripted step. With the variable set, a missing or unbootstrapped stack fails the tests instead of skipping them. |
| T02-7 | Scope note | The image secret-scan step is not in the job yet. | As the design says, `secret-scan-cli.ts image` arrives with T14, which adds the step. |
| T02-8 | Dev-only settings | Dev AppRoles use a single-use `secret_id`, `secret_id_ttl` 10 min, `token_ttl` 15 min, `token_max_ttl` 1 h, and `secret_id_bound_cidrs`/`token_bound_cidrs` of loopback plus the RFC 1918 ranges. The `secret_id` is not response-wrapped. | Requests from the host reach OpenBao from the Docker bridge address, which differs between Docker Desktop and Linux runners. Production AppRole stays refused unless `allow_approle` (T04 port, T07 guard), and then needs a response-wrapped `secret_id` and deployment-specific CIDRs (SEC-F002-22). |
| T02-9 | Known local effect | `pnpm secret-scan tree` reports the generated `deploy/docker/dev/.env` (2 `generic-api-key` findings) while the file exists, because the tree scan also reads git-ignored files. | The values are throwaway, and CI's `secret-scan` job never has the file. Documented in repo-conventions ("move the file aside before a local tree scan"). Changing the F-001 tree scan's file selection is out of scope. |
| T02-10 | Services in the dev stack | `ralysa-svc-<name>` keys and policies for `agent-host`, `mcp-gateway`, `model-gateway` and `workspace-runtime`. | The design lists "service keys" without names; these are the Phase 0 services that have a folder. The control plane's `services[]` config (T07) decides which are registered at runtime. |

### Tests (T02)

- `tooling/dev-stack/test/env.test.ts`: alphanumeric values over the whole alphabet; mode `0600`; relative `--out`; refusals for a sibling folder, the parent, `/etc`, a symlinked folder and a non-`.env*` name; no overwrite without `--force`; no write through a planted symlink (the target stays untouched); `::add-mask::` lines; the CLI exits 2 and writes nothing outside `deploy/docker/dev/`.
- `test/bootstrap.test.ts`:
  - the RFC 7677 SCRAM vector;
  - the psql script holds no plaintext password, stops on error, checks UTF-8 first and grants no elevated attribute;
  - the policies: one per entry point and service; `serve` can't read migrator or sealer credentials or sign checkpoints; only the migrate jobs read the migrator credentials; services sign with their own key only; no wildcard allows; every policy carries the denies and only the operator may rotate; custom mounts;
  - the Kubernetes-auth template binds one ServiceAccount, namespace and audience per role.
- `test/harness.test.ts`: missing and incomplete `.env`, `devStackRequired`, skip locally and throw when required.
- `test/integration/stack.int.ts` (smoke): UTF-8, SCRAM and the log prefix; every role exists without elevated attributes and with a SCRAM password; every role logs in with its KV password; OpenBao unsealed, `inmem`, keys non-exportable.
- `test/integration/policies.int.ts` (the SEC-F002-22 policy-boundary harness, part of TC-F-002-26):
  - 34 allow/deny cases across the five entry points and a service. For example, `serve` gets 403 on `db/migrator`, `db/audit_sealer` and `transit/sign/ralysa-audit-checkpoint`, and `ralysa-svc-model-gateway` gets 403 signing with `ralysa-svc-agent-host`.
  - Every non-operator role gets 403 for key config, export, backup, restore, import and rotate on three keys.
  - A single-use `secret_id` can't log in twice.
- `tooling/repo-scripts/test/check-ci-invariants.test.ts`:
  - The gate rule fails on pnpm, corepack, `$(pnpm …)`, npx, turbo, `setup-node cache: pnpm` and `pnpm/action-setup` before the gate, and on pnpm earlier in the same step. It passes the right orders and look-alike words, and it covers every workflow file.
  - The integration job fails on `secrets.*`, missing or wider permissions, persisted credentials, OpenBao or all-service logs, and missing or long retention. The real `ci.yml` passes.
- `test/check-turbo-config.test.ts`: a package-level `test:integration` with `cache: true` fails (SEC-F002-28; the root-level case already existed).

## T03: contracts in `packages/protocol`

### What landed

- `common`: `TraceId`, `SpanId`, `Sha256Hex`, `Region`; shared `ERROR_CODES` (incl. `audit_unavailable`) and the RFC 9457 `Problem` with `i18n_key`; W3C `traceparent` parse, format and id generation.
- `audit`:
  - the envelope (`AuditEventInput`, `AuditEvent`, `Outcome` with `failure`, `Source`, `Actor`, `IJson`), `AUDIT_SCHEMA_VERSION`;
  - the F-002 event catalogue, reserved namespaces and the two service exceptions (`auth.token_rejected`, `secret.rotated`), `outcomeAllowed()` for [AR-3];
  - the client allow-list, size limits, `RESERVED_DETAIL_KEYS` with `findReservedKeys()`;
  - `jcs.ts`: RFC 8785 through `canonicalize`, the I-JSON check, the omit-null canonical envelope, `eventHash`, `chainHash`, `GENESIS_PREV_HASH`, `canonicalSize`.
- `auth`: `Audience`, `Surface`, `AccessTokenHeader`, user and service claims, `FORBIDDEN_JOSE_HEADERS`, `kidPattern`/`kidFor`, `TokenRejectReason`, lifetimes; the OAuth requests (authorize, the four grants as a discriminated union, revoke), `TokenResponse`, `OAuthError`, RFC 8414 metadata, opaque-token patterns; `SignInReason`, `RefreshReason`, `RalysaErrorCode` and the i18n keys (`AUTH_I18N_KEYS`).
- `control-plane`: `AuthConfig`, `SignInFailureReport`, `Me`, `GroupView`, `Principal`, `GovernanceState` (+ feed timing constants), the service and client audit APIs, `IntentAck`, `AuditQuery`, `AuditQueryResponse`; `/v1` and API version constants.
- `schema/generator.ts` (the one generator) with 23 registered contracts, `scripts/generate-schemas.js` and `check:generated`, and the committed `src/schema/generated/*.json`.

### Versions (checked 2026-09-25)

| Item | Pinned | Evidence |
|---|---|---|
| `canonicalize` | **4.0.0** (dependency of `@ralysa/protocol`) | The design names this package for RFC 8785. The 5.x line started 2026-09-08 (17 days), so under the 30-day rule; 4.0.0 is from 2026-08-12. Apache-2.0, ESM with types, no dependencies, no install scripts. No 4.x or earlier version has provenance (5.x does, which is newer, so `trustPolicy: no-downgrade` doesn't apply). It refuses NaN, Infinity and lone surrogates itself; our I-JSON check runs first anyway. |
| `zod` | 4.6.5 (existing catalog entry) | Unchanged. `z.toJSONSchema()` is the generator. |

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T03-1 | **Interpretation** of the omit-null rule | Null or absent **top-level** envelope members are omitted, and so are null members of `actor`, `act` and `resource` (flat objects of envelope columns). `details` is hashed exactly as stored, nulls included. | §4.6 says "null or absent fields omitted" without saying whether nested. A future nullable actor column (for example `actor.on_behalf_of`) must not change old hashes either, so the envelope's structured members are included. `details` holds client and service data where `null` is a value, so omitting there would make `{"x": null}` and `{}` hash alike. Both behaviours are pinned by tests. |
| T03-2 | Interpretation of I-JSON | Integral numbers outside ±(2^53 − 1) are refused, as are non-finite numbers, lone surrogates (values and member names), non-plain objects, `undefined` and nesting deeper than 64. | Design: "numbers must be safe integers or finite doubles". At the JS level, an integral double can't be told apart from a large integer literal whose precision was lost in parsing, so the check refuses both; audit `details` have no need for such numbers. |
| T03-3 | Implementation choice | WebCrypto and `TextEncoder` are reached through `src/platform.ts` with structural types, not through global type declarations. | `lib-isomorphic.json` has neither DOM nor Node types (T01-3 confirmed this), and declaring the globals would clash with `@types/node` in consumers. Typing only what is called keeps the base strict. `@ralysa/secrets` does the same in T04. |
| T03-4 | Small design gap, filled | `OAuthError.ralysa_error.code` is `RalysaErrorCode` (sign-in **and** refresh reasons), not only `SignInReason`. | §5.3 returns `invalid_grant` "with `ralysa_error`" for refresh denials such as `idp_session_revoked` and `reuse_detected`, which aren't sign-in reasons. The i18n key is per outcome (`auth.failed.expired` for sign-in, `auth.denied.expired` for refresh), so both lists map separately. |
| T03-5 | Additions | `ClientCredentialsRequest` (RFC 7523, the fourth grant) and `TokenRequest` as a discriminated union over the four grants; `AuthorizationServerMetadata` (RFC 8414); `ServiceEventsRequest/Response`; `AuditQuery`, `AuditEventView`, `AuditQueryResponse`; `Problem`. | §3.1 and §3.4 describe these routes and bodies in prose without zod. They are the same fields the prose names. `AuditQuery.limit` stays a string pattern (1–500) because a zod coercion would be a transform. |
| T03-6 | Hardening | Length limits the design's snippets don't state: `client_id` 64, `amr` 16 × 32, `region` 40, `redirect_uri` on code redemption 64, `act.sub` 200, `scope` 256, cursors 256, `reason_category` 64. | Bounded input on every external body; no field changes meaning or type. |
| T03-7 | Implementation choice | `check:generated` runs `tsc -p tsconfig.build.json` and then `scripts/generate-schemas.js` against `dist/`. `scripts/` is outside the isomorphic lint scope. The drift unit test reads the committed files with a literal `import.meta.glob` and compares them with the generator output. | `src/` uses `.js` import specifiers (NodeNext), which Node's type stripping can't run from source. The script is Node tooling that nothing imports. The glob keeps the test hermetic without `node:fs`, which the isomorphic preset bans. |
| T03-8 | Implementation choice | `src/schema/generated/` is in `.prettierignore`. | The generator owns the format (`JSON.stringify(…, 2)`); Prettier would collapse short arrays and create drift, as with the F-001 i18n types (T08-11). |
| T03-9 | Scope note | `checkpointPayload` (the JCS of `{org_id, shard, seq, hash, checkpoint_ts}`) is not in T03. | It belongs to T16 with the sealer. |

### Tests (T03)

147 tests in `packages/protocol/test/`:
- `jcs.test.ts`: RFC 8785 §3.2.2 (the example, byte for byte) and §3.2.3 (UTF-16 key order); ECMAScript number serialisation; Arabic with harakat unchanged; I-JSON refusals (NaN, Infinity, unsafe integers, a large integral double, lone surrogates in values and member names, `undefined`, Date, function, bigint, depth); the omit-null canonical form; **a golden event hash and chain hash** (`939a8a46…`, `18c0ae2e…`, cross-checked with `shasum -a 256` and Python `hashlib`); **the same hash after adding nullable columns** (`grant_id`, `approval_id`, `content_ref`, `rows`, `masked_entity_counts`, `endpoint_region`, `actor.on_behalf_of`) [AR-7]; every value change changes the hash; `details` nulls are data; non-I-JSON `details` can't be hashed; the FIPS 180-2 "abc" vector.
- `audit.test.ts`: the envelope accepts the AC-11/AC-13 fields and refuses server-assigned fields in input, unknown members, `ts` without exactly 3 digits and `Z` [AR-5], bad action names and regions; `failure` on `auth.*` only; the reserved namespaces and the two service exceptions [SEC-F002-03]; the client allow-list; reserved keys at any depth [SEC-F002-15].
- `auth.test.ts`: header `alg`/`typ` refusals (`none`, `HS256`, `RS256`, `ES384`, `typ: JWT`), `kid` pattern, single audience, service claims; loopback-only redirects; the four grants accepted, `password` and unknown grants refused; no `client_secret` on any user grant (AC-3); opaque-token and verifier formats; the i18n key per outcome.
- `control-plane.test.ts`: the auth config switch, the IdP-neutral `idp_error_code` [AR-18], Arabic display names byte-identical (AC-15), UUID-only groups, the governance feed, client-event allow-list and batch limits, a forged `actor` refused by the schema, the service batch limit, `AuditQuery` limits.
- `schema.test.ts`: the committed files are exactly the registry and equal the generator output; URN `$id`s; a transform fails generation; no password, PIN, OTP or `client_secret` property in any generated contract (the AC-3 check on contracts; TC-F-002-05 on the OpenAPI document is T07's); the audit schema lists `endpoint_region` and `inference_region`.
- **Drift proof (manual, 2026-09-25):** changing one value in `audit-event.v1.json` made `schema.test.ts` fail, and `git diff` showed the file changed (CI's porcelain check); `check:generated` rewrote it and `git diff` was empty again.

## PR close-out (T01–T03)

- The interrupted session left the branch clean: three commits, no uncommitted work, based on the current `main` (`f3ce0b5`, F-001 T06–T08 and the F-002 design), so no merge was needed.
- Local run on Node 24.21.0 (2026-09-25): pre-install gate, `pnpm install --frozen-lockfile`, `pnpm repo:check`, and `turbo run lint typecheck test build check:generated --force` (91/91 tasks). The dev stack (`env`, `compose up --wait`, `bootstrap`) with `RALYSA_REQUIRE_DEV_STACK=1 turbo run test:integration --force` passes 9/9 tasks and 55 tests.
- Local trap found and documented in repo-conventions: after `env --force`, an old `postgres-data` volume keeps the previous superuser password, so the smoke test fails until `down -v`. CI always starts with a fresh volume, so it isn't affected.

## Code review of PR #18 (changes requested): resolutions

| # | Finding | Resolution | Evidence |
|---|---|---|---|
| R-1 | **Blocking.** `stack.int.ts` read `stack!` and built and connected the Postgres client in the `describe.skipIf` body. That body runs at collection time even when skipped, so with no dev stack `test:integration` crashed ("Cannot read properties of undefined (reading 'postgres')") instead of skipping. | The client is now created and connected in `beforeAll` and ended in `afterAll`. `stack!` is read only inside hooks and tests. Audit of every `*.int.ts`: `policies.int.ts` reads `stack!` only inside a helper closure and tests, and the three `wiring.int.ts` files don't use the stack. **Regression guard:** new repo check `check-integration-scope` (in `pnpm repo:check`, so it covers every workspace and is never cached). It parses each `test/integration/**/*.int.ts` with the TypeScript compiler API. It flags any read of a `devStackOrSkip()` binding in collection-time code: a `describe` body, nested `describe` bodies, and `it.each`/`describe.each` tables. In the `describe` callee's own arguments it flags only dereferences, so `skipIf(stack === undefined)` stays legal. | Reproduced the crash, then after the fix: no `.env` gives 2 files and 56 tests skipped, exit 0. The check flags the old file at line 13 (`git show fbfc53b:…`). `check-integration-scope.test.ts` has 10 cases, including the original pattern and a clean real repo. |
| R-2 | The operator policy granted `read` on `kv/data/ralysa/control-plane/*`. §6.5 gives the operator KV create/update only. | Dropped `read`. The operator keeps `read`/`list` on KV **metadata**, which shows version numbers and never values, so the rotation runbook (T13) can confirm that a new version landed. Logged as a bounded interpretation of "KV writes". | Unit test: the operator's only `kv/data` rule is `create, update`. |
| R-3 | `ensureMount` didn't check the options of an existing mount, so a KV v1 mount at `kv/` was accepted. | `ensureMount` (now exported) compares every requested option. An existing `kv/` without `version: '2'` fails with a message to reset the stack. | Unit tests with a fake client: mounts when absent; accepts v2; refuses v1, a missing version and the wrong type. |
| R-4 | No test that an explicit deny beats a broad glob allow. | New `policies.int.ts` case against a throwaway key, with a harmless config change so no real key can become exportable. Allow `transit/keys/*` plus the standard denies gets **403** on `…/config`: same first-wildcard position, and the trailing `*` ranks lower. The same test also shows that a narrower `transit/keys/ralysa-*` gets **200**, because its first wildcard comes later and so outranks the deny. That is the concrete reason for T02-3 (exact-path allows only). | `test:integration`: 56/56. |
| R-5 | CODEOWNERS deferral (T01-1) not tracked. | Added under "Open items" in status.md, pointing to F-001-T18 (which adds `.github/CODEOWNERS`, SEC-F001-04). | status.md |
| R-6 | No guard against `.refine()`/`.superRefine()` on wire types. | **Decision: enforce, don't just document.** Checked on zod 4.6.5: `z.toJSONSchema` silently drops custom checks even with `unrepresentable: 'throw'`, so a refinement would make the zod schema and the published JSON Schema disagree. New `findCustomChecks()` in the generator walks the zod tree (including lazy and recursive types such as `IJson`), and `toJsonSchema` throws on any custom check. A unit test also walks **every** exported schema of the four families, registered or not. | `schema.test.ts`: `refine`, `superRefine`, `check(z.refine)` and a refinement nested in a union all fail; built-in checks pass; all exports are clean. |
| R-7 | The harness probe checked only the Transit mount, so a bootstrap that stopped half-way looked ready. | `bootstrap` now writes a completion marker `kv/data/ralysa/dev-stack/bootstrapped` (root token, outside every Ralysa policy) **after** the Postgres roles step. The probe also requires the `ralysa-cp-serve` policy and the marker. This covers the case hit locally where psql failed after the OpenBao part. | Unit tests for the marker path and `isBootstrapped`. `stack.int.ts` asserts the marker. Manual check: after the marker was deleted, the probe reported "the last bootstrap did not finish…", and re-running bootstrap restored it. |
| R-8 | The `AuthorizeQuery.redirect_uri` port pattern `[1-9][0-9]{0,4}` accepted 65536–99999. | **Deviation from the design's regex (§3.2, `/^http:\/\/(127\.0\.0\.1\|\[::1\]):([1-9][0-9]{0,4})\/callback$/`):** tightened to exactly 1–65535 with no leading zeros. It is stricter only, and every port a real loopback listener can bind still passes. The generated `oauth-authorize-query.v1.json` was regenerated. | `auth.test.ts`: 1, 9999, 59999, 64999, 65499, 65529 and 65535 accepted; 0, 01, 65536, 65540, 66000, 99999 and 100000 refused. |
