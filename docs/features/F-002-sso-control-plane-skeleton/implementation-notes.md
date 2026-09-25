# F-002: Implementation notes

> Phase 5 · Owner: developer agent · Branches `feat/F-002-foundations` (T01–T03, PR #18, merged) and `feat/F-002-secrets-db-audit` (T04–T06), one commit per task · Design: [design.md](./design.md) (G4 recorded 2026-09-25) · Security review: [security.md](./security.md) · Date: 2026-09-25
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

## Carried review nits (from PR #18, on `feat/F-002-secrets-db-audit`)

- The no-glob test now covers **every** policy, operator included. It uses a small OpenBao glob matcher (`+` = one segment, a trailing `*` = any suffix) to require that no allow pattern matches a sample of denied custody paths: key config, export, backup, restore and import.
- The `stack.int.ts` comment now names `check-integration-scope`.
- The `readDbPassword` doc comment is back above its function.

## T04: `packages/secrets`

### What landed

- `ports.ts`: `SecretStore`, `KeyCustody`, `KeyDescription`, `PublicKeyVersion`, `VaultAuth`, `RuntimeEnv` (design §3.7).
- `openbao/http.ts`: `fetch` client. The address must be plain `http(s)://host[:port][/path]`. Every API path segment must match `[A-Za-z0-9_.+-]+` with no `.` or `..`. A default 5 s timeout applies.
- `openbao/auth.ts`: Kubernetes, AppRole and token login with the environment rules in `assertAuthAllowed`. Logins are single-flight and renew at half the lease.
- `openbao/kv2.ts`: `get` and polling `watch` over mount-first paths.
- `openbao/transit.ts`: `describe` (custody flags, type, public JWKs from the PEM) and `sign` (`sha2-256`, `key_version`, `marshaling_algorithm=jws`, a 64-byte r‖s check).
- `memory/`: the two doubles. Key custody uses WebCrypto keys whose private halves are non-extractable, plus `setFlags` and `setMinAvailableVersion` for custody-monitor tests.
- `errors.ts`: `SecretsError` codes and `CustodyViolationError`. No message carries a token, value or body.
- Dev-stack harness: `roleCredentials(stack, role)` (role_id plus a fresh single-use secret_id), so adapter tests log in through AppRole themselves.

### Versions

| Item | Pinned | Evidence |
|---|---|---|
| `jose` | **6.2.12** (devDependency of `@ralysa/secrets`, integration verification only) | Published 2026-09-05 (20 days old), the latest 6.2 patch; the 6.2 line is well past 30 days. MIT, no dependencies, no install scripts. T07/T11 add it as a runtime dependency of control-plane and auth and move it to the catalog then. |

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T04-1 | **Bug found by the integration test, fixed** | After a 403, the adapter logs in again only if `auth/token/lookup-self` with the same token is also refused. A policy denial (valid token) is returned as `access_denied` without a new login. | The first version re-logged in on every 403. With the dev AppRole's single-use `secret_id`, a legitimate denial (serve reading `db/migrator`) burned the credential and turned the denial into `auth_failed`. In production the same would make each denial cost a login. `lookup-self` is in OpenBao's default policy. |
| T04-2 | Addition to the port | `createOpenBao` takes `allowAppRole` (from config `vault.allow_approle`). AppRole is refused when `env=production` without it; token auth is refused unless `env` is `dev` or `test`. `assertAuthAllowed` is exported so T07's config guards call the same rule. | §3.7 says "production only with allow_approle" but its `createOpenBao` signature has no field for it. |
| T04-3 | Addition to the port | `SecretStore.watch` takes an optional `onError`. Polling continues after an error, and the version seen at start is not reported. | §3.7's signature has no error channel. The T13 rotation watcher needs to see OpenBao outages without the watch dying. |
| T04-4 | Implementation choice | `PublicKeyVersion.jwk` is a `PublicJwk` (`kty`, `crv`, `x`, `y` only), not the DOM `JsonWebKey`. | The isomorphic lib has no DOM types. The narrower type also guarantees that no private or `key_ops` members reach JWKS. |
| T04-5 | Implementation choice | `describe` refuses any key type but `ecdsa-p256` (`unsupported_key`) as well as either custody flag. The flag check treats a **missing** flag as `true` (fail closed). | ES256 is the only algorithm the design mints with (§3.2.4). A reply without the flags is not proof of custody. |
| T04-6 | Implementation choice | The in-memory custody's `sign` still signs after `setFlags`, as Transit does. Only `describe` refuses. | The custody monitor (T07/T16) is what stops signing. If the double refused too, TC-33's hermetic half would pass without the monitor doing anything. |
| T04-7 | Hardening | `check-integration-scope` skips listed files that no longer exist. | `git ls-files --cached` still lists a deleted file until the deletion is staged, and the check crashed on it while this task replaced `wiring.int.ts`. |

### Tests (T04)

- `test/openbao.test.ts` (fake `fetch`, 40 cases):
  - the auth matrix per environment, including a refusal before any request;
  - address validation;
  - Kubernetes login (single-flight, reused, re-login only when the token is invalid, no re-login on a policy denial);
  - an AppRole login failure and an unreachable OpenBao, whose messages don't contain the role id, secret id or token;
  - KV path mapping, the status → code mapping, a deleted version and path traversal refusals;
  - `watch` with fake timers: a new version reported once, errors reported while polling continues, nothing after `stop`;
  - Transit `describe` (JWK shape, `min_available_version`, each custody flag and a missing flag, non-P-256);
  - `sign` (request body, 64 bytes, a wrong version, a wrong length, non-vault formats, key-name traversal).
- `test/memory.test.ts`: versions and `watch`; `fail`; two key versions whose signatures verify only against their own JWK; unknown keys and unavailable versions; flags flipped at runtime are refused and then accepted again.
- `test/integration/openbao.int.ts` (dev stack):
  - **a Transit ES256 JWS verifies with `jose` against the published key for two versions**, and never under the other version's key;
  - `describe` refuses a key after `exportable` is flipped at runtime, and another after `allow_plaintext_backup` alone is flipped (OpenBao 2.6.2 accepts that flag without `exportable`; checked), on throwaway keys [SEC-F002-11];
  - **the KV v2 watch reports a new version**;
  - the serve AppRole reads `db/cp_app` but gets `access_denied` on `db/migrator`, and signs with `ralysa-rts-signing` but not with `ralysa-audit-checkpoint`.

## T05: database

### What landed

- `src/db/sql/bootstrap-roles.sql`, the DBA script. It is plain SQL, idempotent and run once per database as a superuser, with these parts:
  - a UTF-8 and superuser check;
  - the roles, none with an elevated attribute;
  - the NOLOGIN `ralysa_audit_owner`, granted to `ralysa_audit_migrator` `WITH INHERIT FALSE, SET TRUE`, plus an assertion that `ralysa_migrator` is not a member;
  - database CONNECT and CREATE grants, and `REVOKE ALL ON SCHEMA public FROM PUBLIC`;
  - the superuser-owned `ralysa_admin.record_audit_schema_ddl()` and two event triggers (`ddl_command_end`, `sql_drop`), `ENABLE ALWAYS`, which write `audit.schema_changed` for any DDL on `audit` or `ralysa_meta_audit` [SEC-F002-01 b].
- Migrations (static providers, up only):
  - `audit/0001_audit_store`: `audit.current_org()`; `audit_event`, `audit_seal` (foreign key to the event) and `audit_checkpoint`; FORCE RLS; column-level INSERT for the writer; reader and sealer grants; `reject_modify_row`/`_stmt` and `reject_truncate` on all three tables, `ENABLE ALWAYS`.
  - `cp/0001` to `cp/0004`: the §4.4 tables, FORCE RLS with one policy per operation, per-table grants, and the `organization.region` immutability trigger.
- `src/db/migrate.ts`: both sets. Each runs as its login role; the audit set issues `SET ROLE ralysa_audit_owner` on its single connection. Kysely history lives in `ralysa_meta` and `ralysa_meta_audit`. Both sets check UTF-8 and check the role matches the set.
- `src/db/pools.ts` (one pool per role; password as a function, fetched from OpenBao at connect), `src/db/kysely.ts` (`createDb`, `withOrg` with a UUID check), `src/db/types.ts` (the Kysely `Database`).
- `src/config/` (the shared `Common` parts plus `MigrateConfig` and `MigrateAuditConfig`, the common production guards, and a YAML loader whose errors name paths only), `src/secrets/vault.ts` (auth material from files or a named env var), and `src/main.ts` (`migrate [--audit]`).
- `migrations.lock.json` (per-file `{sha256}` entries, T05-21), the `check-migrations-immutable` repo check, `pnpm migrations:lock`, and a CI step that fetches `main` for the comparison.
- The SEC-F002-31 lint ban in the control-plane ESLint config.
- Dev-stack `bootstrap` now applies `bootstrap-roles.sql`. The harness gains `dbPassword` and `BOOTSTRAP_ROLES_SQL`. There are dev configs for `migrate` and `migrate --audit`.

### Versions

| Item | Pinned | Evidence |
|---|---|---|
| `kysely` | **0.29.6** (catalog; control-plane dependency) | Published 2026-09-16 (9 days old); the 0.29 line started 2026-05-08. MIT, no dependencies, no install scripts. 0.29 moved `Migrator` and `Migration` to `kysely/migration` (the root exports are deprecated). |
| `pg` / `@types/pg` | 8.23.0 / 8.23.1, moved to the **catalog** | Now used by dev-stack and control-plane (T02 note). |

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T05-1 | **Deviation from §8.2** | Dev-stack `bootstrap` applies `bootstrap-roles.sql` but does **not** run the migrations. They run through the control plane's own commands (`pnpm --filter @ralysa/control-plane migrate:audit:dev`, then `migrate:dev`), and integration tests migrate a fresh database per file. | Bootstrap runs before any build, both locally and in the CI job; the migrations are TypeScript in the control plane. Importing control-plane from dev-stack would create a dependency cycle, since control-plane has dev-stack as a devDependency. |
| T05-2 | Interpretation | `bootstrap-roles.sql` sets no passwords and has no psql meta-commands. The dev stack sets passwords first (T02's SCRAM-over-stdin script), then appends this file to the same stdin. | One file serves the production DBA and the dev stack, and tests can run it through a driver. Passwords stay on the stdin channel (SEC-F002-29). |
| T05-3 | Deviation from §4.3 | Locking schema `public` is in `bootstrap-roles.sql`, not in `cp/0001`. `cp/0001` refuses to run if `ralysa_cp_app` could still create objects in `public`. | `public` belongs to `pg_database_owner`, so the migrator cannot revoke on it. |
| T05-4 | Implementation choice | `GRANT ralysa_audit_owner TO ralysa_audit_migrator WITH INHERIT FALSE, SET TRUE` (PostgreSQL 16+). | The audit migrator has the owner's rights only after an explicit `SET ROLE`, never implicitly. The test checks `pg_has_role(…, 'USAGE') = false` and `'SET' = true`. |
| T05-5 | Design gap, filled | Event-trigger attribution: the org is the caller's `app.org_id`, else the single organization, else the nil UUID. The migrate jobs set `app.org_id` from `config.org.id` on their one connection. When `audit.audit_event` doesn't exist (its own first migration, or after a drop), the DDL goes to the server log as a `WARNING` (`log_line_prefix` names user and client). The trigger also records the audit migration's own DDL. | §4.5 doesn't say which org a DDL event belongs to, and the org can't come from config inside the database. Recording migration DDL too is simply what "any DDL on the audit schema" means. |
| T05-6 | Hardening | Every audit trigger, the region trigger and the event triggers are `ENABLE ALWAYS`, so they also fire under `session_replication_role = replica`. `audit.modify_denied` is written only when the statement touched at least one row. With several orgs in one statement (a superuser, since RLS limits the owner to one org), the event carries the first row's org. | SEC-F002-25 says no Ralysa role may set that GUC (tested); ALWAYS also covers a superuser. A zero-row statement changes nothing and would only add noise. Phase 0 has one organization. |
| T05-7 | Implementation choice | The audit tables have UPDATE and DELETE RLS policies although nobody is granted those operations. | Without a policy, FORCE RLS makes the owner's `UPDATE` match zero rows before the row trigger runs. The statement would change nothing but leave no `audit.modify_denied`, which TC-23 requires. |
| T05-8 | Implementation choice | `cp.organization` has `org_id uuid GENERATED ALWAYS AS (id) STORED`. Every cp table has a foreign key `org_id → cp.organization(id)`. | TC-19: every table has `org_id`. The RLS policy stays uniform. Referential checks bypass RLS, so the app role needs no REFERENCES grant. |
| T05-9 | Deviation from §4.1 (DELETE list) | `ralysa_cp_app` gets DELETE on `cp.group_membership`. It does not yet get DELETE on `cp.auth_session`. | Memberships are "replaced at each sign-in/refresh" (§4.4), which needs DELETE. The 30-day session purge belongs to T08's cleanup job, which will grant it in a new migration. |
| T05-10 | Scope note | `cp.usage_record` has no grants. `ralysa_usage_writer` doesn't exist yet. `cp.kill_switch` is SELECT-only for the app. | The usage writer role and its grant arrive with F-004 (stack.ts already says so). F-012 writes kill switches. |
| T05-11 | Simplification | No down functions at all. | §4.2: `migrate` is up-only everywhere, and downs "exist only for local development". A local reset is `down -v` plus migrate. Unused downs would still be code to keep immutable. |
| T05-12 | Implementation choice | Events generated inside the database (`audit.modify_denied`, `audit.schema_changed`) use `gen_random_uuid()` (v4) and a random 32-hex `trace_id`. | PostgreSQL 17 has no `uuidv7()`. Application events get UUIDv7 ids from the writer (T06). |
| T05-13 | Design gap, filled | `vault.auth` config shapes: `kubernetes {role, jwt_path}`, `approle {role_id, secret_id_path}`, `token {token_env}`. Secret material comes from a file or a named env var, never the config. `KvPath` accepts only `<kv mount>/ralysa/control-plane/…`. | §3.8 names `VaultAuthConfig` without fields. Its rule is that config holds paths and ids only. |
| T05-14 | Scope split with T07 | T05 adds `Common`, `MigrateConfig`, `MigrateAuditConfig`, the common production guards (token auth, AppRole without `allow_approle`, non-https vault, `db.ssl=false`), the YAML loader and `main.ts` with `migrate` only. T07 adds serve, sealer and audit-verify, env overrides, the serve-specific guards and the seal-status check. | The migrate commands are T05's and need a config; building only the shared parts avoids pre-empting T07. |
| T05-15 | Scope note | The SEC-F002-31 tests that an `X-Org-Id` header and a body `org_id` are ignored land with T07's routes. | There is no HTTP surface in T05. The rule itself is documented at `withOrg`. |
| T05-16 | Hardening | `migrations.lock.json` also hashes the shared helpers beside the sets (`ddl.ts`). The check compares against `main`'s lock (the CI `repo-checks` job now fetches `main`) and is a finding in CI if the base can't be read. | Released migrations import `ddl.ts`, so an edit there would change them. Comparing with the base stops a rewritten lock from hiding an edit to a released migration. |
| T05-17 | **Latent T02 bug, fixed** | `turbo.json` now passes `RALYSA_REQUIRE_DEV_STACK` through to `test:integration` (`passThroughEnv`). New `check-turbo-config` rule `turbo/integration-require-env`. | Turbo's strict env mode hid the variable, so `RALYSA_REQUIRE_DEV_STACK=1 turbo run test:integration` **skipped** without a stack instead of failing. CI was not affected: Turbo passes `CI` through, and with the stack down `CI=1` failed as intended. Found while the local stack was stopped (see T05-20). |
| T05-18 | Fix | `listRepoFiles` (repo-scripts) drops files that no longer exist on disk. | `git ls-files --cached` lists a deleted-but-unstaged file. The repo-copy test fixture crashed on T04's deleted `wiring.int.ts`. T04-7's local guard is now redundant but harmless. |
| T05-19 | Test detail | TC-23's TRUNCATE check uses `TRUNCATE … CASCADE`. | A plain `TRUNCATE audit.audit_event` is already refused by the `audit_seal` foreign key (`0A000`) before the guard runs. CASCADE reaches the guard trigger, which refuses with `42501`. |
| T05-21 | Implementation choice | `migrations.lock.json` is `{"version": 2, "migrations": {"<set>/<file>": {"sha256": "…"}}}`, not a flat name → hash map. The unpushed branch was rebuilt so no commit contains the flat form. | gitleaks' `generic-api-key` rule read `"…_tokens.ts": "<sha256>"` as a keyword next to a secret (2 findings in `secret-scan pr`). A nested object fixes this without allow-listing a path, so the scanner stays at full strength. |
| T05-22 | Fix before merge (found starting T06) | The two database-written events now carry the §3.5 catalogue fields. `audit.modify_denied` has `actor.service=audit-store` and `details {op, table, db_role, row_count}`. `audit.schema_changed` is **one event per affected object**, with `actor.service=dba-event-trigger` and `details {command_tag, object_type, object_identity, event, session_user, current_user}`. `current_user` is the caller's effective role, taken from the `role` setting, because inside the SECURITY DEFINER function `current_user` is the function owner. | The first version used its own field names and one event per DDL command. Changed while #19 is unmerged, because `audit/0001` becomes immutable once it's on `main`. |
| T05-20 | Environment note | During the run, the shared dev-stack containers were stopped externally (exit 137), probably by another session using the same `ralysa-dev` compose project and fixed ports. The stack was recreated and every suite re-run. | Only one dev stack can run per machine. Parallel agent sessions should coordinate on it. |

### Tests (T05)

- **Unit** (`test/config.test.ts`, `test/db.test.ts`, 22 cases):
  - env defaults to production;
  - secret-looking values, foreign paths and traversal are refused where a KV path belongs;
  - each migrate job's config names only its own credentials [SEC-F002-02, AR-9];
  - unknown keys are refused; token auth names an env var; errors name fields, not values; the YAML loader;
  - each common production guard, and the same settings allowed in dev;
  - vault auth reads files and env at login time;
  - the migration sets are ordered and up-only, audit runs as the owner via SET ROLE;
  - **the writer column grant equals the input envelope's fields plus the server-set org, source, attestation and client_seq, and never `ts`, `ingest_seq` or `schema_version`** [AR-8];
  - `withOrg` refuses non-UUID and uppercase ids.
- **Integration** (`test/integration/db.int.ts`, 29 cases, one fresh database per file):
  - **TC-F-002-19:**
    - the cp and audit table lists;
    - every table has `org_id`, `relrowsecurity` and `relforcerowsecurity`;
    - `endpoint_region` and `inference_region` exist on both tables;
    - the history schemas exist and are excluded;
    - ownership: the audit store is owned by `ralysa_audit_owner`, cp by `ralysa_migrator`;
    - the role layout: migrator is not a member, the audit migrator is SET-only, the owner is NOLOGIN;
    - migrate twice is a no-op, and `bootstrap-roles.sql` is idempotent.
  - **TC-F-002-23:**
    - the writer gets `42501` on SELECT, UPDATE, DELETE and TRUNCATE, and on inserting `ts` or `schema_version`;
    - the writer can't insert another org's event (RLS WITH CHECK);
    - the cp migrator gets `42501` on `audit.*`;
    - **as the owner via `ralysa_audit_migrator`**, a multi-row UPDATE and DELETE on `audit_event`, `audit_seal` and `audit_checkpoint` changes 0 rows and writes exactly **one** `audit.modify_denied` with `row_count`, and `app.org_id` is restored;
    - TRUNCATE raises on all three;
    - **`ALTER TABLE … DISABLE TRIGGER` and re-enabling write two `audit.schema_changed` events** attributed to the login user and the org;
    - the owner can't alter the event trigger;
    - all rows are still present afterwards.
  - **TC-F-002-27:**
    - a query outside `withOrg` errors for the app and reader roles;
    - the other org's rows are invisible;
    - the pooled connection has no `app.org_id` after `withOrg`, and a query on it errors;
    - `withOrg` refuses an injection-shaped id;
    - `organization.region` is immutable (`23514`) while other columns update.
  - **SEC-F002-25:** no Ralysa role can `SET session_replication_role` (`42501`).
  - **AC-15:** `bootstrap-roles.sql` and `migrate` both refuse a `SQL_ASCII` database; `migrate` refuses the wrong login role for a set.
- **Repo checks:**
  - `check-migrations-immutable.test.ts` (8): shared helpers are hashed and `index.ts` is not; the lock matches; unlocked, changed, helper-changed and missing-file findings; a rewritten lock can't launder a released change; a dropped base entry is flagged; a missing base is a finding in CI only; an invalid lock; the real repository is clean;
  - `check-turbo-config` (2 new): the pass-through rule.
- **Manual:**
  - the built CLI against the dev database: `migrate:audit:dev` and then `migrate:dev` apply 1 and 4 migrations, a rerun applies none, an audit-shaped config given to `migrate` is refused (exit 2), and an unknown command prints usage (exit 2);
  - the lint ban flags `'SET ROLE …'`, `set_config('app.org_id', $1, false)` and `set app.org_id`, passes the `true` form, and exempts `src/db/migrate.ts`.

## Code review of PR #19 (changes requested): resolutions

| # | Finding | Resolution | Evidence |
|---|---|---|---|
| R19-1 | **Blocking.** The SEC-F002-31 lint ban matched single `Literal`/`TemplateElement` nodes. Kysely's tagged ``sql`select set_config('app.org_id', ${org}, false)` `` split around `${}` and passed. `set_config('role', …)` and `SET SESSION AUTHORIZATION` weren't covered. | New rule **`ralysa/no-session-db-settings`** in `@ralysa/eslint-config` (registered in the `ralysa` plugin) replaces the selector ban. It reads string literals and **whole template literals, tagged or not**, joining the quasis with a placeholder. It bans: `SET [SESSION\|LOCAL] ROLE`, `SET SESSION AUTHORIZATION`, `SET [SESSION\|LOCAL] app.…`; `set_config('role'\|'session_authorization', …)` in any form; and `set_config('app.…', …)` unless the third argument is the literal `true`. The third argument is found with a quote- and paren-aware argument split. The control-plane config enables it for `src/**` except `src/db/migrate.ts`. | `tooling/eslint-config/test/session-db-settings.test.ts` (RuleTester, 8 valid and 16 invalid cases, including the tagged-template `false` form, `${local}` as the flag, a missing flag, `role` and `session_authorization`, SET ROLE, SET LOCAL ROLE, SET SESSION AUTHORIZATION, SET app., and nested calls with quoted commas). `services/control-plane/test/lint-config.test.ts`: the rule is `error` for application files and absent only for `src/db/migrate.ts`, and ESLint flags the tagged `false` form in `src/db/kysely.ts`. |
| R19-2 | The owner or a superuser could pre-set `ralysa.modify_denied_rows` (e.g. `-1`) so that no `audit.modify_denied` was written. | `audit/0001` adds `audit.reject_modify_reset()`, a **BEFORE … FOR EACH STATEMENT** trigger (`ENABLE ALWAYS`) on all three tables that resets the row counter and the org before any row trigger runs. A pre-set value can't cancel the count or change the attributed org. | Integration: with `rows=-1` and `org=ORG_B` pre-set, a 3-row DELETE still changes 0 rows and writes exactly one `audit.modify_denied` for ORG_A, and none for ORG_B. |
| R19-3 | Re-login relies on `lookup-self`, which comes from OpenBao's `default` policy. With `token_no_default_policy=true`, every policy 403 would re-login and burn a single-use `secret_id`. | **Decision:** keep the `lookup-self` design, and pin and document the requirement. `TOKEN_NEEDS_DEFAULT_POLICY` sets `token_no_default_policy: false` explicitly on the dev AppRoles and on every Kubernetes-auth role in the template (a typed `false` field). The requirement is written next to the templates, in `auth.ts` and in the secrets README. The alternative (re-login only after the lease half-life) would make an early-revoked token unusable until then; OpenBao's `default` policy is already on every token unless explicitly removed. | Unit: the dev AppRole and every Kubernetes role have `token_no_default_policy: false`. Integration: each entry-point and service AppRole token calls `lookup-self` (200) and lists `default` and its own policy. |

### Open items carried forward (no code in T04–T05)

| # | Item | Where it lands |
|---|---|---|
| OI-1 | The DDL event trigger attributes an event to the caller's `app.org_id`, else the single organization, else the nil UUID (T05-5). Once there are several orgs, a DDL statement belongs to no org. This needs a system scope or one event per org. | Revisit with multi-org (F-006+); the DDL change must also be recorded for off-host log checks. |
| OI-2 | `KvPath` in the config accepts `<any mount>/ralysa/control-plane/…` but isn't cross-checked against `vault.kv_mount`. | F-002-T07 (config work): a refinement at load time. It must be a load-time check, not a zod refinement, because R-6 bans refinements on wire schemas. |

## T06: audit core

Branch `feat/F-002-audit-core`, stacked on `feat/F-002-secrets-db-audit` (#19).

### What landed

- `src/audit/columns.ts`: `toColumns()` maps the envelope to the `audit_event` columns (the writer's side). `StoredEventInput` is the input envelope plus the server-assigned `source`, `attestation` and `client_seq`.
- `src/audit/sealer/chain.ts`: `rowToEnvelope()` (the only way back from a row), `rowEventHash()`, `verifySeals()` (reports the first divergent seq, with a reason of `seq_gap`, `prev_hash_mismatch`, `event_hash_mismatch` or `hash_mismatch`), and `verifyChain(db, org, shard)`.
- `src/audit/writer.ts`: `createAuditWriter()`.
  - `write()` fails closed with savepoint inserts, `23505` → `duplicate`, a 250 ms bound (JS race plus a transaction-local `statement_timeout`), and `AuditUnavailableError`.
  - `writeOrSpool()` sends the batch to the spool on unavailability.
  - `validateStoredEvent()` applies the strict input schema, I-JSON, `failure` only on `auth.*`, and `client_seq` only on client events.
- `src/audit/spool.ts`, `src/audit/rejections.ts`, and `src/audit/events.ts` (the `systemEvent`, `tokenRejectedEvent` and `migrationAppliedEvents` builders).
- `src/audit/sealer/sealer.ts`: `sealOnce()` (per-shard transaction with `pg_try_advisory_xact_lock`, head, 10,000-row lookback with an anti-join, batch of 1,000, lag gauge; the sweep drops the lookback and counts `audit_seal_late_total`) and `runSealerLoop()`.
- `main.ts`: the `sealer` entry point (`SealerConfig`: `audit_sealer` credential only). Both migrate jobs now write `db.migration.applied` through the writer role.
- `@ralysa/protocol/common` `uuidv7()` (RFC 9562), used for control-plane event ids.
- `src/observability/`: `Metrics` and `Logger` ports with no-op, in-memory and JSON-line implementations.

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T06-1 | Deviation from §2.2 | UUIDv7 comes from a 20-line `uuidv7()` in `@ralysa/protocol/common` (WebCrypto randomness), not the `uuid` package. | One small, fully tested function is less supply-chain surface than a dependency, and the protocol package is isomorphic anyway. |
| T06-2 | Scope split with T16 | `SealerConfig` has `interval_ms`, `sweep_interval_s` and `db_credentials.audit_sealer`. T16 adds `checkpoint_key` and `checkpoint_interval_s` when the sealer starts signing. | Checkpoints are T16's (design §10). |
| T06-3 | Design gap, filled | Metrics and logs go through minimal ports (`Metrics.increment/gauge`, a JSON-line `Logger`). T07 binds them to the service's exporter and pino with its redaction. | The design names the metrics (`audit_write_failures_total`, `audit_spool_lost_total`, `audit_seal_lag_seconds`, `audit_seal_late_total`) but the service's metrics and logging stack is T07's. |
| T06-4 | Interpretation | "Seal lag" is the age of the oldest event sealed in a pass, measured on the database clock at sealing. Above 5 s the loop logs `audit_seal_lag_high`. The alert itself is on the gauge. | §4.6 sets the target (≤ 5 s) and the metric but not how it's measured. The database clock avoids host skew. |
| T06-5 | Interpretation | `writeOrSpool()` spools only on `AuditUnavailableError`. An invalid event (a programming error) is thrown, never spooled. The spool isn't wired to an entry point yet: `serve` (T07) opens it with `persistent` from config. | A bad event can never become valid, so spooling it would just replay a failure forever. |
| T06-6 | Implementation choice | `auth.token_rejected` has `actor.type=user` with every id null (the caller is unauthenticated), plus `details.client_network` (the /24 or /64 aggregation key) alongside `client_ip`. | The catalogue lists `audience`, `reason`, `client_ip` and `suppressed_count`. The network makes the summary rows auditable. |
| T06-7 | Implementation choice | If `db.migration.applied` can't be written after the migrations committed, the migrate job exits 1 with "migrations applied but db.migration.applied was not recorded". | SR-29 requires the migration path to be audited. The migrations can't be undone, so a visible failure is the honest outcome, and the job is one-shot and operator-run. |
| T06-8 | Hardening | `validateStoredEvent` rejects `client_seq` on a server-attested event and reserved keys under `details.client`. | Server provenance stays unambiguous ahead of T12's client path. |

### Tests (T06)

- **Unit** (39 new cases):
  - `audit-chain.test.ts`:
    - **the stored row hashes to the protocol's frozen golden vector** (`939a8a46…`, and chain `18c0ae2e…`), so `toColumns` → row → `rowToEnvelope` round-trips byte-exactly;
    - absent and null fields hash alike;
    - `ts` always has 3 digits and `Z`;
    - structured members and bigint map back;
    - every value change changes the hash;
    - `verifySeals` accepts an intact chain and pinpoints a changed event, a broken link, a missing seal and a wrong `prev_hash`.
  - `audit-writer.test.ts`: validation refusals; UUIDv7 system events; `db.migration.applied` with the lock checksum (`unknown` when absent); `auth.token_rejected` with and without `suppressed_count`.
  - `audit-spool.test.ts`: directory `0700` and files `0600`; replay order, `original_ts` and `spooled`, then deletion; stop-and-keep on failure; a symlinked directory refused; `audit_spool_lost_total` only when not persistent.
  - `audit-rejections.test.ts`: /24 and /64, including mapped IPv4 and `::`; 20 then a summary with `suppressed_count`; per-key isolation; the 600 per minute instance cap.
- **Integration** (`test/integration/audit.int.ts`, 11 cases):
  - `db.migration.applied` for all 5 migrations with checksums;
  - store and duplicate (a duplicate mid-batch doesn't fail it) [AR-8];
  - **fail-closed in under 1 s** while the table is locked, with the metric incremented;
  - **a spooled denial replayed** with `details.server.spooled` and `original_ts` [SEC-F002-24];
  - the aggregator writes 2 events and then one summary with `suppressed_count=3`;
  - all shards sealed and `verifyChain` ok, and a second pass is a no-op;
  - **the running loop seals a new event within 5 s**;
  - **three concurrent sealers (two pools, batch 7) never fork: 30 seals and a valid chain** [SEC-F002-26];
  - **a late-committing event is sealed on the next pass** at seq 2;
  - **a superuser rewrite of a sealed event (triggers disabled) is reported at seq 2 as `event_hash_mismatch`**, and the event trigger recorded the `ALTER TABLE`s [AR-6];
  - the sealer role can't update seals or insert events.
- **Manual:** the built CLI against the dev database. `migrate:audit:dev` and `migrate:dev` recorded 5 `db.migration.applied` events. `start:sealer` sealed the 66 events in the `control-plane` shard, including the DDL events from the migrations, and stopped cleanly on SIGTERM (exit 0).

### Code review of PR #21 (changes requested): resolutions

| # | Finding | Resolution | Evidence |
|---|---|---|---|
| R21-1 | **Blocking.** After the 600/min cap, every new (network, reason, audience) still got a bucket and a summary, so spreading across many /24s or /64s flooded the store, and the Map grew without bound (§6.4, SEC-F002-16). | The aggregator now bounds both output and memory. A key bucket exists only for a key that got an individual event, so there are at most 600. After the cap, rejections from keys without a bucket go to one **overflow bucket per (reason, audience)**: at most 20, then one catch-all per org. Each overflow bucket counts distinct networks up to a cap of 1,024 instead of storing them. At close, per-key summaries go out for the 50 buckets with the most suppressed rejections, and the rest fold into the overflow summaries (`network: overflow`, `suppressed_count`, `details.networks_suppressed`). A window therefore emits at most 600 + 50 + 21 events whatever the traffic, and every rejection is either written or counted. | `audit-rejections.test.ts`: 10,000 distinct IPv4 /24s and 10,000 distinct IPv6 /64s (plus repeat traffic) each give ≤ 671 events, ≤ 600 key buckets, ≤ 21 overflow buckets and ≥ 1 overflow summary with counts; the sum of written plus suppressed equals the input; the maps are empty after close; the network count saturates at 1,024. |
| R21-2 | Spool durability and corruption handling. | Each file is written to a temp name with `wx` and mode 0600, **fsync'd**, renamed, and the **directory fsync'd**. Stale `.spool-*.tmp` files are removed at start (never acknowledged). On replay, a file that doesn't parse or has `version !== 1` (or a bad shape) is **moved to `quarantine/`** (0700) with `audit_spool_quarantined_total` and an error log, and the replay continues. | `audit-spool.test.ts`: a corrupt file and a version-9 file are quarantined, the valid file is replayed, and the metric equals 2; a stale temp file is removed at start. |
| R21-3 | Document that a write may commit after the 250 ms timeout reported failure. | Comment at the race in `writer.ts`, citing §5.8: the caller refused or spooled, and a later replay of the same `event_id` is `duplicate`. The README describes the same. | — |
| R21-4 | `migrations.lock.json` isn't in `dist`, so the checksum was `'unknown'`. | `pnpm migrations:lock` now also writes `src/db/migration-checksums.generated.ts`, nested like the lock so the secret scanner stays quiet. `check-migrations-immutable` fails with `migrations/checksums-module-stale` when it disagrees with the lock. `migrationAppliedEvents` **throws** when a checksum is missing. The generated file is in `.prettierignore` (the generator owns its format). | `check-migrations-immutable.test.ts`: a stale module is a finding. `audit-writer.test.ts`: a missing checksum throws. Integration: all 5 `db.migration.applied` rows carry 64-hex checksums. |
| R21-5 | T06-7's failure mode (migrations committed, event not recorded) needs a reconcile. | **Open item OI-3** (below). No code in T06. | — |
| R21-6 | Found while re-running the suite | The aggregator integration test asserted `ingest_seq` order, but the emitted writes run concurrently, so it was flaky (1 in 3 local runs). It now compares the rows order-independently; 5 consecutive runs pass. | — |
| R19-c1 | Carried from #19: unclosed `set_config` calls weren't flagged. | The setting name is read by its own regex right after `set_config(`, so `"… set_config('role', " + x` is judged by its first argument. An unclosed `app.*` call is refused, since it can't be shown to be local. | RuleTester: 3 new invalid fixtures (`role` by concatenation, unclosed `app.org_id … false`, unclosed `session_authorization` template) and 1 valid one (an unclosed unrelated setting). |
| R19-c2 | Carried from #19: the `DEV_APPROLE` doc comment was displaced by `TOKEN_NEEDS_DEFAULT_POLICY`. | Moved back above `DEV_APPROLE`. | — |

### Open items (continued)

| # | Item | Where it lands |
|---|---|---|
| OI-3 | Reconcile for missed `db.migration.applied`: compare `ralysa_meta*.migration` (name, `executed_at`) with the recorded events and write any missing ones (marked `details.server.reconciled=true`), from the migrate job at start or from `audit-verify`. | T16 (`audit-verify`) or a follow-up; T06-7 makes the gap visible (exit 1) meanwhile. |
