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

### Nits folded in after #21 merged

- The `writeMigrationsLock` doc comment is back above its function; `renderChecksumsModule` has its own.
- `Rejection.orgId` is documented: it must come from deployment config or another verified source, never from the rejected (unverified) token's `tid`, because the aggregator's output and memory bounds depend on it. **T07 and T11 must wire it that way** (tracked below as OI-4).

| # | Item | Where it lands |
|---|---|---|
| OI-4 | The rejection aggregators must take `orgId` from `config.org.id` (control plane) or the verifier's configured org (`packages/auth`), never from an unverified token. | T07 (control-plane verifier path) and T11 (packages/auth rejections); each adds a test. |

## T16: signed chain-head checkpoints and `audit-verify`

Branch `feat/F-002-checkpoints` (on `main` after #21).

### What landed

- `@ralysa/protocol/audit`: `checkpointPayload()` (the JCS of `{org_id, shard, seq, hash, checkpoint_ts}` with input checks) and `CHECKPOINT_KEY`. T03-9 deferred this here. It lives in the protocol package so F-011's verifiers use the same bytes.
- `src/audit/sealer/checkpoint.ts`:
  - `createCheckpointSigner()`: the custody monitor. `poll()` describes the key and stays unhealthy until the first successful describe. A flag flip writes one `secret.custody_violation` per violation and sets the `secret_custody_violation` gauge to 1. Signing resumes when the flags clear. A describe failure keeps the last state and never signs blind.
  - `checkpointOnce()`: per shard, under the seal pass's advisory lock; head versus last checkpoint; the database clock (ms) for `checkpoint_ts`; signs with the latest version; inserts the row; logs one `audit_checkpoint` line with the same values (signature base64url).
- `runSealerLoop` takes `checkpoints: { signer, intervalMs (60 s), custodyPollMs (30 s) }`.
- `src/audit/verify/audit-verify.ts`:
  - `auditVerify()` checks signatures (WebCrypto ECDSA P-256 SHA-256 against each version's JWK), recomputes the chain **from the events** (and reports stored-seal inconsistencies as `chain_broken`), checks each checkpoint's agreement with it (`checkpoint_mismatch`, `checkpoint_beyond_chain`), checks cadence (`checkpoint_gap`), and compares the logged checkpoints (`checkpoint_missing`, `checkpoint_log_mismatch`). It reports the first divergent seq per shard.
  - `parseCheckpointLog()` reads JSONL.
- Config: `SealerConfig` gains `checkpoint_key`, `checkpoint_interval_s`, `custody_poll_s` and `db_credentials.audit_writer`. New `AuditVerifyConfig` (`checkpoint_key`, reader only).
- `main.ts`: the sealer runs with checkpoints. New `audit-verify` command: exit 1 on any finding, and on a checkpoint-key custody violation. Dev configs and `audit-verify`/`audit-verify:dev` scripts.
- The dev-stack policy `ralysa-cp-sealer` also reads `db/audit_writer`.

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T16-1 | **Deviation (self-decided under the standing authorization), now remediated** | *Remediated 2026-09-25, see "T16-1 remediation" below.* Originally: the sealer wrote `secret.custody_violation` through the insert-only **`ralysa_audit_writer`** credential. Its config and OpenBao policy gain `db/audit_writer`, and `ralysa_audit_sealer` keeps SELECT on events only. | ~~§3.5 has the sealer write that event, but §4.1 gives the sealer role no INSERT on events, and `audit/0001` is released (immutable). The writer role is the least privilege that works: it can only insert writer columns, like the migrate jobs' use of it.~~ **Superseded by the SEC-F002-34 remediation (#24).** Immutability of `audit/0001` didn't rule out a new migration. `audit/0002`'s SECURITY DEFINER `audit.record_custody_violation()` is strictly less privilege, and the writer credential was removed from the sealer. |
| T16-2 | Interpretation (amended by SEC-F002-35 a) | During a custody violation the sealer **keeps sealing** and only stops checkpoint signing, and the stop is terminal (flags can't be cleared). | §3.2.4 says "stops signing". The hash chain uses no key, and stopping it would add a second gap. `audit-verify` reports the missing checkpoints as `checkpoint_gap`. The sealer has no HTTP `/readyz`, so the "unready" signal is the `secret_custody_violation` gauge plus an error log (the alert input). |
| T16-3 | Implementation choice | `audit-verify` compares checkpoints with the chain **recomputed from events**, not with the stored seals. The stored seals are also checked separately (`chain_broken`). | An owner who rewrites an event and recomputes every later seal leaves stored seals that are self-consistent (`verifyChain` passes: tested), so only the recompute from events against the signed hash catches it (§4.5 residual, SEC-F002-01 c). |
| T16-4 | Implementation choice | The cadence check uses each seal's `sealed_at` for the "newest seal older than 120 s" rule. `now` is injectable. | The design's rule is about sealed data not covered by a checkpoint. Injecting `now` lets the test assert the gap without waiting 2 minutes. |
| T16-5 | Implementation choice | A checkpoint-key custody violation makes `audit-verify` fail (exit 1) without verifying. | `describe()` refuses such a key, and signatures made with a key that may have been exported can't vouch for the chain. |
| T16-6 | Scope note | The reconcile of missed `db.migration.applied` events (OI-3) isn't in this PR. | It needs history-table access that the reader role doesn't have (`ralysa_meta*` belongs to the migrators). It stays an open item for a follow-up with its own grant. |

### Tests (T16)

- **Unit:**
  - `checkpointPayload`: the exact JCS bytes, and malformed hash, ts and seq refused (protocol, +4).
  - `checkpoint.test.ts` (+7):
    - the signer isn't healthy before its first poll;
    - it signs with the latest version, and the signature verifies over the payload with WebCrypto;
    - flipping `exportable` or `allow_plaintext_backup` stops signing and writes exactly **one** `secret.custody_violation` across repeated polls; signing resumes when the flags clear;
    - the sealer and audit-verify configs name only their own credentials;
    - `parseCheckpointLog` keeps only well-formed lines.
- **Integration** (`test/integration/checkpoint.int.ts`, TC-F-002-29 and the sealer part of TC-33, with a throwaway Transit key per run):
  - the running loop (2 s checkpoint interval) writes checkpoints; **the logged lines equal the rows**; the last checkpoint covers the head; `audit-verify` with the log is clean;
  - **a stopped sealer gives `checkpoint_gap`** at the uncovered seq, and it clears after a checkpoint;
  - **the audit owner (via `ralysa_audit_migrator`) disables triggers, rewrites seq 2 and recomputes every seal**: `verifyChain` on the stored seals passes, while `audit-verify` reports `checkpoint_mismatch` at **the first checkpoint covering seq 2**, and nothing before it;
  - **the owner deletes the newest checkpoint**: nothing is reported without the log, and `checkpoint_missing` is reported with it;
  - **flipping `exportable` on the checkpoint key at runtime**: `poll()` returns false, no checkpoint is signed, and one `secret.custody_violation` (`actor.service=sealer`, `flag=exportable`) is in the store.
  - 3 consecutive full runs: 46/46.
- **Manual (dev stack):** `start:sealer:dev` wrote a checkpoint and its log line. `audit-verify:dev --shard control-plane --log-checkpoints sealer.log` checked 66 seals and 1 checkpoint: ok, 0 findings, exit 0.

## T16-1 remediation (security review, SEC-F002-34; branch `fix/F-002-sealer-custody-fn`)

The security review of deviation T16-1 is appended verbatim to security.md: **ACCEPT-WITH-CONDITIONS**, with the remediation required before G6. This change implements §B and the fixes that came with it.

### What changed

- **`audit/0002_custody_violation_fn`** (B1–B8): `audit.record_custody_violation(p_key, p_exportable, p_allow_plaintext_backup) RETURNS boolean`.
  - It is SECURITY DEFINER, owned by `ralysa_audit_owner`, with `search_path = pg_catalog, pg_temp`, every object schema-qualified, and no dynamic SQL.
  - It accepts only the key `ralysa-audit-checkpoint`, and at least one flag must be true; anything else raises `22023`.
  - Every field is fixed by the function, and the org comes from `audit.current_org()`.
  - An advisory lock plus a 5-minute dedupe per (org, key, flag pair) means repeated calls never duplicate an event.
  - EXECUTE is granted to `ralysa_audit_sealer` only.
  - The migration is in `migrations.lock.json` and the generated checksums.
- **The sealer no longer holds a writer credential** (B9):
  - `SealerConfig.db_credentials` is `audit_sealer` only (a writer path is refused);
  - `main.ts` has no writer pool and records through `dbCustodyRecorder` on the sealer pool;
  - the `ralysa-cp-sealer` policy no longer reads `db/audit_writer`, and the dev YAML is updated;
  - design §4.1, §4.6 and §6.5 now say the deviation was remediated.
- **SEC-F002-39:** the signer tracks what it has recorded separately from the violation and retries on every poll until the database confirms it.
- **SEC-F002-40:** both flags are recorded, and a second flag appearing later is a new pair.
- **SEC-F002-35 (a):** a violation is **terminal**. The "restored" branch is gone: a flagged key that later reads clean can only mean it was recreated (SEC-F002-37), so it is logged as `checkpoint_key_clean_after_violation` and signing stays stopped.
  - The integration test shows that **OpenBao 2.6.2 answers 200 to a request clearing either flag and leaves the flag set**, so the request succeeds but nothing is cleared.
  - The README has a runbook covering irreversibility and recovery.
- **#23 review nits:**
  - an integration case for `allow_plaintext_backup` alone;
  - `audit-verify`'s cadence check now uses the **database** clock (`clock_timestamp()` over the reader connection);
  - every `audit-verify` read runs in a **READ ONLY** transaction (`withOrg(…, { readOnly: true })`);
  - the runbook note.
- The recorder records the **logical** key name (`ralysa-audit-checkpoint`, the config literal), independently of the Transit key the custody monitor describes. In production they are the same. The integration tests use throwaway Transit keys, because a flag flip can't be undone.

### Tests

- **Unit:**
  - the violation is recorded with both flags for each of the three flag combinations;
  - it is terminal (the key reading clean again doesn't resume signing);
  - recording is retried until confirmed (two failures, then success, then no further calls);
  - a second flag is recorded as a new pair;
  - **T9:** a sealer config naming `audit_writer` or `migrator` is refused.
- **Integration** (`custody-fn.int.ts`):
  - **T1**: all the fixed fields, attributed to the org;
  - **T2**: 7 invalid inputs each give `22023` and no row;
  - **T3**: dedupe, a new pair and two concurrent sessions give exactly one row;
  - **T4**: writer, reader, app and migrator roles get `42501`, and PUBLIC can't execute it;
  - **T5**: without `app.org_id` it fails;
  - **T6**: `pg_proc` shows definer, search_path and owner;
  - **T7**: the sealer still can't insert events directly;
  - **T11**: one `audit.schema_changed` for the CREATE FUNCTION.
- **Integration** (`checkpoint.int.ts`): **T10**, flipping `exportable` records one event (`via: audit.record_custody_violation`, both flags); the flag can't be cleared; `allow_plaintext_backup` alone is recorded with that pair.
- **Integration** (policies): **T8**, the sealer is DENIED on `db/audit_writer`.
- control-plane integration passed 62/62 twice.
- **CI found a harness race.** With a fourth integration file, parallel per-file bootstraps collided on `ALTER ROLE` of the shared cluster roles (`XX000 tuple concurrently updated`). `createTestDatabase` now serialises `bootstrap-roles.sql` with an advisory lock held in the shared admin database (advisory locks are per database). 3 consecutive local runs pass 62/62. Production is unaffected: the DBA runs the script once.

### Conditions and open items (security review §E)

| # | Item | Blocks |
|---|---|---|
| SEC-F002-34 | Remediated here (§B, T1–T11). Conditions A1–A4 are met: the writer credential is gone, so A1's production refusal and A3's narrowness test no longer apply. | — |
| SEC-F002-35 (b) | Recovery by key epoch: `checkpoint_key` matching `^ralysa-audit-checkpoint(-[0-9]{1,4})?$`, a new audit migration adding the key id or thumbprint to `audit_checkpoint` and binding it into a payload v2, and `retired_checkpoint_keys` in `AuditVerifyConfig`. | **G6**, unless a named human owner accepts it in writing as an F-011 prerequisite |
| SEC-F002-35 (c) | With a flagged key, `audit-verify` still recomputes the chain and reports `key_custody_violated` (checkpoints before `compromised_at` count only with matching log lines). | G6 (same) |
| SEC-F002-35 (d) | A full "checkpoint key compromised" runbook (the README has the interim version). | G6 (same) |
| SEC-F002-36 | Pin the trust anchor: log each key version's JWK thumbprint at sealer start and in each checkpoint line; `audit-verify` takes pinned thumbprints. Separate the OpenBao admin from the DB superuser. | G6 (same) |
| SEC-F002-37 | A key recreated under the same name: the signer already stays stopped (terminal). Thumbprint tracking makes it detectable outside the process's lifetime. | G6 (with -36) |
| SEC-F002-38 | Without the log, tail truncation is invisible: `audit-verify` should report `anchor: none` with a distinct exit code and require `--log-checkpoints` outside dev and test, with the log shipped off-host. | **Any non-dev deployment** |

### Nits folded in after #24 merged

- The custody-function test T5 now asserts the specific code: on a fresh connection that never set `app.org_id`, `audit.current_org()` raises **`42704`** (unrecognized parameter). On a pooled connection where the setting was set transaction-locally before, the placeholder is `''` and the uuid cast raises `22P02`; both fail closed. The test uses a fresh pool.
- The T16-1 row's original rationale is struck through and marked superseded by the SEC-F002-34 remediation.
- status.md "Open items" lists SEC-F002-35 (b)–(d), -36 and -37 (block G6 unless a named human accepts them in writing as F-011 prerequisites) and -38 (blocks any non-dev deployment).

## T07: control-plane app skeleton and keys

Branch `feat/F-002-app-skeleton` (on `main` after #24).

### What landed

- **Config** (`src/config/`):
  - `ServeConfig` (§3.8) plus `access.mfa_claim_exception_ref`, `rate_limits`, `audit.{spool_dir, spool_persistent}` and bounds on `tokens`.
  - `crossFieldIssues()`: every KV path is under `vault.kv_mount` (**closes OI-2**); service audit actions may be allow-listed [SEC-F002-03]; the service client id and Transit key follow the service name; names are unique.
  - `mfaClaimRequired()`.
  - Env overrides `RALYSA_CFG__<PATH>`.
  - `serveProductionRefusals()` and the async `openBaoStorageRefusals()` (`sys/seal-status`: in-memory, sealed or unreachable).
- **HTTP** (`src/http/`):
  - zod validation and response serialization (a response that breaks its contract fails closed);
  - problem+json and OAuth errors with one error handler;
  - request context: UUIDv7 request ids never taken from the client, traceparent continued or started and echoed, `orgId = config.org.id`;
  - logging: request logging off, one onResponse line with the route template, pino `redact`, and a `formatters.log` scrubber;
  - in-memory per-IP and global rate limits on the unauthenticated prefixes;
  - route contracts, and the OpenAPI 3.1 generator.
- `src/app.ts`: `buildApp()` (no listen) with health, readiness and discovery.
- `src/auth/tokens/signing-keys.ts`: `selectActiveVersion`/`jwksRows` (pure) and `createSigningKeys()` (the watcher: publish, activate, retire, the custody monitor, JWKS from the database, the database clock).
- `src/auth/tokens/mint.ts`: `mintAccessToken()`.
- `src/auth/routes/discovery.ts`: RFC 8414 metadata, JWKS, `/v1/auth/config`.
- `src/org/bootstrap.ts`: `ensureOrganization()`.
- `src/serve.ts`: the `serve` and `bootstrap-org` entry points (dispatched from `main.ts`).
- `openapi/control-plane.v1.json`, generated, committed, and in `.prettierignore`.
- `deploy/docker/dev/control-plane.serve.dev.yaml`.

### Versions

| Item | Pinned | Evidence |
|---|---|---|
| `fastify` | **5.12.5** (control-plane dependency) | Published 2026-09-16; the 5.12 line started 2026-08-13 (43 days). MIT. No install scripts (the install passes `strictDepBuilds`). |
| `jose` | 6.2.12, moved to the **catalog** | Now a devDependency of both secrets and control-plane (tests only). |

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T07-1 | Deviation from §2.2 | Rate limits are a small in-memory limiter (`src/http/rate-limits.ts`: per-IP and global one-minute windows, a bounded IP map), not `@fastify/rate-limit`. | The design needs a per-IP **and** a global limit on route prefixes, with an OAuth error body on `/oauth2/*`. That is about 40 lines, versus a dependency configured twice. Both are per-instance in memory, like the plugin's default store. |
| T07-2 | Scope | `@fastify/formbody` and `@fastify/cookie` aren't added yet. | They serve the OAuth endpoints and the flow-B cookie (T08/T10), which add them with their routes. |
| T07-3 | Design gap, filled | `/v1/auth/config` derives the IdP device and token endpoints from the pinned issuer (Entra: `<authority>/oauth2/v2.0/devicecode` and `/token`). `cli_client_id` is the first of `idp.allowed_public_client_ids`. | §3.4.1 says "from the pinned tenant's discovery document". Fetching it is T10's IdP client; for Entra the two URLs are fixed under the authority. |
| T07-4 | Interpretation | The RFC 8414 metadata already lists the authorize, token and revoke endpoints and the four grants, although those routes land in T08 and T10. | The metadata describes the F-002 surface, and F-002 is released as a whole: no release is cut between T07 and T10. |
| T07-5 | Design gap, filled | The **first** signing key ever is active at once. Later versions wait `activation_delay_s` on the database clock. | Publish-then-activate protects a switch from one key to the next; with no previous key there is nothing to keep signing with. |
| T07-6 | Implementation choice | `/readyz` is ready when the database answers, a signing key is active, the last successful poll is younger than max(30 s, 2 × `key_poll_s`), and there is no custody violation. | §3.1 and §5.8: "unready after 30 s" of OpenBao trouble shows up as a stale poll. |
| T07-7 | Implementation choice | `SigningKeys.sign(build)` gives the builder the active version's `kid` before signing, so the header's `kid` and the signing version can't disagree. | The kid is derived from the configured key name and the version [SEC-F002-19]. |
| T07-8 | Implementation choice | Responses are serialized through their zod contract (`safeParse`). A response that doesn't match fails with 500 instead of leaving. | The OpenAPI document is generated from the same contracts, so what is published is what is sent. |
| T07-9 | Implementation choice | `serve` and `bootstrap-org` live in `src/serve.ts`, and `main.ts` only dispatches. | It kept the rebase conflicts with the sealer and audit-verify work small. |
| T07-10 | Scope | `ensureOrganization` reports `deviceCodeChanged`. Revoking live flow-A sessions when `device_code_enabled` turns off is T10's device-code switch. | §3.8 and SEC-F002-32 assign the revocation to T10. |
| T07-11 | Scope | OI-4 (the rejection aggregator's `orgId` from config) stays open: T07 serves no authenticated route, so nothing verifies tokens yet. | The control plane's own verifier path arrives with T08 (`/v1/me`, internal routes) and T11. |
| T07-12 | Scope | The one server-rendered i18n string (`auth.error.invalid_authorize_request`) belongs to the authorize route (T10). | §3.9. |
| T07-13 | Implementation choice | Signing-key events use `actor.service = rts`, with `credential_ref_hash` = SHA-256 of `transit/<key>`. | §3.5 lists `credential_ref_hash`. The raw path is not a secret, but the hash keeps the event shape stable. |

### Tests (T07)

- **Unit** (147 in control-plane, 38 new for T07):
  - `config-serve.test.ts`:
    - **TC-F-002-36**: serve refuses migrator, audit_migrator and sealer credentials; the sealer accepts only its own; secret-looking values, a `client_secret` key and a group name are refused;
    - the `kv_mount` check and reserved service actions;
    - errors never carry values;
    - env overrides can't inject a credential;
    - **TC-F-002-34**: each guard (token auth, AppRole without opt-in, `http://` for vault and public URL, `db.ssl`, `0.0.0.0/0` and `::/0`, non-Entra issuer, http or other-tenant issuer, non-Graph base, MFA claim off) refuses, as do OpenBao in-memory, sealed and unreachable; the MFA exception works; an unset env behaves as production.
  - `logging.test.ts`: the scrubber cases (JWT, refresh token, code, OpenBao token, form secrets, URL credentials); redaction paths; serializers drop raw requests and responses.
  - `signing-keys.test.ts`: the first key at once; activation exactly at the delay; the AC-10 budget; pin; retired keys; JWKS retention.
  - `app.test.ts`:
    - health and readiness (DB, custody and no-key failures give 503);
    - metadata, JWKS (public members only, Cache-Control) and auth config;
    - traceparent continued or new; problem+json 404 without echo;
    - **per-IP and global rate limits with Retry-After**, and the OAuth-form 429;
    - **the request log line has the route template and no query, token, header or cookie**;
    - **`X-Org-Id` and a body `org_id` are ignored** (SEC-F002-31).
  - `openapi.test.ts`: the committed file equals the generator output; every contract is a registered route; no password or client secret.
  - `mint.test.ts`: the minted token verifies with `jose` against the JWKS, and its header is exactly `{alg, typ, kid}`; a service token; bad claims (an array audience, an unknown audience, a non-UUID sub) are never signed; minting is refused during a custody violation.
- **Integration** (`serve.int.ts`, 6):
  - the Organization is created once, a region change is refused, and the device-code flag is stored;
  - `/readyz` is ready, **JWKS lists the active key, and a minted token verifies with jose against the served JWKS**;
  - **rotation: v2 is published at once while v1 still signs, v2 signs after the delay, v1 stays in JWKS until retention and is then retired, with `secret.rotated` events published:v1, activated:v1, published:v2, activated:v2, retired:v1**;
  - **startup refuses a key with `allow_plaintext_backup`** (TC-14 part);
  - **TC-F-002-33**: flipping `exportable` at runtime gives 503 on `/readyz`, minting refused, and exactly one `secret.custody_violation`; the same for `allow_plaintext_backup`.
- **Manual (dev stack):** `start:dev` came up ready. JWKS served `ralysa-rts-signing.v1`, and `traceparent` was echoed. A request with `?code=rly_ac_TOPSECRET…` left no trace of it in the log. SIGTERM stopped it cleanly (exit 0).

### Code review of PR #25 (changes requested): resolutions

| # | Finding | Resolution | Evidence |
|---|---|---|---|
| R25-1 | **Blocking (Critical).** Rate limiting matched the raw URL, so percent-encoded paths (`/%2Ewell-known/jwks.json`, `/%2ewell-known/…`, `/v1/%61uth/config`) reached the routes and skipped both limits. | `limitedFamily()` decides on the **matched route template** (`request.routeOptions.url`, available in `onRequest`). A request matching no route is judged on its decoded, lower-cased path, and an undecodable one is limited. The same decision picks the 429 body (OAuth on `/oauth2/*`, problem+json elsewhere). | `app.test.ts`: the three encoded paths hit the real route once and then get 429; an encoded `/oauth2/token` gets the OAuth 429 body. |
| R25-2 | **Blocking (Major).** `RALYSA_CFG__ENV=dev` over a production file switched off every production guard (SEC-F002-12). | Overrides of `env`, `vault.auth.*`, `vault.allow_approle`, `trust_proxy_cidrs`, `idp.issuer`, `idp.require_mfa_claim` and `access.mfa_claim_exception_ref` are refused with a `ConfigError`. The last one is added because it switches the MFA requirement off. Settings the production guards already check (`vault.addr`, `db.ssl`, `public_base_url`, `graph_base_url`) stay overridable; the guards still apply. The **names** of applied overrides are reported at start (`config_overrides`), never values. | `config-serve.test.ts`: `RALYSA_CFG__ENV=dev` over the production fixture is refused; each protected key is refused; applied names are reported, values aren't. |
| R25-3 | Log scrubbing gaps: message strings, depth, and Logger-port lines outside pino. | One pino instance per serve process (`createPinoLogger`), passed to Fastify as `loggerInstance`. The Logger port for the key watcher, spool and start-up is built on it (`loggerFromPino`, as T06-3 promised). `hooks.logMethod` scrubs message strings. `scrubValue` replaces anything deeper than 8 levels with `[REDACTED:depth]`. The one-shot entry points' JSON logger scrubs message and fields too. | `logging.test.ts`: a JWT and a refresh token in the message are scrubbed; a deeply nested secret is redacted; a Logger-port line has redaction and scrubbing (`body.code` redacted, URL credentials and JWTs scrubbed); the JSON logger scrubs. |
| R25-4 | IPv6 per-IP limiting let one host spread across its /64. | `clientKey()`: IPv6 is keyed by /64 (`networkOf()` from `audit/rejections.ts`); IPv4 and IPv4-mapped by address. | `app.test.ts`: two addresses in one /64 share the limit; another /64 has its own. |
| R25-a | RTS custody should behave like the sealer's. | The RTS watcher's custody violation is **terminal**. All three conditions (`exportable`, `allow_plaintext_backup`, `key_replaced`) are recorded, and recording is retried every poll until it lands (SEC-F002-39/-40). **A stored version whose public key no longer matches Transit's is treated as the key having been recreated** (SEC-F002-37). The watcher reads only its own key's rows (`kid LIKE <key>.v%`). | `serve.int.ts`: after the flip, more polls change nothing and record nothing more; `allow_plaintext_backup` is recorded with its pair; **a key deleted and recreated under the same name is flagged `key_replaced` and minting stops** (second org, since `cp.signing_key_version` is one key per org by design: `UNIQUE (org_id, version)`). |
| R25-b | The OpenAPI password test pattern was too narrow. | TC-F-002-05's substring pattern `/pass(word\|wd\|phrase)\|\bpin\b\|otp\|client_secret/i` over the whole document. It matched the document's own description sentence, which was reworded ("no route accepts a user-held shared secret"). | `openapi.test.ts` |
| R25-c | The RFC 8414 metadata advertises T08 and T10 routes. | status.md open item: no release may be cut before T08 and T10 land. | status.md |
| R25-d | Fastify FSTDEP023: `disableRequestLogging` is deprecated. | `logController: new LogController({ disableRequestLogging: true })`. | No FSTDEP warning in the test run. |
| R25-e | A malformed percent-encoded URL (`/%E0%A4%A`) left no request log line. | `frameworkErrors` answers problem+json 400 and writes one summary line (`route: bad_url`); the raw URL is not logged. | `app.test.ts`: exactly one `request` line, with no `%E0`. |

### Re-review of PR #25 (head 160a6c7)

| Item             | Finding                                                                                                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                                                            | Test                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R25-2b (blocker) | `isProtected()` refused a protected path and anything under it, but not the paths above it. Override values were JSON-parsed, so `RALYSA_CFG__VAULT='{..."auth":{"method":"approle"...},"allow_approle":true}'`, `RALYSA_CFG__IDP='{..."require_mfa_claim":false}'` and `RALYSA_CFG__ACCESS='{..."mfa_claim_exception_ref":"fake"}'` were all accepted in production. | Both fixes, for defence in depth (coordinator decision): (a) a path is refused when it is a protected path, lies under one, or lies above one; (b) only scalar values (string, number, boolean) are accepted, and a JSON object, array or `null` is refused with a `ConfigError` on any path. README config reference updated. | `config-serve.test.ts`: `__VAULT`, `__IDP` and `__ACCESS` object overrides refused; a scalar value on those ancestor paths refused; an object on an unprotected path refused; an array and `null` refused; a scalar `RATE_LIMITS__PER_IP_PER_MINUTE=30` still applies. Without the fix, the new tests fail. |
| R25-f (nit)      | printf-style interpolation (`%o`, `%j`, `%s`) was formatted after `logMethod` and `formatters.log`, so a token in an interpolated argument reached the output unscrubbed.                                                                                                                                                                                             | `hooks.streamWrite` runs `scrubText` over every final serialized line. The existing argument, object and redact scrubbing are kept.                                                                                                                                                                                            | `logging.test.ts`: `app.log.info({}, 'interp %o', { tok })`, `%j` and `%s` with a runtime-built `rly_rt_` token; no token in the output, three `[REDACTED]` markers.                                                                                                                                        |

Self-decided: `null` counts as non-scalar and is refused, because an explicit `null` would remove a value that the schema defaults or requires. To unset a value, remove it from the config file.

### Incident: a flagged test fixture was pushed (T07, 2026-09-25)

- **What happened.**
  - The local pre-push `secret-scan pr` on the T07 commit found a gitleaks `generic-api-key` hit: a made-up OpenBao-token-shaped string in `services/control-plane/test/logging.test.ts` (the scrubber test).
  - The scan's exit code was masked by a pipe (`… | tail -1`), so the chained `git push` still ran.
  - The value was never a real credential, so nothing needs revoking.
- **Remediation.**
  - The fixtures are now built at runtime from low-entropy filler, so no literal reads as a credential.
  - The commit was amended and force-pushed with lease to the feature branch (no PR yet, single author). The branch history scans clean.
  - A GitHub force-push doesn't purge the earlier objects: the old commit stays reachable by SHA until GitHub garbage-collects it. For a fake fixture that's acceptable; for a real secret, rotation at the issuer would be the only remediation (F-001 design §6.2.6).
- **Process fix.** Local pre-push scans now run without pipes, and the exit code is checked explicitly (`scan > file; S=$?; [ $S -eq 0 ] && git push`). `set -o pipefail` would do the same where a pipe is needed.

## T08: sessions and grants

Branch `feat/F-002-sessions`, based on `main` after #25.

### What landed

- `src/auth/sessions.ts`: sessions (status, flow, roles) as refresh-token families; rotation with one guarded `UPDATE … WHERE status = 'active'`; session and user revocation (`revoked_before` = DB clock + 30 s); authorization-code redemption with tombstones (for T10's grant). Every revocation advances `cp.governance_epoch_seq` in the same transaction.
- `src/auth/grants/refresh-token.ts`: the `refresh_token` grant with `audience`, reuse detection, the IdP re-check through the `IdpDirectory` port (`src/auth/directory-port.ts`; Graph arrives with T10), and the §6.1 audience rule.
- `src/auth/grants/client-credentials.ts`: RFC 7523 assertions, verified against non-retired Transit key versions (a per-key cache), with the `jti` replay table.
- `src/auth/routes/token.ts`: `POST /oauth2/token` and `POST /oauth2/revoke`. The form parser is `src/http/form.ts`.
- `src/auth/governance-feed.ts`: `GET /v1/internal/governance`. `src/directory/routes.ts`: `GET /v1/me` and `GET /v1/internal/principals/:user_id`.
- `src/auth/verify-local.ts` and `src/auth/route-auth.ts`: the control plane's own verifier. User tokens are checked against revocation in the database [SEC-F002-18 d]. Rejections go to the `auth.token_rejected` aggregator with the org from config, which closes OI-4 for the control plane.
- `src/auth/cleanup.ts`: the cleanup job, wired in `serve`.
- Migration `cp/0005_governance_epoch`: the epoch sequence, plus `DELETE` on `cp.auth_session` for the cleanup job.
- Five route contracts. The OpenAPI generator now emits path and query parameters and form request bodies.
- Coordinator nit after #25 merged: every entry point writes one `config_loaded` line with the resolved config path and the override names. The README says production pins the path with a fixed `--config` or a read-only mount (SEC-F002-12).

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T08-1 | Bug in the design's feed contract, fixed | The feed's `cursor` lags `issued_at` by 60 s (`CURSOR_OVERLAP_S`). | A revocation stamps `revoked_at` inside its transaction and becomes visible only at commit. A poll between the two would move the cursor past a revocation it never saw, and every later `since=` poll would skip it for good. The overlap repeats the last minute, and PEPs de-duplicate. The integration test fails with no lag. T11's `RevocationFeed` must de-duplicate by `sid` and `user_id`. |
| T08-2 | Interpretation | A **revoked** refresh token (its session was revoked, for example by sign-out) is refused as `revoked`, not as reuse. A **rotated** token is reuse. | §3.2.3 calls both reuse, but TC-F-002-13 and §5.4 require `auth.refresh denied revoked` after sign-out. The session is already revoked, so treating it as reuse would only add a misleading `reuse_detected` event. |
| T08-3 | Decision (SEC-F002-17) | The losing concurrent refresh is treated as reuse: `invalid_grant` with `reuse_detected`, and the family (the winner's new token included) is revoked. | §3.2.3: "a second refresher on the same device is a defect that surfaces as reuse", with no grace window. It is documented for F-003 and F-005 in both READMEs. |
| T08-4 | Design gap, filled | Refresh denials that revoke something also write `auth.session.revoked`: cause `user_disabled` or `idp_sessions_revoked` with `user_id`, and cause `not_in_access_group` with `sid`. | §3.5 lists the event but not every refresh cause. `not_in_access_group` is not in its cause list; it is added rather than leaving a revocation without its event. |
| T08-5 | Implementation choice | A user already `disabled` in `cp.app_user` is refused before the IdP call. | An IdP outage must not turn a known-disabled user into `temporarily_unavailable`. |
| T08-6 | Implementation choice | The service key cache re-reads a key's version list after 60 s, and on an unknown version at most every 5 s. | The WIP cached versions until a miss, so a retired version would have kept verifying forever (SEC-F002-22). A minute bounds retirement, and the cooldown stops a bad `kid` from hammering OpenBao. |
| T08-7 | Design gap, filled | Cleanup records `code_not_redeemed` when it revokes the pending session behind an expired, unused code (within a minute of expiry). It deletes the code's tombstone one hour after expiry. | D-38 gives no timing. Revoking the pending session with `UPDATE … WHERE status = 'pending' RETURNING` makes the event exactly-once across replicas without another column. |
| T08-8 | Deviation from §4.4 | Refresh tokens are purged with their session (30 d after it ends), not individually 30 d after each token's expiry. A session ends when it is revoked, or at the earlier of its last token's idle expiry and its absolute expiry (R26-4). | `refresh_token.parent_id` chains a family, so a parent row can't go before its children. Only hashes are stored. |
| T08-9 | Scope | In `serve`, the IdP directory is the unconfigured port until T10, so every refresh answers `temporarily_unavailable` and consumes nothing. `serve` logs `idp_directory_unconfigured`. | Fails closed. T10 wires Graph behind the same port. Tests use a controllable fake. |
| T08-10 | Scope | TC-F-002-25's code-reuse case is tested on `redeemAuthorizationCode` (second redemption → `reused`, session revoked). The `auth.token.reuse_detected` event for codes is written by T10's `authorization_code` grant. | That grant, and its audit, are T10's. The session revocation (the security effect) is T08's and is tested. |
| T08-11 | Deviation from §2.1 and T07-2 | There is no `@fastify/formbody`: `src/http/form.ts` parses `application/x-www-form-urlencoded` (16 KB limit) and refuses a repeated parameter (RFC 6749 §3.1). The token and revoke handlers share one file. | About 20 lines, and it adds the repeated-parameter check the plugin lacks. |
| T08-12 | Implementation choice | `POST /oauth2/revoke` checks `client_id` before validating anything else: an unknown client is `401 invalid_client` (RFC 7009 §2.2.1). A known client with an unknown token gets 200. | RFC 7009. |
| T08-13 | Implementation choice | `epoch` is a sequence, not a counter row. | It is monotonic and has no row-lock hot spot. Gaps from rolled-back transactions are harmless, because PEPs only compare order. |
| T08-14 | Implementation choice | `as_of` on a principal is the database clock. | The same clock as every other governance timestamp. |

### Tests (T08)

- **Integration** (`test/integration/sessions.int.ts`, 12, dev stack with real Transit keys per run):
  - rotation and `/v1/me` (session roles, Arabic names byte-for-byte, hash-only storage);
  - **TC-F-002-13**:
    - revoke writes `auth.sign_out` once;
    - revoking twice, or an unknown token, is still 200, and a wrong client gets 401;
    - a later refresh is `invalid_grant` with `auth.refresh denied revoked` and the policy version;
    - `/v1/me` refuses the access token;
    - the feed lists the `sid` with a higher `epoch` and a fresh `issued_at`, and a fake gateway rejects after the poll;
  - the feed-cursor race (T08-1);
  - **TC-F-002-25**:
    - reuse of a rotated token revokes the family, both tokens fail, and the three events are written;
    - two concurrent refreshes give exactly one 200 and one `invalid_grant reuse_detected`, and the session is revoked;
    - a used code's second redemption revokes its session;
  - the IdP re-check:
    - unavailable → 503, and the token still works afterwards;
    - disabled → `revoked_before` (DB clock + 30 s) in the feed and `auth.session.revoked`;
    - no group, and Entra sessions revoked after sign-in, are refused;
  - audiences by role;
  - AC-3 at the token endpoint: `password`, unlisted grants, `client_secret`, Basic auth, JSON bodies and repeated parameters are refused;
  - **TC-F-002-26, RTS half**:
    - a valid assertion gives a 5-minute service token that the feed accepts;
    - a replayed `jti`, another service's key, a wrong `aud` and a trimmed (retired) version are refused;
    - each refusal is `invalid_client` plus an `auth.token_rejected` under the config org.
    - The OpenBao policy half is `tooling/dev-stack/test/integration/policies.int.ts` (T02).
  - token and route separation; principals (404, 400);
  - cleanup: `code_not_redeemed` exactly once, expired replay rows, a 31-day-old session with its token, and the tombstone after one hour.
- **Unit**:
  - `service-key-cache.test.ts`: retirement within the TTL, and the miss cooldown;
  - `config.test.ts`: the `config_loaded` path and override names;
  - the OpenAPI document covers the new routes, and still has no password, PIN, OTP or `client_secret`.

### Code review of PR #26 (changes requested): resolutions

| Item | Finding | Fix | Test |
|---|---|---|---|
| R26-B1 (blocker) | Rotation committed before the access token was signed through OpenBao. A signing failure after that consumed the token, and the client's retry then looked like reuse and revoked the family. | The access token is minted **before** the rotation transaction. A token minted for a request that then loses the guard is never returned. A signing failure answers `503 temporarily_unavailable` with nothing consumed. | `sessions.int.ts` "B1": signing fails → 503, then the same token refreshes and no `reuse_detected` is written. |
| R26-B1a (found while testing B1) | That 503 came back as a bare Fastify 500. pino's wildcard redact (`*.code`) copies an `Error` before the `err` serializer sees it, dropping its non-enumerable `name` and `message`, and the serializer threw on the missing message. Any unhandled error on any route answered 500 without its log line. | `errorSummary()` is total over any input. `handleError` logs it under `error`, with the code as `error_code` (so the redact path doesn't hide it). The `err` serializer uses the same function. | `logging.test.ts`: an unhandled error through a Fastify request logger → 503 on `/oauth2/*`, and the line keeps type, scrubbed message and code; logging `{ err }` never throws. |
| R26-B2 (blocker) | `exp` was allowed up to now + 60 s + skew and accepted until exp + skew, but the replay row expired at DB-clock insert time + 120 s, so clock drift opened a replay window. | The replay row expires at `to_timestamp(exp)` + 30 s skew + 60 s margin, taken from the assertion. The "ahead" check has no extra skew (`exp ≤ now + 60`), and `exp - iat ≤ 60`. The rules are one pure function, `assertionTimeProblem`. | `client-assertion-time.test.ts` (exp too far ahead, long lifetime, future iat, missing times). `sessions.int.ts` "B2": the stored `expires_at` = exp + 90 s. |
| R26-B3 (blocker) | Cleanup's batch could pick codes already handled (`used_at` stays null for another hour), so with more than one batch of abandoned codes, newer ones starved and their `code_not_redeemed` events were lost. | The batch joins `cp.auth_session` with `status = 'pending'` and orders by `expires_at`. | `sessions.int.ts` "B3": batch size 1, two expired codes → both events. |
| R26-1 | Losing the rotation guard was always answered as reuse. | The token is re-read in the same transaction. If it was rotated, that is reuse. If it was revoked, or its session was revoked, the answer is `revoked`. Otherwise it is `expired`. | "a token revoked while its refresh is in flight is answered revoked, not reuse" (a latch holds the refresh in the directory call). |
| R26-2 | `auth.session.revoked` was written even when nothing changed. | It is written only when `revokeSession` changed the session, or `revokeUser` revoked at least one. | "presenting a rotated token after sign-out is still reuse, with no second session.revoked". |
| R26-3 | The 60 s cursor overlap needs a bound on how long a revocation transaction stays open. | `limitRevocationTransaction()` sets Postgres 17 `transaction_timeout` = 15 s, once per transaction, before the first revocation statement: `revokeSession`, `revokeUser` and cleanup's pending-session revocation. The timer starts when it is set, which was verified on the dev stack, so it bounds stamp-to-commit. A transaction that runs out is terminated and revokes nothing. The invariant is documented in `sessions.ts`, the README and design rev 3. | Covered by the existing revocation tests, which run with the cap. |
| R26-4 | Retention measured from `revoked_at` or `absolute_expires_at` only. | A session ends at `revoked_at`, else at the earlier of its last refresh token's `expires_at` and `absolute_expires_at`. It is purged 30 d after that. T08-8 updated. | The cleanup test purges a session revoked 31 d ago. |
| R26-5 | Missing tests. | Added: a barrier in the fake directory for the concurrent refresh; client-assertion negatives (wrong alg, `jku`, unknown client, `client_id` mismatch, future `iat`, long lifetime, `exp` too far ahead); `/v1/me` refusing `iat < revoked_before` (`user_revoked`); rotated-token reuse after sign-out. | `sessions.int.ts` (19 tests). |
| R26-6 | Some refusals are not audited. | **Decision, not changed:** an **unknown** refresh token has no actor and no session, so an event would only record noise from anyone who can reach the rate-limited endpoint. An admin-only session asking for another audience gets `invalid_scope`: it is a malformed request for that session, not a policy denial of the session, and nothing is consumed or revoked. `RefreshReason` has no code for it, and adding one changes the protocol catalogue (F-005 i18n keys). Both stay unaudited in Phase 0; F-006 revisits audience policy. | — |
| R26-7 | Versions below `min_decryption_version` still verified. | `KeyDescription.minDecryptionVersion` is added to the `KeyCustody` port (Transit adapter and in-memory). The service-key cache keeps only versions ≥ max(`min_available_version`, `min_decryption_version`). A Transit reply without the field is `invalid_response`. | `service-key-cache.test.ts`; `packages/secrets` `openbao.test.ts`. |
| R26-8 | A service key's custody violation wasn't recorded. | The cache treats a violating key as having no versions and calls `serviceKeyViolationRecorder`: `secret.custody_violation` (actor `rts`, `purpose: service_assertion`), once per key and flag set, retried until it lands. | `service-key-cache.test.ts`. |
| R26-9 | Design §3.5 lacked cause `not_in_access_group`. | Added to the catalogue, with "written only when the call revoked something". Recorded as design revision 3. | — |
| R26-10 | The README didn't say what a lost refresh response means. | README: a retry after a lost response is reuse, and the refresher must treat it as a sign-out. A failure before rotation (503) is safe to retry. | — |
| R26-CI (found on CI) | `db.int.ts` "bootstrap-roles.sql is idempotent" re-ran the role script **without** the cross-file advisory lock that `createTestDatabase` takes. With one more integration file running in parallel, it collided with another file's bootstrap (`XX000 tuple concurrently updated`). | `support/db.ts` `runBootstrapRoles()` holds the lock for every run of the script; the idempotency test uses it. | The full control-plane integration suite passed three times in a row locally. |
| R26-11 | The feed-cache tests slept. | `RtsServices.now` is an injectable clock for in-memory caches. The tests step it past the 1 s feed cache instead of sleeping. | `sessions.int.ts`. |

## T09: mock IdP

Branch `feat/F-002-mock-idp`, based on `main` after #26. It was started in an earlier session that was interrupted after the fixtures and state; this session reviewed that work and finished it.

### What landed

- `tooling/dev-stack/src/mock-idp/` (exported as `@ralysa/dev-stack/mock-idp`):
  - `provider.ts`: the `oidc-provider` configuration shaped like Entra v2. It uses Entra's paths under `/<tenant>`, with issuer `<base>/<tenant>/v2.0`. It has two clients: the CLI (public, device code only) and RTS (confidential: authorization code with PKCE S256 required, plus client credentials for Graph). Any currently valid RTS secret is accepted. Resource indicators pick the RTS API or Graph. There is no password field. Disabled users get `access_denied` (AADSTS50057). The device authorization response is reshaped the way Entra sends it.
  - `claims.ts`: the Entra v2 access-token payload. It carries `ver`, `tid`, `oid`, pairwise `sub`, `azp`, `scp`, `uti`, `ipaddr`, `amr`, `acrs`, `name`, `preferred_username` and `groups`, or the overage `_claim_names`/`_claim_sources` past 200 groups. Graph app tokens use Entra's v1 app shape.
  - `fixtures.ts`, `state.ts`: the ten fixture users of §8.3, with object ids generated per run, plus mutable state (users, groups, valid secrets, the Graph fault).
  - `graph.ts`: the Graph stub. It serves `users/{id}`, `checkMemberGroups`, `getMemberObjects` and `groups/{id}`, requires an app token, returns Graph's error shape, and honours the `error`, `hang` and `latencyMs` toggles.
  - `control.ts`: the test-control API. It binds 127.0.0.1, requires the per-run bearer (compared in constant time), and validates every body with zod.
  - `browser.ts`: a headless form driver used by tests. `approveDeviceCode()` covers flow A and `signInAtAuthorize()` covers flow B.
  - `index.ts`: `startMockIdp()`, the in-process start helper. Per run it creates the RSA signing key, a foreign key for bad-signature tests, the RTS secret and the control bearer.
  - `main.ts`: the process entry point for manual runs, with a `control` subcommand.
- `tooling/dev-stack/src/cli.ts mock-idp`. It imports the mock lazily, so `env` still runs before `pnpm install`.
- `deploy/docker/dev/compose.yaml`: the `mock-idp` service (profile `idp`). It runs `node:24.21.0-alpine` pinned by digest and executes `dist/mock-idp/main.js` from read-only bind mounts of only what it needs: dev-stack's `dist`, `package.json` and `node_modules`, and the root `node_modules/.pnpm` (R27-S2). It is on its own `idp` network. It runs as a non-root user with a read-only root filesystem, `cap_drop: ALL` and a tmpfs `/tmp`. Only 127.0.0.1:59400 is published, and there is a discovery healthcheck. Its ids match `control-plane.serve.dev.yaml`.
- The README gained a mock IdP section: API, fixtures, test-control routes, manual runs and the `MOCK_IDP_*` variables.

### Versions

| Item | Pinned | Evidence |
|---|---|---|
| `oidc-provider` | **9.11.5** (dev-stack devDependency only) | Published 2026-08-24 (32 days old). MIT. No install scripts. |
| `@types/oidc-provider` | **9.11.1** | Published 2026-08-07. MIT. |
| `node:24-alpine` (compose `mock-idp`) | `24.21.0-alpine@sha256:ebfe2f90…ec1c1` | Index digest checked 2026-09-25 with `docker buildx imagetools inspect`; `node --version` in the image is v24.21.0. |

### Recorded decisions and deviations

Items marked **self-decided** were open questions decided under the standing authorization (CLAUDE.md), taking the recommended option.

| # | Type | What | Why |
|---|---|---|---|
| T09-1 | Deviation from §2.1 file names | `server.ts` became `index.ts` (start helper) plus `provider.ts` (configuration and interaction). `entra-claims.ts` became `claims.ts` and `test-control.ts` became `control.ts`. `browser.ts` and `main.ts` were added. | This separates the provider configuration from the listener wiring. The headless browser and the process entry point were not named in the design. |
| T09-2 | Design gap, filled (**self-decided**) | Graph is served under `<base>/graph/v1.0/…` on the IdP's listener, so `idp.graph_base_url` is `<base>/graph`. | The committed `control-plane.serve.dev.yaml` (T07) already says `graph_base_url: http://127.0.0.1:59400/graph`. Like the real base, it carries no version, and one port serves both. |
| T09-3 | Design gap, filled (**self-decided**) | The device authorization response is reshaped the way Entra sends it: `interval` is added (default 5, configurable for tests), `message` is added, and `verification_uri_complete` is removed. | `oidc-provider` omits `interval` and adds `verification_uri_complete`, which Entra never sends. If the mock returned it, a client could come to depend on it and then fail against real Entra (TC-F-002-28). `oidc-provider` does not enforce `slow_down`, so the interval is advisory. |
| T09-4 | Deviation from §8.3 wording | Access-token payloads are **replaced** in `formats.customizers.jwt` rather than extended through `extraTokenClaims`. The header is `{alg: RS256, typ: JWT, kid}`. | Entra's shape needs claims that `oidc-provider` adds to be removed: `client_id`, `scope` and `jti`. It also needs `aud` to be the resource's client id, `scp` to be the short scope name, and `typ` to be `JWT` rather than `at+jwt`. `extraTokenClaims` can only add claims. |
| T09-5 | Implementation choice | The Graph app token (client credentials, `https://graph.microsoft.com/.default`) is Entra's v1 app shape (`ver: "1.0"`, `idtyp: app`, `roles`). The Graph stub accepts only that token. A user token gets 401. | That is what real Graph tokens look like. It also catches RTS calling Graph with a user's token. |
| T09-6 | Security choice (**self-decided**) | In compose, the test-control API binds the **container's** 127.0.0.1 and is not published. It is reached with `docker compose … exec mock-idp node …/main.js control …`. The bearer is written to a mode-0600 file on a tmpfs and is never logged. | This keeps SEC-F002-13 (e) literal. The alternative was to bind `0.0.0.0` inside the container and publish it on host loopback. That would expose the control API to every container on the compose network. |
| T09-7 | Hardening beyond design | `main.ts` refuses a non-loopback `MOCK_IDP_PUBLIC_BASE_URL`. It also refuses a non-loopback listener unless `MOCK_IDP_IN_CONTAINER=1`, which only the compose service sets. | This is a runtime backstop against running the mock where anything other than this machine can reach it. SEC-F002-12's production issuer pattern remains the control plane's own backstop. |
| T09-8 | Scope (**self-decided**) | For manual runs, the RTS client secret is per run and is **not** written to OpenBao by `bootstrap`. The developer gets one with `control POST /client-secrets` and stores it at `kv/ralysa/control-plane/idp-client-secret`. The README and the startup log say so. | A fixed secret in `.env` would be a second long-lived credential. Wiring sign-in end to end is T10's, and the runbook is T13's. Tests never need it, because they start the mock in-process. |
| T09-9 | Additions beyond §8.3 | These were added to serve the test cases: `POST /users/{id}/getMemberObjects` (the overage `_claim_sources` target); `POST /tokens` with `claims`, `header`, `expiresInSeconds` and `signWith: "foreign"` (the negatives in TC-F-002-03 and -10); and patching `ipaddr` and `displayName` (the `ipaddr` mismatch check and the TC-F-002-01 rename). | These are the Entra behaviours that T10 and T15 exercise. |
| T09-10 | Fixture interpretation | **sam**: Graph reports membership of the access group by object id, but the token carries `CONTOSO\Ralysa Users`. **mallory**: her only group has the access group's (Arabic) display name under another object id. **dora**: sign-in works and Graph answers 404. **erin**: `amr ["fido"]`, `acrs ["c1"]`. | This lets T10 prove that non-GUID claims are ignored, Graph is authoritative (SEC-F002-08), the look-alike group is refused, 404 leads to disable-and-revoke, and the strong-flow admin rule holds. |
| T09-11 | Implementation choice | `ipaddr` is the socket address that completed the interactive sign-in (per user). It can be overridden through the control API. Minted tokens use the same value. | The mock runs on loopback, so tests set a different `ipaddr` to exercise the mismatch flag. |
| T09-12 | Implementation choice | `oidc-provider`'s default in-memory adapter is used. It prints a "development-only" warning once per process. | The mock is per process by design (tests start their own). A custom adapter would only suppress the warning. |

### Tests (T09)

- **Unit** (`tooling/dev-stack/test/mock-idp.test.ts`, 39 tests, in-process on ephemeral loopback ports):
  - **Discovery and keys:**
    - Entra paths and issuer; `password` is not among the grants; S256 is the only PKCE method.
    - Signing keys are **per run**: a second instance has a different modulus, `kid`, control bearer and client secret, and the JWKS never contains `d` [SEC-F002-13 d].
    - `grant_type=password` → `unsupported_grant_type`.
  - **Device flow:**
    - An RS256 `typ: JWT` token that verifies against the JWKS and carries every Entra claim (`ver`, `tid`, `oid`, pairwise `sub`, `azp`, `scp`, `uti`, `ipaddr`, `amr`, `groups`).
    - `authorization_pending` before approval, then `invalid_grant` for a used code.
    - The Entra response shape (`interval`, `message`, no `verification_uri_complete`).
    - `expired_token` after the lifetime.
    - carol → `access_denied`.
    - The RTS confidential client can't use the device endpoint.
  - **Code + PKCE:**
    - fatima signs in by username. The redirect carries `code`, `state` and `iss`. Redemption with the verifier and a client secret gives access and ID tokens with the Arabic name byte for byte.
    - A request without PKCE → `invalid_request`.
    - A wrong verifier → `invalid_grant` without consuming the code; the right verifier → 200; a reused code → `invalid_grant`.
    - carol → `access_denied` at the redirect.
    - The login page has a username field and no password field.
  - **Two client secrets:** the first and the added secret both work. After removing the first, it gets `invalid_client` and the second still works. Removing a secret twice → 404. A wrong secret → 401.
  - **Fixture claim shapes:**
    - olga gets overage markers (minted and device-flow tokens), and `_claim_sources` points at the Graph stub.
    - sam gets a non-GUID claim while Graph reports the access group.
    - mallory's look-alike group; dana is admin only; erin has both groups and FIDO `amr`/`acrs`.
    - fatima's Arabic group.
    - Every group id is a GUID.
  - **Graph stub:**
    - "Revoke sessions" moves `signInSessionsValidFromDateTime`.
    - dora → 404 with `Request_ResourceNotFound`; carol → `accountEnabled: false`.
    - `checkMemberGroups` filters memberships and validates its body; `getMemberObjects` lists 250 groups.
    - A missing token or a user token → 401.
    - The **`error` fault** gives 503 and resets; the **latency toggle** adds ≥ 300 ms; the **`hang`** fault is cut off by the client's timeout.
  - **Test-control API [SEC-F002-13 e]:**
    - Loopback URL.
    - 401 without the bearer, with another bearer, or with the bearer plus one character.
    - User list without secrets; disable/enable; groups; delete in Graph.
    - Minted tokens verify, and `foreign` tokens don't.
    - 400 and 404 for invalid bodies and unknown names.
  - **No password field:** no source file in `src/mock-idp/` contains a password input.
- **Unit** (`test/mock-idp-main.test.ts`, 4): the `MainEnv` defaults and loopback refusals; `runMockIdp` uses the dev ids, writes the bearer 0600 without logging it, serves the `control` subcommand, and removes the file on stop.
- **Manual, 2026-09-25:**
  - The compose service was started with `--profile idp` under a throwaway project name and reported healthy.
  - Discovery and `devicecode` answered on 127.0.0.1:59400.
  - The control port was **unreachable from the host**, and `exec … control GET /users` answered 200.
  - The token file was `-rw------- node`; `/repo` was read-only; the uid was 1000.
  - `node tooling/dev-stack/src/cli.ts mock-idp` on the host started and answered `control GET /users`.
- `pnpm repo:check`: all checks pass, including `check-workspaces` `deps/dev-only-in-shipped` (SEC-F002-13 b). SEC-F002-13 (a) (dependency-cruiser) and (c) (image scan) are T14's.

### Code review of PR #27 (changes requested): resolutions

| Item | Finding | Fix | Test |
|---|---|---|---|
| R27-B1 (blocker) | The flow-B ID token wasn't Entra-shaped. oidc-provider signs it with `sub` = the account id (the object id), no `typ` header, and no `uti`, `ver`, `amr`, `acrs` or `ipaddr`. The `amr` passed at login was lost. | A `provider.use` post-processor on the token route re-issues `id_token` with the per-run key: header `{alg: RS256, typ: JWT, kid}`, `userIdClaims()` (pairwise `sub`, `oid`, `tid`, `uti`, `ver: "2.0"`, `amr`, `acrs`, `ipaddr`, `email`, `name`, `preferred_username`, group claims). `nonce`, `sid`, `auth_time` and the hashes are copied when present. oidc-provider emits neither `at_hash` nor `sid` from the token endpoint here, so only `nonce` appears. | `mock-idp.test.ts` "issues an Entra v2-shaped ID token": `typ` is `JWT`, `sub` ≠ `oid`, `uti` is 22 base64url characters, `ver` is 2.0, erin has `amr ["fido"]` and `acrs ["c1"]`, alice has `amr ["pwd","mfa"]` and no `acrs`, `nonce` is echoed, and `ipaddr` and the groups are checked. |
| R27-S1 | The JWT customizer ignored the resource. A mixed RTS + Graph scope in flow B got 200 with `aud` = RTS, and client credentials with the RTS scope got `aud` = Graph. | `aud` comes from `token.resourceServer.audience`, and a mismatch throws `InvalidTarget`. `defaultResource` refuses scopes for two resources with `invalid_scope`, as Entra's AADSTS28000 does. `getResourceServerInfo` allows client credentials only for Graph with exactly `https://graph.microsoft.com/.default` (`invalid_scope`), and allows no delegated Graph tokens (`invalid_target`). | "refuses scopes for two resources" (flow B → `invalid_scope`); "client credentials: only Graph, only with /.default" (the RTS scope and `…/User.Read.All` → `invalid_scope`); "refuses a device-flow request for Graph" (`invalid_target`). |
| R27-S2 | Compose mounted the whole repository, which exposed `deploy/docker/dev/.env` (Postgres password, OpenBao root token) to uid 1000 in the container. mock-idp also shared the default network with openbao. | Only `tooling/dev-stack/{dist,package.json,node_modules}` and the root `node_modules/.pnpm` are mounted, all read-only. mock-idp is alone on the `idp` network, while postgres and openbao stay on `default`. | Manual compose run, 2026-09-25, with openbao and mock-idp both healthy in one project: `/repo` contains only `node_modules/.pnpm` and `tooling/dev-stack`, and `/repo/deploy` doesn't exist. From mock-idp, `openbao` doesn't resolve and its IP times out; from openbao, `mock-idp` doesn't resolve. Discovery, the host-unreachable control port, `exec … control GET /users` (200) and the 0700 directory with its 0600 token were re-checked. |
| R27-N1 | `MOCK_IDP_IN_CONTAINER=1` alone allowed binding `0.0.0.0`. | `parseMainEnv()` also requires `/.dockerenv`. | `mock-idp-main.test.ts`: `0.0.0.0` is refused with the flag but no container, and with a container but no flag. `/.dockerenv` was confirmed present in the compose container. |
| R27-N2 | `tmpdir()/ralysa-mock-idp` is shared on Linux. | `ensurePrivateDir()` creates the directory 0700, then `lstat`s it. It refuses a symlink, another owner, or any mode other than 0700. The token is still written with `wx` (O_EXCL). | `ensurePrivateDir`: creates 0700, and refuses a 0755 directory and a symlink. |
| R27-N3 | The device-code expiry test slept 1.5 s. | Fake `Date` timers step the clock. oidc-provider reads `Date.now()`. | "expires the device code after its lifetime". |
| R27-N4 | The main test used a random fixed control port. | Ports accept `0`. `runMockIdp()` returns `{ controlPort, stop }`. | `runMockIdp` test binds port 0 and reads it back. |
| R27-N5 | The v1 app token used the v2 issuer. | Its `iss` is `https://sts.windows.net/<tid>/` (`appTokenIssuer()`), and the Graph stub verifies that issuer. `azp` was replaced by v1's `appidacr: "1"`. | The client-credentials test checks `iss`, `ver`, `idtyp` and `appid`. The Graph tests still pass with the new issuer. |
| R27-N6 | `azpacr` was always `"0"`. | `"1"` for the confidential RTS client (flow B), `"0"` for the CLI and for minted tokens. | Flow-B access token has `azpacr: "1"`; device-flow token has `azpacr: "0"`. |
| R27-N7 (after merge, fixed in T10) | A `client_credentials` request with no `scope` got 200 and an opaque token; Entra refuses it (AADSTS900144). | `defaultResource` throws `InvalidScope` for `grant_type=client_credentials` without a scope. | `mock-idp.test.ts`: "client credentials without a scope is invalid_scope, as Entra (AADSTS900144) (R27-N7)". |

## T11: `packages/auth`

Branch `feat/F-002-auth-package`, based on `main` after #26 (T08). Built in parallel with T09 (mock IdP, `feat/F-002-mock-idp`) and without T10, so it depends on neither.

### What landed

- **Verifier** (`src/verify/access-token-verifier.ts`), with the §3.2.2 rules in order. Each rule has its reason code:
  - shape;
  - `alg` ES256 only;
  - `typ: at+jwt`;
  - no `jku`, `jwk`, `x5u`, `x5c` or `crit` (SEC-F002-19);
  - a `kid` from `kidPattern(kidPrefix)`;
  - the signature against a jose remote JWKS (`src/verify/jwks.ts`: 60 s max age, 5 s cooldown);
  - exact `iss`;
  - a single-string `aud`;
  - the pinned `tid`;
  - `exp` and `nbf` with 30 s skew;
  - `iat` not after now + skew (SEC-F002-18 e);
  - `token_use`;
  - the claim contract;
  - then the `RevocationSource`.
- `onReject` gets `{reason, clientIp, traceId}` and never the token.
- **Revocation feed** (`src/verify/revocation-feed.ts`). It polls every 5 s with the service token. A poll is a confirmation only when all of these hold (SEC-F002-18 a):
  - the answer is a 200 that validates;
  - its `issued_at` is within 30 s of the PEP clock;
  - its `epoch` is not lower than the last one seen.

  Other behaviour:
  - G-1: `governance_stale` after 60 s without a confirmation.
  - Entries are de-duplicated by `sid` and `user_id`, keeping the latest `revoked_before` (T08-1 overlap).
  - Entries are pruned after the maximum TTL + 5 min.
  - `since=<cursor>` is sent from confirmed answers only.
  - Kill-switch state is taken from confirmed answers only.
- **Principal resolver** (`src/verify/principal-resolver.ts`):
  - a 30 s bounded cache;
  - one request per user in flight;
  - the user id checked as a UUID before it goes into the path;
  - the answer's `user_id` must match;
  - 404 → `PrincipalNotFoundError`, and anything else fails closed.
- **Service identity** (`src/service/`):
  - the `AssertionSigner` interface;
  - `createTransitAssertionSigner` over a structural `TransitSigning` port, which `@ralysa/secrets` `KeyCustody` satisfies. It signs with the latest Transit version and names it in the `kid`, the T07-7 pattern.
  - `createClientAssertion`: RFC 7523, 50 s lifetime, a fresh `jti`.
  - `createServiceTokenSource`:
    - renews at 50 % of the TTL plus up to 10 % jitter, in the background;
    - keeps the current token until 5 s before `exp`;
    - retries with a 1–30 s backoff;
    - then throws `ServiceTokenUnavailableError`, and the PEP fails closed [AR-1].
- **Client flows** (`src/client/`):
  - `fetchAuthConfig`, which pins the issuer.
  - `startIdpDeviceSignIn`: RFC 8628 with `authorization_pending`, `slow_down` and back-off on 5xx or network faults. Every IdP-side failure goes through `reportSignInFailure` before the typed error is thrown (AC-4). A user cancel is not reported.
  - `exchangeIdpToken` and `reportSignInFailure`.
  - PKCE: `createPkcePair` and `createState` (WebCrypto), `buildAuthorizeUrl`, validated with `AuthorizeQuery`, and `readAuthorizationCallback`.
  - `redeemAuthorizationCode` and `revokeSession`.
  - `createTokenManager`: single flight, all refreshes serialised, documented as the one refresher per device (SEC-F002-17).
  - Typed errors, whose i18n keys are restricted to `AUTH_I18N_KEYS`.
- **Isomorphic.** `src/platform.ts` reaches `fetch`, WebCrypto, `TextEncoder`, `URL`, `URLSearchParams`, `btoa`, timers and `AbortSignal` through `globalThis` with structural types, like protocol and secrets. There are no Node built-ins, and the `isomorphic` lint preset passes. There is no file-backed `TokenStore`, and a test asserts that no store is exported.
- **Dependencies.** `@ralysa/protocol`, `jose` (catalog 6.2.12) and `zod` (catalog). `@ralysa/secrets` is a devDependency, used by the tests only.
- **Control plane.** `@ralysa/auth` is a devDependency (integration tests only) with a tsconfig reference.
- README: the API, "no env vars", and the one-refresher contract.

### Recorded decisions and deviations

Self-decided under the standing authorization (recommended option taken), logged here:

| # | Type | What | Why |
|---|---|---|---|
| T11-1 | Scope | TC-F-002-02 end to end needs the mock IdP (T09) and the token-exchange grant at RTS (T10), and neither is on `main`. T11 covers the **client half** with fakes: config, device start, `authorization_pending`, `slow_down`, success, exchange form and `TokenSet`. The integration run lands with T10, which adds the grant, against T09's mock. | The coordinator said not to depend on T09. The exchange grant is T10's. |
| T11-2 | Scope / deviation from §2.1 | TC-F-002-10's "20 `auth.token_rejected` events" are proven up to the aggregator: 20 `onReject` calls, recorded through the control plane's `createRejectionAggregator` under the configured org, giving 20 individual emissions on one /24. Storing them through `POST /v1/audit/events` is T12, because the route doesn't exist yet. §2.1 lists `packages/auth/src/verify/rejections.ts`, but the aggregator isn't duplicated here; T12 (SEC-F002-16) decides whether it moves into `packages/auth` with an isomorphic `networkOf`. | T12 owns the aggregation DoD (per `/24`/`/64`, per-verifier cap). Two copies would drift. |
| T11-3 | Design gap, filled | If the JWKS can't be fetched (network, timeout, non-200), `verify()` **throws** `VerifierUnavailableError` instead of returning a reject reason. | `TokenRejectReason` has no code for an infrastructure fault. Recording it as `auth.token_rejected` would blame the caller. The PEP answers 503 and still fails closed. |
| T11-4 | Interpretation (SEC-F002-18 a) | Revocations in an answer that is **not** a confirmation (a stale `issued_at` or a lower `epoch`) are still added. Its kill-switch state and cursor are ignored, and it does not refresh G-1. | Adding a revocation can only make the PEP stricter. An old kill-switch state or cursor could make it laxer. |
| T11-5 | Implementation choice | `RevocationFeed.check` tests `user_revoked` before `session_revoked`. | Disabling a user also revokes their sessions, and the broader reason is the useful one in `auth.token_rejected`. The control plane's own verifier (T08) checks the session first. Both reject. |
| T11-6 | API additions to §3.6 | The additions are all optional and don't change any listed signature's meaning:<ul><li>every call takes `fetch` and `timeoutMs`, and the stateful ones take `now`;</li><li>the verifier takes `orgId` (pins `tid`, as T08's local verifier does), `keySet` and `now`;</li><li>`verify(bearer, { clientIp, traceId })`, and the principal carries `tokenId` (`jti`);</li><li>`createServiceTokenSource` takes `assertionAudience`, for when the internal address differs from RTS's `public_base_url`;</li><li>`startIdpDeviceSignIn` takes `classifyIdpError` (the CLI's Entra `AADSTS` table [AR-18]) and `deviceLabel`;</li><li>new exports: `createState`, `readAuthorizationCallback`, `createClientAssertion`, `createTransitAssertionSigner`, `TransitSigning`.</li></ul>`TokenManager` is `signedIn`, `getAccessToken(audience)`, `hasSession` and `signOut({ localOnly })`. | §3.6 names these functions but not the parameters that tests, internal addresses and the vendor error table need. |
| T11-7 | Implementation choice | `buildAuthorizeUrl` returns a WHATWG `URL`, typed structurally (`{ href, toString() }`). | lib-isomorphic has no DOM types. At runtime it is the platform `URL`. |
| T11-8 | Implementation choice | Device polling:<ul><li>5xx, 429 or network faults double the interval (at most 60 s) until the code expires, per RFC 8628 §3.5.</li><li>At expiry, `other/idp_unreachable` is reported if the last poll was a fault, and `expired_token` otherwise.</li><li>A refusal at device **start** is reported too.</li><li>The IdP's answers are validated as untrusted input: `verification_uri` must be http(s), and `user_code` must be printable ASCII with no bidi or control characters.</li></ul> | AC-4 counts every attempt. The user code and URL are shown to the user, so they must not carry spoofing characters. |
| T11-9 | Implementation choice | `fetchAuthConfig(issuer)` refuses a config whose `issuer` differs from the one asked (`auth.failed.untrusted_issuer`). | Otherwise a tampered config could send later calls, the refresh token included, to another server. |
| T11-10 | Implementation choice | RTS error mapping:<ul><li>`invalid_grant` is `SessionRevokedError` for a refresh and `AccessDeniedError` for a sign-in grant (replay, a bad code);</li><li>`access_denied` and `unauthorized_client` → `AccessDeniedError`;</li><li>`temporarily_unavailable`, 429 and 5xx → `TemporarilyUnavailableError`;</li><li>an i18n key RTS sends that isn't in `AUTH_I18N_KEYS` falls back to the error's default.</li></ul> | The CLI needs different advice for "sign in again" and "you're not allowed". Response fields are external input. |
| T11-11 | Deviation (follow-up) | The control plane keeps its own `verify-local.ts` (T08), which reads revocation from the database, instead of `createAccessTokenVerifier` with a database `RevocationSource`. §3.2.6 says "the same verifier". | The rules are the same, and both are tested: the T08 integration tests and TC-F-002-10/11 here. Moving the control plane onto the package's verifier touches every merged T08 route. It is a behaviour-neutral refactor for T12, which adds the next user routes (client events, audit query). The `RevocationSource` interface is ready for it. |
| T11-12 | Implementation choice | `TokenManager.signOut()` keeps the local session and throws when RTS can't be reached, unless `{ localOnly: true }`. | A sign-out that silently leaves the session alive server-side for up to 7 days would mislead the user. F-005 decides what to offer. |

### Tests (T11)

- **Unit** (`packages/auth`, 86 tests in 7 files, hermetic):
  - `access-token-verifier.test.ts`, **TC-F-002-11**, a rejection matrix of 30 cases. Every reason code is covered:
    - `malformed` (garbage, a refresh token, missing `sid` or `exp`);
    - `wrong_alg` (`none`, HS256 keyed with the public JWK, Entra-style RS256);
    - `wrong_typ`;
    - `forbidden_header` (`jku`, `jwk`, `x5u`, `x5c`, `crit`);
    - `unknown_kid` (missing, another key, an unknown version);
    - `bad_signature` (a tampered signature, a tampered payload);
    - `unknown_issuer`;
    - `wrong_audience` (4 audiences, an array, another org);
    - `expired`, `not_yet_valid`, `issued_in_future` and `wrong_token_use`.

    Also covered:
    - skew boundaries;
    - revocation verdicts passed through, and revocation asked only for authentic tokens;
    - a throwing `onReject`;
    - an unreachable JWKS → `VerifierUnavailableError`;
    - the JWKS cooldown and max age: a new `kid` is refused inside 5 s and accepted after, the old `kid` keeps validating, and a refetch happens after 60 s.
  - The same file, **TC-F-002-12**: 1,000 verifications with a warm JWKS and feed, **p50 0.130 ms, p95 0.166 ms** (bound 10 ms, target 2 ms), on a local run on darwin_arm64 with Node 24.21.
  - `revocation-feed.test.ts`, the **TC-F-002-11** feed part:
    - G-1 staleness exactly after 60 s;
    - `issued_at` more than 30 s old or ahead is not a confirmation, and a replayed good answer stops counting;
    - a lower `epoch` is refused and an equal one accepted;
    - `session_revoked` and `user_revoked` (`revoked_before` = DB + 30 s);
    - overlap de-duplication keeps the latest `revoked_before`, and `since=cursor` is sent;
    - a non-confirming answer adds revocations but not kill switches or its cursor;
    - 401, invalid bodies and a failing service token;
    - pruning;
    - the poll loop's start and stop.
  - `service-token-source.test.ts`:
    - the assertion header, claims and lifetime, verified with jose against the in-memory Transit key (latest version);
    - a custody violation signs nothing;
    - renewal at 50 % and at about 60 % with jitter;
    - the current token is kept during failed renewals, with backoff, and it fails closed after `exp`;
    - single flight.
  - `principal-resolver.test.ts`: the 30 s cache, single flight, 404, a non-UUID id never sent, and fail-closed cases.
  - `client-flows.test.ts`:
    - **TC-F-002-02 (client half)**;
    - AC-4 reporting before throwing for 7 IdP failure kinds, the classifier included (AADSTS53003 → `DeviceCodeBlockedError`);
    - local expiry, and 5xx back-off reported as unreachable;
    - a cancel is not reported, and a failing report doesn't mask the error;
    - device code disabled;
    - untrusted device answers refused;
    - config issuer pinning;
    - RTS error mapping and i18n-key allow-listing;
    - PKCE, including the RFC 7636 appendix B vector;
    - the authorize URL, which refuses a non-loopback redirect;
    - callback state and error handling;
    - the code-redemption and revoke forms.
  - `token-manager.test.ts`:
    - 10 concurrent callers make 1 refresh;
    - three audiences refresh in sequence with the latest rotated token;
    - the 60 s margin;
    - `invalid_grant` clears the store;
    - a 503 keeps the token;
    - two managers over one store end in reuse (the documented defect);
    - `signedIn` and `signOut`, including `localOnly`;
    - no file-backed store is exported.
- **Integration** (`services/control-plane/test/integration/gateway.int.ts`, 4 tests, dev stack). A fake gateway built only on `@ralysa/auth` talks to a real control plane over real HTTP. Its identity is a client assertion signed through its own OpenBao Transit key.
  - **TC-F-002-10**: 20 negative cases, each rejected with the expected reason:
    - expired;
    - a tampered payload and a tampered signature;
    - 4 wrong audiences and an array audience;
    - an unknown issuer;
    - `alg: none` (empty signature → `malformed`);
    - HS256 keyed with the public JWK;
    - a missing `kid` and an unknown `kid`;
    - `typ: JWT`;
    - `nbf` in the future;
    - a revoked `sid` (sign-out, then a feed poll);
    - `iat` before `revoked_before` (user disabled on refresh);
    - a service token at the user route;
    - an Entra RS256 token;
    - a refresh token as a bearer.

    That gives 20 `onReject` calls and 20 aggregator emissions, all under the configured org on `203.0.113.0/24`. A valid token yields the user id, `org_id`, session, and through `PrincipalResolver` the groups and roles.
  - **TC-F-002-09 (gateway part)**: a user disabled at the IdP on refresh is refused (`user_revoked`) after the next feed poll, and any token is refused after `exp` + skew.
  - The feed over real HTTP: the epoch is monotonic and the confirmation time advances.
- Full control-plane integration suite: 7 files, 92 tests, all passed locally.

### Code review of PR #28 (changes requested, no blockers): resolutions

| Item | Finding | Fix | Test |
|---|---|---|---|
| R28-1 (should fix) | Once the service token had expired, every `getToken()` called `renew()` at once and ignored `retryAt`. During an outage that is a tight Transit + RTS loop [AR-1]. | When the token isn't valid, no renewal is in flight, and `now() < retryAt`, `getToken()` throws `ServiceTokenUnavailableError` (with the last error's message) without renewing. A renewal already in flight is joined. The backoff (1 s, doubling to 30 s) therefore also applies after expiry. | `service-token-source.test.ts`: "after exp, an outage does not turn every getToken() into a Transit + RTS call". 51 calls inside the backoff make no request, and later attempts follow 1 s, then 2 s. The existing failure test now steps the clock past the backoff before recovery. |
| R28-2 (should fix) | The service-token tests waited on a real 25 ms timer. | `createServiceTokenSource` returns a `ManagedServiceTokenSource` with `settled()`, which resolves when no renewal is in flight. The tests await it, and no test in `packages/auth` uses a real timer any more. | `service-token-source.test.ts` (all background-renewal cases). |
| R28-3 | A missing or mistyped `nbf`, `aud` or `iss` was mapped to `not_yet_valid`, `wrong_audience` or `unknown_issuer`. | A jose `JWTClaimValidationFailed` whose `reason` isn't `check_failed` (that is, `missing` or `invalid`) is now `malformed` before any per-claim mapping. | Matrix cases: missing `nbf`, missing `aud`, missing `iss`, and `nbf` not a number → `malformed`. |
| R28-4 | The Bearer scheme was matched case-sensitively. | `/^bearer /i` (RFC 7235: the auth scheme is case-insensitive). | `bearer`, `BEARER`, `BeArEr` and a bare token are accepted; `Basic …` → `malformed`. |
| R28-5 | `TemporarilyUnavailableError` said a retry is safe, but a network error or timeout (a lost response) mapped to it too, and after a lost refresh answer a retry is reuse. | New subclass `ResponseLostError extends TemporarilyUnavailableError`, with `lostResponse: true` (the base class has `false`). `postTokenGrant` (refresh, exchange, code redemption) throws it when no answer arrived. The docs now say a retry is safe only when the server answered. `revokeSession` and `fetchAuthConfig` keep the plain error: revoke is idempotent, and config is a GET. The token manager header and the README describe both cases. | See R28-6. |
| R28-6 | No test covered a lost refresh answer. | Test added. | `token-manager.test.ts`: a fake RTS rotates and then the fetch throws, giving `ResponseLostError` (`lostResponse: true`) with the store still holding the old token. The retry gives `SessionRevokedError` (`reuse_detected`), and the store is cleared. A refusal that arrived is `lostResponse: false`. |
| R28-7 | The README didn't say what happens when `store.save` fails after rotation. | README, "For F-005's `TokenStore`": the new token is kept in memory and the error is rethrown. The store still holds the rotated token, so the next start ends in reuse. The CLI should say so and retry the save or sign out at exit. Also stated in the token-manager header comment. | — |
| R28-8 | `stop()` then `start()` during an in-flight poll leaked a second loop. | A generation counter. `start()` and `stop()` bump it, and a poll only schedules the next one if its generation is still current and the feed is running. | `revocation-feed.test.ts`: a poll hangs, then stop, start, release; exactly one poll per 5 s follows. The test fails with the old condition (checked by temporarily reverting it). |
| R28-9 | `confirmedAt = now()` let an answer issued 29 s ago keep the PEP "fresh" for 60 s more (about 90 s of data age). | **Deviation from the suggested formula.** `min(now(), issuedAt + maxSkewMs)` would change nothing, because any accepted answer already has `issuedAt ≥ now − maxSkewMs`, so that value is always `now()`. The fix is `confirmedAt = min(now(), issuedAt)`: G-1 is measured from when the control plane issued the state, capped at our clock for a DB clock running ahead. In the worst case (the DB clock 30 s behind), the effective window is 30 s of our clock, which a 5 s poll still meets comfortably. | `revocation-feed.test.ts`: a 29 s old answer stays fresh for exactly 31 s more; an `issued_at` 10 s ahead is credited as now. |
| R28-10 | The README didn't say that service tokens stop 5 s before `exp`, or that an error thrown by a `RevocationSource` propagates. | README, Services: the last 5 s, the backoff, and "an error thrown by the `RevocationSource` propagates from `verify` as-is; treat it like `VerifierUnavailableError`" (T11-3). | — |

Tests after the review: `packages/auth` has 95 unit tests (9 new). The control-plane integration suite has 7 files and 92 tests; all pass locally.

## T10: IdP sign-in, part 1 (flow A, the shared sign-in core, Graph)

Branch `feat/F-002-idp-sign-in`, based on `main` after #28 (T11). T10 is split into two PRs for review (T10-1). This part is the flow-A path and everything flow B will reuse; part 2 (`feat/F-002-idp-sign-in-browser`, stacked on this one) adds flow B.

### What landed

- **Entra token validation** (`src/auth/idp/`):
  - `metadata.ts`: the pinned tenant's discovery document. Only `<idp.issuer>/.well-known/openid-configuration` is fetched. Its `issuer` must equal the configured one, and every endpoint and the key set must be on the issuer's origin [AR-12]. Keys come through jose's remote key set.
  - `entra-token-validator.ts`, steps 1–3 of §3.2.5:
    - a token whose `iss` is RTS's own is `untrusted_issuer` before anything else;
    - the header must be exactly `alg: RS256`, `typ: JWT` and a `kid`, plus Entra's optional `x5t`. Any other member is refused (`jku`, `jwk`, `x5u`, `x5c`, `crit`, `nonce`, …) [SEC-F002-07, -19];
    - an RS256 signature by the tenant's keys;
    - `iss` and `tid` pinned (`untrusted_issuer`); `exp`/`nbf` with 60 s skew and `iat` at most 10 min old (`expired`, AD-5); `ver` 2.0, `aud`, `azp`, `scp`, a GUID `oid` and a required `uti` (`invalid_idp_token`).
    - The group claim is classified as GUIDs (non-GUID values counted and ignored), overage, or absent [SEC-F002-08].
  - `graph-directory.ts`: Microsoft Graph behind the existing `IdpDirectory` port [SEC-F002-08, -09]:
    - `GET /users/{oid}?$select=accountEnabled,signInSessionsValidFromDateTime` and `checkMemberGroups` for exactly the two configured groups, at every sign-in and every refresh;
    - `404` means deleted; every call is bounded by `idp.graph_timeout_ms`; the circuit opens for 30 s after 5 consecutive failures;
    - an app-only token from the tenant's token endpoint with the KV client secret, cached, single-flight, and the secret re-read once on `invalid_client`;
    - `groupDisplayName()` for display names (2 s).
- **Identity mapping** (`src/auth/identity-mapping.ts`): the ADR-0011 input and output shapes, the strong-flow admin rule, `admin_role_withheld`, and the audience rule [AR-4, SEC-F002-06].
- **Sign-in core** (`src/auth/sign-in.ts`, `sign-in-store.ts`):
  - `SignInAttempt` guarantees exactly one `auth.sign_in` per attempt (a second record throws);
  - `authorizeAndProvision()` runs Graph, the decision, the audience check, group names and `provision()` (user by `(issuer, oid)`, configured groups with roles from config only, GUID claim groups, membership replacement, session, and the first refresh token for flow A) in one transaction;
  - `recordSuccess()` writes `auth.sign_in success` fail-closed after the session is committed (§5.8);
  - `directory.user.provisioned`/`.updated` and `directory.group_membership.changed` (`privileged` when the admin group changed, TM-49).
- **Token-exchange grant** (`src/auth/grants/token-exchange.ts`):
  - the validator; the consume-first replay key, committed on its own [SEC-F002-07];
  - the device-code switch (`unauthorized_client`);
  - MFA evidence when `require_mfa_claim` [SEC-F002-06];
  - the `ipaddr` mismatch flag, metric and log line [SEC-F002-05];
  - the sign-in core; the token response per RFC 8693 §2.2.1;
  - failures before the subject is validated carry `attempted_identifier_hmac` (`src/auth/identifier-hmac.ts`, key from `audit_hmac_path`) and `identifier_verified: false` [AR-17];
  - device labels and user agents go through `src/auth/display-text.ts` [SEC-F002-30].
- **Device-code switch** (`src/auth/device-code-switch.ts`): revokes every live `flow = idp_device` session with `auth.session.revoked cause=device_code_disabled`. `serve` runs it at every start while the switch is off [SEC-F002-32, D-30].
- **`POST /v1/auth/sign-in-failures`** (`src/auth/routes/sign-in-failures.ts`):
  - 10 per minute per client; idempotent per `attempt_id`;
  - the per-org cap of 60 events a minute, and `/24`/`/64` aggregation with `suppressed_count`, through the `auth.token_rejected` aggregator [AR-16, SEC-F002-16].
- **Wiring:** `serve` uses the Graph directory for sign-in and refresh (T08's `idp_directory_unconfigured` warning is gone), flushes the sign-in-failure aggregator on the 5 s timer, and runs the switch. `RtsServices` gains optional `secrets`, `idpMetadata`, `signInFailures`, `metrics` and `logger`.
- **Protocol:** new sign-in reason `internal_error` (outcome `error`, i18n key `auth.error.internal_error`), with the generated schema (T10-4).
- **Mock IdP:** the R27-N7 fix, and `email` in user access tokens (T10-13).
- **Docs:** the control-plane README ("Sign-in, flow A", the start-up switch, routes) and the dev-stack README (the `email` claim, the scope rule).

### Recorded decisions and deviations

Items marked **self-decided** were open questions decided under the standing authorization (CLAUDE.md), taking the recommended option.

| # | Type | What | Why |
|---|---|---|---|
| T10-1 | Scope (**self-decided**) | T10 lands as two PRs. Part 1 (this one): the Entra validator, discovery, the Graph directory, identity mapping, the sign-in core, the token-exchange grant, the device-code switch and the sign-in-failures route. Part 2 (stacked): `openid-client`, `/oauth2/authorize`, `/oauth2/idp/callback` and the `authorization_code` grant, with TC-F-002-01, -30 and the flow-B halves of -07 and -08. | The task is an L. The coordinator asked for a split if one PR would be too large to review; part 1 alone is about 2,000 lines of source and 1,600 of tests. |
| T10-2 | Design gap, filled (**self-decided**) | At sign-in, Entra's `signInSessionsValidFromDateTime` later than the IdP token's `iat` refuses the attempt as `failure expired` with `details.cause = idp_sessions_revoked`. It is compared at `iat`'s whole-second precision. | §6.3 item 4 defines the check against `auth_session.created_at`, which exists only at refresh. A token issued before an incident responder's "revoke sessions" should not start a new session. `SignInReason` has no `idp_session_revoked` (only `RefreshReason` has), and the token is stale, which is what `expired` means. Whole seconds, because a token minted in the same second as the revocation isn't older than it. |
| T10-3 | Interpretation | The IdP-token header allow-list is `alg`, `typ`, `kid` and `x5t`; any other member is refused. | §3.2.5 step 1 says "any other header value is refused". Entra v2 access tokens for a custom API carry these members. A `nonce` header (Entra adds one to Graph tokens) marks a token that isn't meant for RTS. |
| T10-4 | Design gap, filled; protocol addition (**self-decided**) | New `SignInReason` `internal_error` (outcome `error`). A signing or database fault after the attempt started records it, the session committed for it (if any) is revoked, and the answer is `503 temporarily_unavailable`. Design §3.5 is updated (revision 4). | AC-4 wants exactly one event per attempt, and none of the §3.5 reasons describes an internal fault (`idp_unavailable` would blame the IdP). PR #28's client parses reason codes with `safeParse`, so an addition doesn't break it. |
| T10-5 | Interpretation | A token-exchange request that doesn't parse (another `client_id`, no `subject_token`, a wrong `subject_token_type`) is `invalid_request` and not a sign-in attempt, so it writes no event. | It never reached IdP-token handling, in the same way a throttled `429` isn't an attempt (§3.4.1). An event per malformed request would be audit-write amplification [SEC-F002-16]. |
| T10-6 | Implementation choice | A subject token whose unverified `iss` is RTS's own is refused as `untrusted_issuer` before the header check. | §5.8 lists "RTS's own issuer" under `untrusted_issuer`; checked after the header, an RTS token would be `invalid_idp_token` (it is ES256). Classifying on an unverified claim only picks the refusal reason; nothing is accepted on it. |
| T10-7 | Interpretation | At sign-in, a requested audience other than `control-plane` for a session without the `user` role is refused as `denied not_in_access_group` (with `details.audience`). | The refresh grant answers this `invalid_scope` without an event (R26-6), but at sign-in every attempt must be audited exactly once, and the IdP token is already burned. Not being in the access group is exactly why the audience is refused. |
| T10-8 | Implementation choice | A user the IdP now reports as enabled is set back to `active` at the next sign-in (`directory.user.updated` with `changed_attributes: ["status"]`). | `disabled` in `cp.app_user` mirrors the IdP (set when Graph said disabled or deleted). A re-enabled account that could never sign in again would need a manual database edit. |
| T10-9 | Design gap, filled | When the fail-closed success write fails, the **same** success event (same `event_id`) and `auth.session.revoked cause=audit_unavailable` are spooled. | §5.8: "Event spooled and replayed". Reusing the event id keeps the attempt at one event, even if the timed-out insert commits later: the replay is then a `duplicate`. |
| T10-10 | Deviation from §2.1 (addition) | `src/auth/sign-in-store.ts` is a persistence port for sign-in, with a Postgres implementation. | The design asks for a unit test that enumerates every sign-in exit. A port lets `test/sign-in-exits.test.ts` reach each exit on purpose without a database. |
| T10-11 | Implementation choice (**self-decided**) | Client-reported failures: the client's claims go under `details.client` (sanitised) and server facts under `details.server` (`reported_by: client`, `client_ip`, `network`, `attempt_id`, `suppressed_count`), with `attestation: client` and the policy version. The event id is a version 8 UUID derived from the org and `attempt_id`, so a repeat on another replica is a `duplicate`. An in-memory 10-minute set answers repeats on the same instance. The aggregation reuses `createRejectionAggregator` (60 per window, 10 per `/24`/`/64` and error). | §3.4.1 asks for idempotency, the per-org cap and the `/24`/`/64` aggregation; §3.4.5's reserved-key scheme already separates client and server facts. |
| T10-12 | Implementation choice | `expired_token` reports are `failure expired`; every other reported IdP error is `failure idp_error` (§5.8). | `SignInReason` has only those two for IdP-side outcomes. |
| T10-13 | Mock change (**self-decided**) | The mock's user access tokens carry `email` (= the UPN). | §6.7 has the RTS app registration request the `email` optional claim, and AC-1 / TC-F-002-01 expect the email in `/v1/me`; the T09 mock only had it in the ID token. |
| T10-14 | Implementation choice | The Graph app token is fetched single-flight (a check's two calls share one request) and cached until 60 s before expiry. The IdP client secret is re-read once on `invalid_client`. | The full secret watcher with `secret.rotated` is T13's; this keeps a rotation from failing Graph until T13 lands. |
| T10-15 | Scope | The device-code switch runs at every `serve` start while the switch is off; there is no live config reload. | D-30 says "detected at start and on config reload", but Phase 0 has no reload: a config change is a restart, and the start-up run is idempotent. |
| T10-16 | Implementation choice | The switch revokes flow-A sessions that are `active` or `pending`. | Flow A never creates a pending session today, but "every live session" shouldn't depend on that. |
| T10-17 | Implementation choice | Group display names are read inline before provisioning: groups whose name is unknown or older than a day, at most 20 per sign-in, 2 s each, in parallel. A failed read leaves the stored name as it was. | TC-F-002-21 reads the names from `/v1/me` right after sign-in. The cap bounds a user with 200 groups. |
| T10-18 | SEC-F002-10 (evaluated) | A separate Graph app registration is **evaluated, not built**: the config has one `rts_client_id` and one secret path, and the README and §6.7 checklist recommend it. The ≤ 180-day secret expiry in the rotation runbook is T13's DoD. | Supporting two registrations needs a second client id and secret path in `ServeConfig`; that is a config contract change best made with T13's secret watcher. |
| T10-19 | Implementation choice | `ipaddr` and the client IP are compared after stripping the IPv4-mapped prefix (`::ffff:`). | Node reports IPv4 clients on a dual-stack socket as `::ffff:a.b.c.d`. |
| T10-20 | Kept (T07-3) | `/v1/auth/config` still derives the device and token endpoints from the issuer. | They are the same Entra URLs the discovery document names; changing the route to fetch discovery would make it fail when the IdP is down, for no gain. |

### Tests (T10 part 1)

- **Unit** (control-plane, 288 in total, 103 new):
  - `sign-in-exits.test.ts` (25): every exit of the token-exchange grant writes exactly one `auth.sign_in` with the right outcome and reason, and answers the right OAuth error. The exits are the malformed request (none), `invalid_idp_token`, `untrusted_issuer`, `expired` (token and Entra session revocation), `replay`, the replay-store fault, `device_code_disabled`, `mfa_claim_missing`, `idp_unavailable`, `group_overage_unresolved`, `user_disabled` (disabled; deleted with a known user, after its `auth.session.revoked`), `not_in_access_group` (group and audience), `admin_requires_strong_flow`, provisioning, signing and audit faults, and success. One test checks that the list covers every flow-A reason. Also: a second record throws; the `ipaddr` mismatch is recorded and counted without denying; `admin_role_withheld`; bidi and zero-width stripping that keeps Arabic and RLM.
  - `entra-token-validator.test.ts` (35): acceptance, `oid` not `sub`, `x5t`, the RTS issuer, eleven header refusals, bad signatures, fourteen claim refusals, skew, the HMAC input, group classification, and the replay key.
  - `identity-mapping.test.ts` (15): the ADR-0011 output, the role matrix (weak and strong flows, auth context, `fido`/`wia`), audiences, and display-text stripping.
  - `graph-directory.test.ts` (13): exactly the two configured groups, the app token and its cache, the secret re-read, disabled and 404, a null `signInSessionsValidFromDateTime`, fail closed on 5xx, 429, a malformed body and a failed token request, the timeout, the circuit (opens after 5, answers without calling, closes after 30 s), the failure-count reset, and display names.
  - `sign-in-failures.test.ts` (15): the event shape, `expired` mapping, idempotency, invalid reports, the per-client limit, `/24` and `/64` aggregation with `suppressed_count`, the per-org cap, and the discovery pinning (issuer, origins, malformed, retry).
- **Integration** (`test/integration/sign-in.int.ts`, 18, dev stack plus the in-process mock IdP with the real Graph directory):
  - **TC-F-002-02**: `fetchAuthConfig`, `startIdpDeviceSignIn` (user code, verification URI, interval) and approval at the mock; the poll returns the IdP token, and `exchangeIdpToken` returns Ralysa tokens. Then `/v1/me` (oid, email, name, org, groups with the Arabic access-group name), a refresh through Graph, and the audit events. This closes T11-1.
  - **TC-F-002-03**: an expired device code (3 s TTL) is reported by the client as `failure expired`; a used device code is refused by the IdP; the same IdP token twice is `replay`; a first exchange that fails on a Graph fault burns the token, and the retry is `replay`; no `uti`, `HS256`, `ver` 1.0, an RTS-issued token and a foreign key are refused, with the identifier HMAC and never the name.
  - **TC-F-002-04**: with the switch off, `/v1/auth/config` says so; the exchange is `unauthorized_client` with `denied device_code_disabled`; the switch revokes the flow-A sessions (idempotent), writes `auth.session.revoked cause=device_code_disabled`, and their refresh fails.
  - **TC-F-002-07 (flow A and client reports)**: 50 attempts (10 successes, 10 bob, 5 carol, 5 reported expiries, 5 replays, 5 untrusted issuers, 10 reported IdP errors) → exactly 50 `auth.sign_in` events with the expected outcomes and reasons. Each has a `trace_id`, the policy version, a timestamp, the client IP and the flow. Two throttled reports write nothing. The stored events contain no JWT, `rly_` token, the client secret or the HMAC key.
  - **TC-F-002-08 (flow A)**: bob → `access_denied`, `auth.denied.not_in_access_group`, no user, no session, and a `denied` event with his oid.
  - **TC-F-002-09**: carol, refused at the IdP → the client reports `idp_error`; disabled after the IdP token was minted → `user_disabled`, the user disabled with `revoked_before`, sessions revoked, refresh refused; dora (Graph 404) refused, and once known, revoked on refresh; Graph latency 3.5 s → `error idp_unavailable` within the 3 s bound; the circuit opens after 5 failures and answers at once (`details.directory: circuit_open`); Entra "revoke sessions" → refresh `idp_session_revoked`, and an older IdP token is `expired`. (The fake-gateway part is T11's, in `gateway.int.ts`.)
  - **TC-F-002-21**: fatima's name and both group names in `/v1/me` are byte-identical to the fixture (`Buffer.compare`), with no U+FFFD.
  - **TC-F-002-24**: another `tid` → `untrusted_issuer`; olga (overage) resolved by Graph, and with a Graph fault `error group_overage_unresolved`; mallory's look-alike group → `not_in_access_group`; sam's on-prem group name is ignored (counted) and Graph decides; a non-UUID group id fails config validation.
  - **TC-F-002-31**: dana via device code → `admin_requires_strong_flow`; erin with weak `amr` → roles `[user]` and `admin_role_withheld`; erin with `fido` → `platform_admin`; no `mfa` in `amr` → `mfa_claim_missing`; an `ipaddr` that differs from the client IP → success with `ip_mismatch: true` and the metric.
  - TC-F-002-01 (flow-A half): a membership change is stored and audited (`directory.group_membership.changed`) at the next sign-in.
- **dev-stack**: the R27-N7 test; 100 unit tests; the integration suite passes.
- Full control-plane integration suite: 8 files, 110 tests, all passed locally.

### Open items (T10 part 1)

- **`revoked_before` and a quick re-sign-in.** Revoking a user sets `revoked_before` to the DB clock + 30 s (T08, SEC-F002-18 c). A user who is re-enabled, or whose Entra sessions were revoked, and who signs in again within those 30 s gets tokens that every verifier rejects (`user_revoked`) until the 30 s pass. This fails safe, but the CLI (F-005) should say "try again in a minute" rather than showing a generic error. Tracked in [#31](https://github.com/AI-RAM-POC/Ralysa/issues/31).
- Part 2 (flow B) is on the stacked branch; TC-F-002-01, -30 and the flow-B halves of -07 and -08 land there.

### Code review of PR #29 (changes requested, no blockers): resolutions

| Item | Finding | Fix | Test |
|---|---|---|---|
| R29-1 (should fix) | A discovery or JWKS fault (unreachable, timed out, malformed) was caught as a bad signature, so the answer was `400 invalid_grant` with `invalid_idp_token`. | The validator wraps the key resolver. Anything but `JWKSNoMatchingKey` (an unknown `kid`) marks the keys unavailable, and the result is the new failure reason `idp_unavailable` (check `keys`). The exchange refuses with `error idp_unavailable` and answers `503 temporarily_unavailable`. The replay key comes after this step, so the IdP token isn't burned and a retry works. | `entra-token-validator.test.ts`: a network error, `JWKSTimeout`, `JWKSInvalid` and a discovery error → `idp_unavailable`; `JWKSNoMatchingKey` stays `invalid_idp_token`. `sign-in-exits.test.ts`: 503 with one `error idp_unavailable` event and no replay-key insert. |
| R29-2 (should fix) | When signing failed after provisioning committed, the `internal_error` refusal left out the `directory.*` events and the session's revocation. | `refuseAfterProvisioning()` revokes the session and passes `before: [...directoryEvents, auth.session.revoked cause=internal_error]` (the revocation only when it changed something). The same path covers a flow-A session without a refresh token (nit), which now also revokes the session. | `sign-in-exits.test.ts` "signing fault": the events are `directory.user.provisioned`, `directory.group_membership.changed`, `auth.session.revoked` (`internal_error`), `auth.sign_in`. |
| R29-3 (should fix) | The 3 s Graph bound applied per request, so a cold check (secret read, token, two calls) could take several timeouts. | One `AbortSignal.timeout(graph_timeout_ms)` per `check()`, shared by the KV secret read, the token-endpoint lookup, the app-token request and both Graph calls. Promises that take no signal (the secret store, a single-flight token request started by another check) are raced against it (`withDeadline`). Group display names have their own 2 s deadline. | `graph-directory.test.ts`: a 150 ms token endpoint plus hanging Graph calls end at the 200 ms deadline; a secret read that never answers ends at the deadline. `sign-in.int.ts` TC-09: Graph latency 3.5 s → 503 in under 3,750 ms. |
| R29-4 (should fix) | A token with overage markers or no `groups` claim replaced the whole membership set, deleting earlier `token_claim` rows. | `ProvisionInput.claimsKnown` (true only for a group list). Without it, only `graph_check` rows are removed; `token_claim` rows are kept. | `sign-in.int.ts` TC-01 (flow A): alice signs in with an extra claimed group, then with an overage token; `/v1/me` still lists both groups. |
| R29-n1 | Any Graph 404 counted as a deleted user, and the `checkMemberGroups` 404 body wasn't consumed. | Only a 404 whose body has `error.code = Request_ResourceNotFound` is a deletion. Any other 404 (a wrong base URL, a proxy page) is `unavailable` (`not_found_unexpected`). Each 404 body is read, and the other response is cancelled. | `graph-directory.test.ts`: a 404 with `BadRequest` and an HTML 404 → `unavailable`; the Graph 404 is still `deleted`. |
| R29-n2 | The interpretation of a future `nbf`/`iat` wasn't recorded. | **Interpretation:** an IdP token with `nbf` or `iat` more than 60 s in the future is `invalid_idp_token`, not `expired`. `expired` is for a token that is too old (`exp`, the 10-minute `iat` age). A token from the future means a broken or forged issuer clock, not a user who has to start again. | Existing matrix cases in `entra-token-validator.test.ts` (`nbf`, `iat_future`). |
| R29-n3 | Stripping U+200C/U+200D breaks Persian and Urdu names in Arabic script, and emoji sequences. | **Decision (self-decided):** ZWNJ and ZWJ are kept. U+200B (zero-width space), U+2060 (word joiner) and U+FEFF are still stripped, as are the C0/C1 controls and the bidi embedding, override and isolate characters. SEC-F002-30's spoofing concern is the bidi controls; ZWNJ and ZWJ change shaping, not direction. | `identity-mapping.test.ts`: a Persian name with ZWNJ and a ZWJ emoji family are kept byte for byte; ZWSP, WJ and BOM are stripped. |
| R29-n4 | The sign-in-failure caps are per instance. | Documented in the README and here: the 60 events per minute per org, and the per-client limit, are **per serve instance**, so N replicas allow up to 60 × N. Aggregation keeps the audit volume bounded per instance; a shared limiter would need Redis (F-012). | — |
| R29-n5 | `serve` passes no metrics exporter, so counters go to `noopMetrics`. | An open item in status.md: the exporter lands with the observability work (Prometheus endpoint or OTel metrics, F-011/F-023). Until then, the alerts that depend on these counters rely on the log lines (`auth_device_ip_mismatch`, `sign_in_audit_unavailable`). | — |
| R29-n6 | A flow-A session without a refresh token threw without revoking it. | Revoked through `refuseAfterProvisioning` (R29-2). | Covered by the same path as R29-2. |
| R29-n7 | T10-2: revoke what the user holds when an IdP token predates Entra's "revoke sessions". | A known user is also revoked (`revokeUser`, reason `idp_sessions_revoked`), with `auth.session.revoked` when something was revoked. It costs one statement, on a path that only runs after an incident responder acted. | `sign-in.int.ts`: the stale-token case still answers `expired`. The earlier refresh in the same test already revoked her, so no second event is written. |
| R29-n8 | A GitHub issue for F-005's "try again shortly" message after the ~30 s `revoked_before` window. | Issue [#31](https://github.com/AI-RAM-POC/Ralysa/issues/31), linked in status.md. | — |

## T10: IdP sign-in, part 2 (flow B)

Branch `feat/F-002-idp-sign-in-browser`, stacked on part 1 (`feat/F-002-idp-sign-in`).

### What landed

- `src/auth/idp/oidc-client.ts`: RTS as a confidential OIDC relying party toward the pinned tenant, on `openid-client`:
  - discovery of `idp.issuer`, cached for an hour; plain `http` is allowed only outside production;
  - the authorization URL with RTS's own state, nonce and PKCE S256;
  - code redemption with the KV client secret (`client_secret_post`), re-read once on `invalid_client`, with 3 s timeouts;
  - the result is `ok`, `unavailable` (network, 5xx) or `rejected` (a protocol or validation failure; the reason carries no token).
- `entra-token-validator.ts` gains `validateIdToken()`: the same header, signature, issuer, tenant, freshness, `ver`, `oid` and `uti` rules, with `aud` = the RTS registration and no `azp`/`scp`.
- `src/auth/flow-b.ts`:
  - `startAuthorize()`: the RFC 6749 §4.1.2.1 split between redirectable and non-redirectable errors; state, nonce, verifier and the browser binding; the stored request.
  - `completeCallback()`:
    - consumes the request (`DELETE … RETURNING`) and checks the cookie;
    - handles an IdP `error`, redeems the IdP code, applies the ID-token rules and MFA evidence;
    - runs `authorizeAndProvision()` with a **pending** session and creates the bound code.
    - It writes no success event (D-38).
- `src/auth/grants/authorization-code.ts`:
  - bound redemption: client, redirect URI and S256 verifier in one UPDATE;
  - reuse: the session is revoked and `auth.token.reuse_detected` (`token_kind: authorization_code`) written;
  - the redemption-IP check (`deny` / `alert`);
  - activation with the first refresh token, minting, and `auth.sign_in success` fail-closed.
- `src/auth/routes/authorize.ts`: the two browser routes (302 with `no-store` and `no-referrer`), the binding cookie, and the plain-text en/ar error from `src/i18n/{en,ar}.json`.
- `sessions.ts`: `redeemAuthorizationCode()` takes an optional binding (a `mismatch` outcome); `createAuthorizationCode()`, `activatePendingSession()`. `sign-in-store.ts`: the flow-B persistence methods.
- Migration `cp/0006_authorization_code_sign_in` (T10-22). The lock and the generated checksums are updated.
- Route contracts for both browser legs; OpenAPI regenerated.

### Versions

| Item | Pinned | Evidence |
|---|---|---|
| `openid-client` | **6.8.8** (control-plane dependency) | Published 2026-09-05 (21 days old). MIT. No install scripts (`strictDepBuilds` passes). Depends on `jose` (the catalog's 6.2.12) and `oauth4webapi`. |
| `oauth4webapi` | 3.8.8 (transitive) | Published 2026-09-05. MIT. No install scripts. |

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T10-21 | Implementation choice | `openid-client` handles discovery, the authorization URL, the code grant and the ID-token checks (signature, `iss`, `aud`, `exp`, nonce, state, PKCE, and `iss` in the response when advertised). RTS then applies its own pinned rules (`validateIdToken`). | §2.2 names `openid-client`. The RTS rules add what an OIDC library doesn't know: the tenant, `ver`, the header allow-list, `uti` and a GUID `oid`. |
| T10-22 | Design gap, filled (**self-decided**); migration | `cp/0006` adds `authorization_code.sign_in jsonb` (an object, at most 4 KB). It carries the callback's facts to redemption: `amr`, `acr`, `idp_ipaddr`, roles, `admin_role_withheld`, `auth_time` and the browser's user agent. | D-38 writes `auth.sign_in success` at redemption, and that event (and the token's `amr`) needs what only the callback knew. §4.4 had no place for it. It holds display facts only, never a token, code or secret (TC-07 scans it). |
| T10-23 | Interpretation | A missing or wrong browser-binding cookie at the callback is recorded (`failure browser_binding_failed`) and answered with the **plain-text 400**, not a redirect to the loopback. | §3.3 says "invalid_request"; it doesn't say where. This browser didn't start the flow, so a redirect would hand the victim's browser a redirect to a loopback port the attacker chose. |
| T10-24 | Implementation choice | A redemption consumes the code only when the client, the exact redirect URI and S256(`code_verifier`) all match (one UPDATE). A live code presented with anything else is `invalid_grant`, is **not** consumed, and is not a sign-in attempt. A used code is reuse, as in T08. | RFC 7636 §4.6. An attacker guessing verifiers can't burn the owner's code, and the owner's attempt still ends in exactly one event (success, or `code_not_redeemed` from cleanup). |
| T10-25 | Design gap, filled | If the pending session is no longer pending at redemption (revoked in the meantime, e.g. by the device-code switch, a disabled user or cleanup), the attempt is `failure expired` with `details.cause = session_not_pending`. | Every attempt needs one event. The code was valid, but what it would have activated is gone. |
| T10-26 | Scope / residual | An unknown or expired callback `state` (the user took more than 10 minutes, or replayed the IdP's redirect) is not a sign-in attempt and writes no event. An authorize that is never followed by a callback writes none either. | Nothing identifies a user or an RTS-side attempt there. D-38 covers unredeemed codes, which is the only point where RTS has issued anything. AC-4's residual is the same as for a client that never reports a device-flow failure: no tokens were issued. |
| T10-27 | Deviation from §2.1 (file layout) | The two browser routes share `routes/authorize.ts`, rather than being split into `authorize.ts` and `idp-callback.ts`. The logic is in `flow-b.ts`. | The routes share the cookie, redirect and plain-text helpers; each is about 15 lines. |
| T10-28 | Deviation from §2.2 | No `@fastify/cookie`: the callback reads the one cookie it needs with a 10-line parser, and the routes write `Set-Cookie` directly. | The same reason as T08-11: one cookie, no signing, and one less dependency. |
| T10-29 | Implementation choice | Flow B asks the IdP for `openid profile email` only. | RTS needs the ID token, not an access token for its own API. |
| T10-30 | Interpretation | In flow B, `details.ip_mismatch` is the callback IP versus the redemption IP (§3.3). The IdP's `ipaddr` is recorded as `idp_ipaddr` for comparison, and `callback_ip` is recorded too. | In flow A, `ip_mismatch` is `ipaddr` versus the exchange IP (§3.2.5); in flow B the binding the design checks is the loopback host. |
| T10-31 | Implementation choice | The server-rendered string is in `src/i18n/{en,ar}.json`, imported as JSON modules, with `src/i18n/review.json` marking the Arabic `needs-native-review` (F-001 OQ-D8). The control-plane `tsconfig.json` includes `src/i18n/*.json`, so `tsc` copies them into `dist`. | §3.9 names these files. `check-i18n` covers UI workspaces only, so the review file follows the same shape by hand. |
| T10-32 | Implementation choice | `invalid_client` at the IdP's token endpoint re-reads the client secret once and retries the redemption. | A failed client authentication doesn't redeem the IdP's code, so a retry is safe. This keeps a secret rotation from failing flow B until T13's watcher lands. |
| T10-33 | Implementation choice | At the callback, the `directory.*` events (provisioning and membership changes) are written with `writeOrSpool`. The success event, and with it the fail-closed write, comes at redemption. | Provisioning happens at the callback. It isn't a grant of access by itself: the session is pending until redemption. |

### Tests (T10 part 2)

- **Unit** (`sign-in-exits.test.ts`, 50 in total, 25 new):
  - **Callback exits**:
    - not attempts, no event: an unknown state, an expired request;
    - one event each: the cookie missing, a wrong cookie, an IdP error, the IdP unreachable, the IdP response rejected, the ID token from another tenant, MFA missing, Graph unavailable, not in the access group, a code-creation fault (the pending session is revoked);
    - allowed, a bound code and no event: an ordinary user, and an admin-only user (flow B is strong).
  - **Redemption exits**:
    - a malformed request, an unknown code and a wrong verifier or redirect URI write no event;
    - reuse writes `reuse_detected` and `session.revoked`;
    - an IP mismatch in deny mode is denied and revoked; in alert mode it is a success with `ip_mismatch`;
    - a session that is no longer pending, a signing fault, and an audit fault (fail-closed, the success event spooled);
    - success.
  - A test checks that the flow-B-only reasons are all covered.
- **Integration** (`test/integration/sign-in-browser.int.ts`, 11; the dev stack plus the mock IdP, with the CLI side on `@ralysa/auth`'s PKCE, state, authorize-URL and callback helpers):
  - **TC-F-002-01**:
    - flow B end to end; no sign-in event at the callback and a pending session;
    - redemption activates the session and writes one success with the callback and redemption IPs and both user agents;
    - `/v1/me` shows the oid, email, name, org and groups;
    - after a group change, the stored membership follows and `directory.group_membership.changed` is written.
  - **TC-F-002-08 (flow B)**: bob is redirected with `access_denied` / `not_in_access_group`; `readAuthorizationCallback` maps it to the i18n key; no user, no session, and a `denied` event.
  - The IdP refusing carol → `failure idp_error`, redirected.
  - **TC-F-002-30**:
    - a missing cookie and a wrong cookie → `browser_binding_failed` and a 400 (no redirect);
    - redemption from another IP → `denied loopback_ip_mismatch`, the session revoked, and `auth.session.revoked`;
    - in `alert` mode → success with `ip_mismatch: true`;
    - a wrong verifier or redirect URI doesn't consume the code; a second redemption revokes the session and writes `reuse_detected`; one sign-in event in all;
    - an unredeemed code → exactly one `code_not_redeemed` from cleanup, across two runs.
  - **TC-F-002-31 (flow B)**: erin with weak `amr` still gets `platform_admin` on flow B, and dana (admin only) gets `platform_admin`.
  - **TC-F-002-07 (flow B)**: 10 sign-ins → exactly 10 success events. No JWT, `rly_` token or client secret is in any event, and none is in `authorization_code.sign_in`. With part 1's 50 flow-A and client-report attempts, the scripted total is 60, above the design's 50, and 20 of them are successes across both flows.
  - RFC 6749 §4.1.2.1: an unknown client, a non-loopback redirect URI and `localhost` get the plain-text en/ar 400 with `Content-Language: en, ar` and no `Location`. A missing challenge is redirected as `invalid_request`. An unknown callback state gets the plain-text 400.
- `sessions.int.ts` (T08): `authorization_code` is now served, so its AC-3 case expects `invalid_request` for an incomplete request; `device_code` and `implicit` stay `unsupported_grant_type`. `db.test.ts`, `db.int.ts` and `audit.int.ts` list `cp/0006`.
- Full control-plane integration suite: 9 files, 121 tests, all passed locally.

### Code review of PR #30 (changes requested, no blockers): resolutions

`feat/F-002-idp-sign-in` (with the #29 fixes) was merged into this branch first (a merge commit, no force-push).

| Item | Finding | Fix | Test |
|---|---|---|---|
| R30-1 (should fix) | No test covered the production cookie attributes or the redirect headers. | Tests only: the behaviour was already there. | `flow-b-routes.test.ts`: `bindingCookie()` for production over https (`__Host-`, Secure), dev over http (no prefix, no Secure) and test over https (Secure). An `app.inject` run with an https `public_base_url` checks the full authorize `Set-Cookie` (`__Host-rts_tx_<id>=<43 chars>; Max-Age=600; Path=/; HttpOnly; SameSite=Lax; Secure`), the callback's `Max-Age=0` clear, and `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on both 302s. |
| R30-2 (should fix) | The authorize IP was stored with the request but dropped at the callback. | `AttemptContext.authorizeIp`. Every flow-B `auth.sign_in` carries `details.authorize_ip`: at the callback (from the consumed request) and at redemption (from the code's stored facts, next to `callback_ip` and `client_ip`). `authorize_ip` is added to the `sign_in` object stored with the code and to the `StoredSignIn` schema. | `sign-in-exits.test.ts`: every callback refusal and every redemption event has `authorize_ip`, and the code's stored facts include it. `sign-in-browser.int.ts` TC-01 (success) and TC-30 (binding failures, IP mismatch) assert it. |
| R30-n1 | Malformed stored `sign_in` facts were silently replaced with defaults (no roles, no `amr`). | Treated as `internal_error`: logged (`auth_code_sign_in_invalid`), counted (`auth_code_sign_in_invalid_total`), the session revoked, `details.cause = stored_sign_in_invalid`. Nothing is guessed. | `sign-in-exits.test.ts`: "stored callback facts malformed" → 503 and one `error internal_error`. |
| R30-n2 | One cookie name per browser: two concurrent flows overwrote each other, and a callback with an unknown state cleared the cookie of a live flow. | The name is `__Host-rts_tx_<id>` (`rts_tx_<id>` in dev), where `<id>` is 12 base64url characters of SHA-256 of RTS's state toward the IdP. The prefix is kept. The callback gets that state back, so it reads and clears exactly its own cookie, and only when the request was found. | `sign-in-browser.int.ts`: two flows started in one browser get different cookies. Finishing them in reverse order, each callback clears only its own cookie, and both redeem. `flow-b-routes.test.ts`: an unknown state sets no cookie. |
| R30-n3 | A crash after the code was consumed but before the session was activated left a pending session with a used code and no `auth.sign_in`. | Cleanup step 1b: a pending session whose code was used and expired more than 5 minutes ago (`REDEMPTION_GRACE_S`) is revoked (`redemption_incomplete`) with one `UPDATE … WHERE status = 'pending' RETURNING`. `auth.sign_in error internal_error` is written with `details.cause = redemption_incomplete` and `recorded_by: cleanup`, exactly once across replicas. | `sign-in-browser.int.ts`: a used code with a still-pending session is recorded once over two cleanup runs, and the session is revoked. |
| R30-n4 | The IP normaliser was duplicated. | `src/http/ip.ts` (`normalizeIp`, `sameIp`), used by `sign-in.ts` and the grant. It now strips `::ffff:` only in front of a dotted IPv4 address. | Existing exits tests (the `::ffff:127.0.0.1` case) and the integration IP tests. |
| R30-n5 | Dual-stack hosts. | **UAT note** (also in status.md): on a host with IPv4 and IPv6, the browser may reach RTS over one family and the CLI over the other (for example through a proxy or VPN that prefers IPv6). The callback IP and the redemption IP then differ, and the default `loopback_ip_mismatch: deny` refuses a genuine sign-in (`denied loopback_ip_mismatch`). IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is already treated as the same address; two different families aren't, because nothing proves they are the same host. If UAT sees this, the tenant setting `alert` is the documented fallback. | — |

## T12: audit endpoints, part 1 (the control plane on `@ralysa/auth`'s verifier)

Branch `feat/F-002-audit-endpoints`, based on `main` after #30 (T10 part 2). T12 lands as two stacked PRs (T12-1): part 1 is the verifier migration the T11 notes deferred to T12 (T11-11) plus the PR #29 follow-ups; part 2 (`feat/F-002-audit-routes`, stacked) adds the three audit routes and the service rejection path (T11-2).

### What landed

- `@ralysa/auth`:
  - `createServiceTokenVerifier()`: the same shape, header, signature and claim checks as `createAccessTokenVerifier()` (one shared core), for `token_use: service` tokens with `aud: control-plane`. `sub` must equal `client_id` (`svc:<name>`), the org is pinned, and an optional `isRegistered(clientId)` refuses an unregistered client as `wrong_token_use`. It yields `{ clientId, service, orgId, expiresAt, tokenId }`.
  - The `keySet` option accepts any jose key resolver (`KeyResolver`), not only a remote JWKS. An error it throws that isn't a jose key error is `VerifierUnavailableError`, as for an unreachable JWKS.
- `services/control-plane`:
  - `src/auth/verifier.ts` replaces `src/auth/verify-local.ts` (deleted): `createControlPlaneVerifier()` builds both package verifiers over `createOwnKeySet()` (the JWKS rows through `keys.jwks()`, re-read at most once a second, as before) and `createDbRevocationSource()` (session first, then `revoked_before`, read directly from the database [SEC-F002-18 d], as before). Service tokens must belong to a registered service.
  - `route-auth.ts` requires an `Authorization` header with the Bearer scheme, records every rejection under the config org (OI-4), and answers `503 temporarily_unavailable` when the key set can't be read.
  - `@ralysa/auth` moves from a devDependency to a dependency.
- R29 follow-ups:
  - `createGraphDirectory()` takes an optional `deadline(ms)` factory (default `AbortSignal.timeout`). The two tests that waited on real timers ("one deadline covers the whole check", "a slow secret read") now abort a controller themselves once the request they wait for has been made, and assert that the token request and both Graph calls carry the check's one signal. `times out at graph_timeout_ms` keeps one real-timer check of the default.
  - `sign-in-exits.test.ts`: a known user whose Entra sessions were revoked after the IdP token was issued ends with `auth.session.revoked` (`cause: idp_sessions_revoked`) and then `auth.sign_in failure expired` (R29-n7).

### Recorded decisions and deviations

Items marked **self-decided** were open questions decided under the standing authorization (CLAUDE.md), taking the recommended option.

| # | Type | What | Why |
|---|---|---|---|
| T12-1 | Scope (**self-decided**) | T12 lands as two stacked PRs: this verifier migration, then the audit routes. | The task brief suggested it; the migration touches every authenticated route, so reviewing it apart from the new routes keeps each diff readable. |
| T12-2 | Design gap, filled (**self-decided**) | `@ralysa/auth` gains `createServiceTokenVerifier()`. | §3.6 lists only the user-token verifier, but the control plane (the only PEP for service tokens) must verify both kinds, and T11-11 moves it onto the package. Sharing one core keeps the two rule sets from drifting. |
| T12-3 | Behaviour change, deliberate (**self-decided**; wording corrected in review of #32, R32-2) | The Bearer scheme is matched case-insensitively at the control plane too (`bearer`, `BEARER`); a bare token without a scheme is still refused as `malformed`. That is the **only change visible to a client holding an RTS-minted token**. For forged or malformed tokens the package verifier differs from T08's in these reason codes (all are still rejections):<ul><li>`tid` ≠ the org is now checked after `token_use` and the claim schema, so a foreign-org **user** token at a service route is `wrong_token_use` (was `wrong_audience`);</li><li>user tokens are validated against the full `UserAccessTokenClaims`, including a required `nbf`, so a token with no `sid` is `malformed` (was `session_revoked`);</li><li>a missing or mistyped `iss`, `aud` or `nbf` is `malformed` (R28-3), not `unknown_issuer`, `wrong_audience` or `not_yet_valid`;</li><li>a service token whose `client_id` ≠ `sub`, or whose `sub` isn't `svc:<name>`, is `malformed`.</li></ul> | RFC 7235 makes the scheme case-insensitive, and the package already did so (R28-4). The reason-code differences come from using one verifier everywhere, which is the point of T11-11; RTS never mints such tokens, and the T08–T11 integration suites pass unchanged. |
| T12-4 | Behaviour change, deliberate (corrected in review of #32, R32-1) | When the JWKS rows can't be read (a database fault in `keys.jwks()`), an authenticated route answers `503 temporarily_unavailable`. T08's `verify-local.ts` caught that fault inside its signature step and turned it into `TokenRejectedError('malformed')`: a **401** for a valid token **and a false `auth.token_rejected malformed`** recorded against the caller. Since R32-4, a database fault while reading revocation state is `VerifierUnavailableError` (503) as well. | The package reports it as `VerifierUnavailableError` (T11-3). An infrastructure fault is not a token rejection: removing those false `auth.token_rejected` events, which blamed callers for a database outage, is part of the point. |
| T12-5 | Implementation choice | Token times and the key-set cache use the process clock, not `RtsServices.now`. | That is what the T08 verifier did. `now` is the tests' clock for in-memory caches (R26-11); stepping it must not expire tokens. |
| T12-6 | Kept (widened in review of #32, R32-2) | Both verifiers require `nbf` (the package's `requiredClaims`) and validate the full claim schema (`UserAccessTokenClaims`, `ServiceAccessTokenClaims`); T08's required only `iat`, `exp`, `jti`, `sub` and `tid`. | RTS mints `nbf` and every schema claim on every token, so only forged or malformed tokens are affected (they are `malformed`, T12-3). |

### Tests (T12 part 1)

- `packages/auth` `service-token-verifier.test.ts` (13): a registered service token yields the service; refused as `wrong_token_use` (a user token, an unregistered service), `malformed` (`client_id` ≠ `sub`, a `sub` that isn't `svc:<name>`), `wrong_audience` (another audience or org), `wrong_typ`, `forbidden_header`, `unknown_kid`, `expired`; no `isRegistered` accepts any authentic service; a throwing local key set is `VerifierUnavailableError` and no rejection. The existing 95 tests pass unchanged.
- control-plane `verifier.test.ts` (5): registered services only, and each verifier refuses the other token kind; the own key set re-reads the rows at most once a second; a bare token is `malformed`, recorded under the config org (an `X-Org-Id` header is ignored); a lower-case `bearer` passes; an unreadable key set is 503 with no rejection.
- The control-plane integration suite passes unchanged (9 files, 123 tests), including `/v1/me`, the governance feed, principals and TC-F-002-10's fake gateway.

### Code review of PR #32 (approved with nits): resolutions

| Item | Finding | Fix | Test |
|---|---|---|---|
| R32-1 (should fix) | T12-4 misstated the old behaviour: `verify-local.ts` turned a JWKS-row database fault into `malformed`, a 401 plus a false `auth.token_rejected`, not a 500. | T12-4 reworded; removing those false events is recorded as part of the point. | — (`verifier.test.ts` "an unreadable key set answers 503 and records no rejection") |
| R32-2 (should fix) | T12-3's "only visible change … same checks, order and reasons" wasn't exact. | T12-3 now says "the only change visible to a client holding an RTS-minted token" and lists the reason-code differences for forged tokens (foreign-org user token at a service route, missing `sid`, missing or mistyped `iss`/`aud`/`nbf`, a service token's `client_id`/`sub`). T12-6 is widened to user tokens. | — |
| R32-3 (nit) | `sessions.int.ts` didn't assert the rejection reason for a signed-out session at `/v1/me`, and no case used a `sid` of another user. | The TC-F-002-13 test asserts `['session_revoked']`, and a token for the user with **another user's live `sid`** is `session_revoked` too. | `sessions.int.ts` TC-F-002-13 |
| R32-4 (nit) | A database fault in the revocation read escaped as a generic error (500), unlike T12-4's key-set fault. | `createDbRevocationSource` wraps any query error in `VerifierUnavailableError('the revocation state could not be read')` (the package's error takes an optional message now), so the route answers 503 and records nothing. | `verifier.test.ts` "a revocation read that fails answers 503 and records no rejection" |
| R32-5 (nit) | `sign-in-exits.test.ts` used `Date.now() + 5_000` for a later `sessionsValidFrom`, close to the token's `iat`. | `Date.now() + 3_600_000` in both scenarios. | `sign-in-exits.test.ts` |
| R32-6 (nit) | Design revision 5's §3.6 sentence (`createServiceTokenVerifier`) belongs with this PR. | Design revision 5 is now this PR's (§3.6 and the control plane's verifier); part 2's design changes become revision 6. | — |
## T12: audit endpoints, part 2 (the audit routes and the service rejection path)

Branch `feat/F-002-audit-routes`, stacked on part 1 (`feat/F-002-audit-endpoints`).

### What landed

- **`POST /v1/audit/events`** (`src/audit/routes/service-events.ts`, AC-11):
  - A registered service's token only. A user token or an unregistered service gets 403 and `auth.token_rejected wrong_token_use`.
  - The envelope, I-JSON and outcome rules apply (422), and user actors must exist (422).
  - The per-service allow-list (`src/audit/action-allowlist.ts`) re-checks the reserved namespaces at runtime. One `audit.ingest_rejected` is written per disallowed action before the 403 [SEC-F002-03].
  - `source` comes from the service name.
  - Each event goes through the writer's savepoint INSERT, which fails closed in 250 ms (503) [AR-8].
  - **SEC-F002-23** is met by D-35: this route is the only audit write path for services, and no per-service writer role exists.
- **Service rejection path (T11-2)**:
  - `@ralysa/auth` `createRejectionReporter()`:
    - `record` is for the verifier's `onReject`. It never throws or waits.
    - The queue is bounded at 1,000. What doesn't fit is counted per reason and sent as `dropped_count`.
    - Every second it sends batches of 100 to the service path with the service's token.
    - A retryable failure is resent with the same ids. A refusal is dropped and reported through `onError`.
  - `src/audit/service-rejections.ts`:
    - one `createRejectionAggregator` per reporting service, which gives the per-verifier cap of 600 a minute and separate /24 and /64 buckets;
    - the org from the service token (pinned to config), and `source` = the service;
    - fire-and-forget writes;
    - report ids de-duplicated for 10 minutes;
    - `recordSuppressed()` (new on the aggregator) for dropped counts.
- **`POST /v1/audit/client-events`** (`src/audit/routes/client-events.ts`, `src/audit/client-sessions.ts`, AC-16):
  - the actor is overwritten;
  - the allow-list and reserved keys (422), and 4 KB per event (413);
  - server-issued sessions bound to `sid`, with the cap of 20 (409/429) [SEC-F002-14];
  - `client_seq` gaps, late events and `final_seq`, with `audit.client_seq_gap` at `session.ended` [AR-14];
  - kill-switch scopes through `src/governance/kill-switch.ts` (423 and `tool.call.denied`, TM-48);
  - 503 with `ack = false` on an insert failure;
  - 600 events a minute per user.

  `src/audit/client-sweep.ts` finalises idle gaps and flags unterminated sessions. `serve` runs it every minute.
- **`GET /v1/audit/events`** (`src/audit/routes/query.ts`, AC-12):
  - needs the session role and a current admin-group membership;
  - commits `audit.query success` before the read, else 503 [SEC-F002-06 c];
  - writes `audit.query denied not_platform_admin` before a 403;
  - keyset paging, with seals;
  - reads through the reader role in a read-only transaction.
- `serve` gains the `ralysa_audit_reader` pool, the service-rejection aggregators (flushed with the others), the client sweep, and a `service_without_audit_source` warning.
- `@ralysa/protocol/control-plane`:
  - `ServiceIngestStatus` (adds `aggregated`);
  - `TokenRejectedReportDetails` and `ClientEventsUnavailable`, both registered with the schema generator (25 schemas);
  - the client-path constants `CLIENT_EVENTS_PER_USER_PER_MINUTE`, `CLIENT_GAP_FINAL_AFTER_MS` and `CLIENT_SESSION_UNTERMINATED_AFTER_MS`.
- `RateLimiter.take(key, weight)`: one request can count as several (the events of a batch).
- Route contracts, the regenerated OpenAPI document, the READMEs (control plane "Audit endpoints", `@ralysa/auth` "Rejection reports") and design revision 6.

### Recorded decisions and deviations

Items marked **self-decided** were open questions decided under the standing authorization (CLAUDE.md), taking the recommended option.

| # | Type | What | Why |
|---|---|---|---|
| T12-7 | Protocol additions (**self-decided**) | `ServiceEventsResponse` gets the status `aggregated`. New `TokenRejectedReportDetails` (`audience`, `reason`, optional `client_ip`, optional `dropped_count`) and `ClientEventsUnavailable` (problem+json with `acks`). | §3.4.4's response knows only `stored` and `duplicate`, and an aggregated report is neither. The report's shape is a contract between `@ralysa/auth` and the control plane, so it belongs in the protocol. §3.4.5 says "503 with `ack=false` for every intent" but gives no body; a problem with the acks keeps the `/v1` error format. |
| T12-8 | T11-2 resolution (**self-decided**) | The aggregator stays in the control plane, because it needs `node:net`. Gateways send each rejection as a report through the service path. The control plane keeps **one aggregator per reporting service**, which is the "per-verifier cap" of SEC-F002-16. The reporter in `@ralysa/auth` bounds its own memory and counts what it drops. | There is one aggregation implementation and no isomorphic copy of `networkOf`, and the service path stays the only audit write path (D-35). A per-service aggregator stops one flooded gateway from using up another's budget. |
| T12-9 | Design gap, filled (**self-decided**) | `source` is derived from the service name: `model-gateway`, `mcp-gateway` and `workspace-runtime` map to themselves, and `agent-host` to `agent-host-server` (one name per source since R33-6). A registered service with any other name gets 403 and `audit.ingest_rejected reason_code=no_audit_source` for every batch, and `serve` warns at start. | §3.4.4 says "source from the service token", but `source` is a closed set (a column CHECK) and a token carries only `svc:<name>`. A config rule instead of a runtime refusal would also reject services that never write audit. |
| T12-10 | Interpretation | 403 (not 401) for `wrong_token_use` applies only to `POST /v1/audit/events`, as its error table says. The internal routes keep answering 401. | The §3.4.4 table is specific to that route, and changing the other routes' answers is outside T12. |
| T12-11 | Interpretation | 422 for a body that fails the schema, non-I-JSON `details`, `failure` outside `auth.*`, or an unknown user actor. 400 for JSON that doesn't parse (Fastify). | §3.4.4 names 422 for schema and I-JSON failures, and an actor that doesn't exist is the same kind of refusal. |
| T12-12 | Implementation choice | On the client path:<ul><li>Duplicates are found by `event_id` with the **reader** role before the cursor is touched (the writer has no SELECT).</li><li>A batch with any conflicting `client_seq` is refused whole (409).</li><li>A batch made only of stored events is answered (`duplicate`) even when its session has ended.</li><li>A duplicate intent is answered from the current kill-switch state, except one stored as `tool.call.denied`, which stays refused (R33-2).</li><li>A duplicate stored in this session still advances the cursor (R33-3).</li></ul> | [AR-14] requires duplicates to be detected by `event_id`. A retry of a batch whose answer was lost (for example the one with `session.ended`) must not look like a conflict. Refusing the whole batch keeps the cursor and the store consistent. |
| T12-13 | Design gap, filled (**self-decided**) | A null client `outcome` (an intent, `session.started`, `session.ended`, `approval.presented`) is stored as `success`, marked `details.server.outcome_defaulted: true` (R33-11). | The envelope's `outcome` is required (a NOT NULL column), and the event itself (a request made, a session started) did happen. |
| T12-14 | Interpretation | A refused intent keeps its `event_id` and is stored as `tool.call.denied`: `outcome denied`, `reason_code kill_switch`, and `details.server.kill_switch` and `requested_action`. The answer is 423 when any intent in the batch is halted, with `reason_category: kill_switch`. | §3.4.5 says to store `tool.call.denied` instead of acking. Keeping the id makes a retry a duplicate. |
| T12-15 | Implementation choice (**corrected in review of #33**, R33-3) | A batch runs in one `cp_app` transaction under a transaction-scoped advisory lock on the `sid`, with the cursor row `FOR UPDATE`. The audit write runs while that transaction holds its lock, but on the **writer pool, in its own transaction**: it is not inside the cursor transaction. The cursor is advanced only after the write reported success. A write that misses the 250 ms bound is answered 503 and the cursor stays put, but the insert can still commit afterwards (writer.ts, R21-3). The retry then finds those events stored, and since R33-3 their `client_seq` still advances the cursor. | The open-session cap and the cursor can't race; a failed write leaves the cursor where it was; a late commit can't produce a false gap on the retry (tested). |
| T12-16 | Interpretation | Gaps become final after 15 minutes without an event. A session is "unterminated" after **24 hours without an event** (`updated_at`), not 24 hours after it started.<ul><li>The sweep runs every minute on every replica with `SKIP LOCKED`.</li><li>Its event ids are derived from the session and range.</li><li>`audit.client_seq_gap` carries `cause` (`session_ended`, `idle`, `unterminated`) and has the session's user as actor.</li></ul> | A long-running but active host session must not be flagged. Derived ids make the route, the sweep and retries idempotent. |
| T12-17 | Implementation choice | The client path's per-user limit is per instance and counts events, not requests (`RateLimiter.take(key, weight)`). A refused batch still counts. | Same reason as R29-n4: a shared limiter needs Redis (F-012). |
| T12-18 | Implementation choice | Query details:<ul><li>`from` is inclusive and `to` exclusive; the default limit is 100.</li><li>The cursor is opaque (base64url of `[ts, event_id]`).</li><li>The admin check needs an **active** session.</li><li>`audit.query` records the filters, with the cursor only as `cursor: true`.</li><li>A missing reader pool is 503 before anything is written.</li></ul> | §3.4.6 doesn't set these details. |
| T12-19 | Hardening | Every string in `details.client` loses C0/C1, bidi and zero-width characters (keys are unchanged). `resource.id`, `operation`, `reason_code`, `turn_id` and `tool_call_id` are sanitised as display text. | SEC-F002-30 covers "every display field on the client path". |
| T12-20 | Test change | TC-F-002-10's fake gateway is now the service `model-gateway`. It signs with the dev stack's `ralysa-svc-model-gateway` Transit key instead of a throwaway `t11gw-*` key. | Its reports must be stored under a real `source` (T12-9). The key is only used to sign; nothing rotates or deletes it. |
| T12-21 | Residual, **fixed in review of #33** (R33-4) | ~~If the answer to a batch that opened a session is lost, the retry opens a second session.~~ A retried opening batch whose `session.started` is already stored now continues that session when it belongs to this user under this `sid`. Under another `sid` (a new sign-in) it opens a new session. | The duplicate lookup reads the stored event's `session_id`, so the first session is known after all. |

### Tests (T12 part 2)

- **Unit**:
  - `audit-ingest.test.ts` (32):
    - the allow-list: exact actions only; reserved actions never pass, even if listed; each disallowed action reported once, in order;
    - the source mapping;
    - **TC-F-002-37**: every reserved namespace is refused at config load, and the two exceptions are accepted;
    - `client_seq`: int8multirange parsing and formatting; next, gap, late and conflict; the tail up to `final_seq`; gap events with stable ids that pass the envelope rules;
    - kill-switch scopes: tenant with or without an id, department, pack and agent, and no match without a declared value;
    - service reports: 20 individual events then a summary under the service's source; a repeated id is a duplicate; dropped counts go to the overflow summary; each service has its own 600 cap;
    - the query cursor.
  - `openapi.test.ts`, **TC-F-002-17 part**: `/v1/audit` has only `POST /events`, `GET /events` and `POST /client-events`, and no PUT, PATCH or DELETE is routed.
  - `@ralysa/auth` `rejection-reporter.test.ts` (10):
    - the report shape and the bearer;
    - odd input never throws, and a non-IP address is left out;
    - at most 100 per request;
    - a 503 keeps the batch and resends the same ids;
    - 403 and 422 drop it with `onError`;
    - no service token keeps it;
    - queue overflow is counted and sent as `dropped_count`;
    - flush is single flight;
    - start and stop, with fake timers;
    - URL validation.
  - `@ralysa/protocol` (3): `aggregated`, the report details, and the 503 body.
- **Integration** (`test/integration/audit-routes.int.ts`, 26, dev stack):
  - **TC-F-002-17**:
    - an event is stored with `event_id`, `ts`, the actor, action, resource, outcome, `trace_id`, `session_id`, `endpoint_region`, `inference_region`, `details.model_id`, tokens, `source = model-gateway` and `attestation = server`;
    - `source` or `attestation` in the body is 422;
    - a duplicate mid-batch;
    - no token is 401; a user token and an unregistered service are 403, with `auth.token_rejected`;
    - `auth.sign_in`, `audit.query`, `db.migration.applied` and an action outside the list are 403, with `audit.ingest_rejected`, and nothing of the batch is stored;
    - a service without a source;
    - non-I-JSON, `failure` and an unknown actor are 422, and over 256 KB is 413;
    - **503 when `audit_event` is locked** (the 250 ms bound);
    - reports are aggregated and stored under `model-gateway`; a repeated report id is `duplicate`; a non-IP address becomes network `unknown`; bad report details are 422.
  - **TC-F-002-18**:
    - an admin's query by user, action, outcome and range returns exactly the matching events;
    - **a query for `audit.query` events returns itself**, which shows it was committed before the read;
    - the stored event has the filters and the `p0-static` policy version;
    - keyset paging over 5 events gives 3 pages with no gap or repeat, and each event carries its seal after a seal pass;
    - a non-admin gets 403, and the denied event is queryable;
    - the session role without a current admin membership is 403;
    - **503 with no events when `audit.query` can't commit**;
    - 400 for a range over 31 days, a reversed range, `limit=501`, a bad cursor and an unknown parameter.
  - **TC-F-002-22**:
    - the actor, org, source, attestation, surface and session are the server's; forged fields stay in `details.client`, and bidi characters are stripped; an `actor` member is 422;
    - a non-allow-listed action, four reserved keys and `final_seq` outside `session.ended` are 422; a 5 KB event is 413;
    - 409 without `session.started`, for an unknown session, for another user's, for another `sid`'s, and for a second `session.started`; the 21st open session is 429;
    - a gap; a late event that closes part of it; a duplicate retry; two conflicts; `session.ended` with `final_seq` writes three `audit.client_seq_gap` events;
    - an ended session refuses new events but answers a retry;
    - intents are acked with the epoch, then refused (423, `tool.call.denied kill_switch`) for a tenant, a department and a pack switch, and not for another pack;
    - **503 with `ack = false` while `audit_event` is locked**: nothing is stored, and the retry is stored without a gap;
    - 600 events a minute, then 429 with `Retry-After`;
    - the sweep finalises an idle gap and flags and closes an unterminated session; a second pass does nothing; closed gaps and sessions refuse later events.
  - **TC-F-002-10** (`gateway.int.ts`): the fake gateway's 20 rejections go through `createRejectionReporter` and `POST /v1/audit/events`. **20 `auth.token_rejected` events are stored** under the configured org, with `source = model-gateway`, the 20 expected reasons, the trace id, `client_ip` and the `/24`, no summary, and no token in anything stored. **This closes T11-2.**
- Full control-plane integration suite: 10 files, 149 tests, all passed locally.
- **CI found an order assumption in the tests.** Events of one batch inserted in the same millisecond share `ts`, so the query orders them by `event_id`, which isn't the insertion order. The paging test now asserts no gap or repeat and that the pages are in `(ts, event_id)` order, not the insertion order. Two other assertions on fire-and-forget writes compare without order. The audit-routes suite then passed 4 consecutive local runs.

### Code review of PR #33 (changes requested): resolutions

`feat/F-002-audit-endpoints` (with the #32 fixes) was merged into this branch first (a merge commit, no force-push). Part 2's design changes moved from revision 5 to **revision 6** (R32-6).

| Item | Finding | Fix | Test |
|---|---|---|---|
| R33-1 (S1) | A client `outcome: failure` on a non-`auth.*` action passed the route and the writer threw `InvalidAuditEventError`: a 500, and every retry of that batch failed the same way. | `checkEvents` refuses it with 422 (`outcomeAllowed`). The ingest path also maps `InvalidAuditEventError` to 422, so no other writer validation can surface as a 500. | `audit-routes.int.ts` "R33-1": 422, then the next event at the same seq is stored. |
| R33-2 (S2) | A duplicate intent was answered from the current kill-switch state. If it had been stored as `tool.call.denied` and the switch was lifted since, the retry got `ack: true` with no durable `tool.call.requested`. | The duplicate lookup reads the stored `action`. An intent stored as `tool.call.denied` is answered `ack: false`, `halted: true`, `reason_category: kill_switch` (and 423). | "R33-2": refused, switch lifted, the retry is still refused; a new intent is then acked. |
| R33-3 (S3) | A batch answered 503 whose insert committed after the 250 ms bound left the rows stored but the cursor not advanced. The retry was all duplicates, which never touched the cursor, so the next event got a false `seq_gap` and later a false `audit.client_seq_gap`. | For a duplicate stored in **this** session (the lookup reads `session_id` and `client_seq`, for the caller's own events only), the `client_seq` is applied to the cursor; a seq the cursor already covers is a no-op. A stored `session.ended` ends the session as well. The cursor is written whenever its state changed, not only when something new was stored. T12-15 is corrected: the audit write is **not** inside the cursor transaction. | "R33-3": rows written directly with the cursor at 1, the retry answers `duplicate` twice, the next event has no `seq_gap`, and `session.ended` writes no gap. |
| R33-4 (S4) | T12-21 was fixable: the stored `session.started` names its session. | An opening batch whose first event is already stored as `session.started` continues that session if its cursor belongs to this user and `sid`. T12-21 is updated. | "R33-4": the same `session_id`, one cursor for the user; the retry under another `sid` gets a new session. |
| R33-5 (S5) | The 503 tests could race a late commit once the lock was released. | `withAuditLocked` awaits the refused writes and then polls `pg_locks` until no insert is waiting on `audit_event` (each wait ends at its 250 ms `statement_timeout`) before `ROLLBACK`. | The three 503 tests; the suite passed 3 consecutive local runs. |
| R33-6 (N1) | `agent-host` and `agent-host-server` both mapped to `agent-host-server`, so two registered services could share a source. | One name per source: only `agent-host` maps to `agent-host-server`. | `audit-ingest.test.ts`: `agent-host-server` has no source. |
| R33-7 (N2) | A service could write events with `actor.type = service` naming another service, or `system`. | A `service` actor must be the calling service; `system` is refused (422). | "R33-7" (integration): another service's name and `system` are 422; its own name is 201. |
| R33-8 (N3) | The query validated its parameters before the admin check, so a non-admin learned which filters were valid and got no denial event for an invalid query. | The admin check (and the denial event) comes first. An invalid query from a non-admin is 403 with `details.filters = {invalid: true}`; from an admin it is 400. | "R33-8" (integration): a non-admin with `from=yesterday` gets 403 and the denial is stored. |
| R33-9 (N4) | Keyset paging and commit visibility. | **Documented, not clamped (self-decided).** `ts` is set at insert (`clock_timestamp()`), and a row becomes visible at commit. A row whose transaction commits after a page was read, with a `ts` before that page's last key, is skipped by the next page. Writes are bounded to 250 ms, but a late commit (R21-3) can exceed that. The query is an investigation tool, not an export: a query re-run over the same range sees every committed row. Clamping `to` to now − 1 s would narrow the window without closing it, and would hide the newest events from an incident responder. F-011's export and SIEM paths page on `ingest_seq` from the sealer's view instead. | — |
| R33-10 (N5) | Two concurrent retries of one batch. | **Noted (harmless).** Both look up duplicates before either takes the `sid` lock. The first stores the events (201). The second then sees a `client_seq` the cursor already passed for events it thinks are new, and gets 409. Nothing is stored twice (the event ids), and the host's next retry is answered `duplicate`. | — |
| R33-11 (N6) | A null outcome stored as `success` was indistinguishable from a client `success`. | `details.server.outcome_defaulted: true` is set when the server supplies the outcome. | "R33-4" and the 503 test assert it. |

Tests after the review (both PRs merged here): control-plane unit 24 files, 369 tests (R32-4's verifier case; R33-6 is an added assertion); `audit-routes.int.ts` 32 (6 new: R33-1, -2, -3, -4, -7, -8); the full control-plane integration suite 10 files, 155 tests, 3 consecutive local runs green.

## T14: scans and exclusion

Branch `feat/F-002-scans`, from `main` at 45cd12d (T01–T12 and T16 merged). Built in parallel with T13 (rotation, soak, runbooks), so it doesn't touch `src/secrets/runtime.ts`, `test/soak`, `soak.yml` or the control-plane README.

### What landed

- **gitleaks rules** `ralysa-refresh-token` (`rly_rt_[A-Za-z0-9_-]{43}`) and `ralysa-auth-code` (`rly_ac_[A-Za-z0-9_-]{43}`), identical in `.gitleaks.toml` and `.gitleaks.artefacts.toml`, with `secretGroup = 1`, `entropy = 3.5` and the prefix as keyword. `CUSTOM_RULE_IDS` (check-gitleaks-config), `RULE_ENTROPY` and the self-test's synthetic set carry them, so the `dir`, `git` and `artefact` self-tests plant both. `gitleaks-rules.test.ts` adds four positives (JSON body, form body, loopback callback URL, object literal) and five negatives (42 characters, a short value, a low-entropy placeholder, the bare prefixes as the code and docs use them). No `rly_rt_`/`rly_ac_` value exists in the tree or history.
- **`check-no-password`** in `repo:check` (`tooling/repo-scripts/src/check-no-password.ts`, AC-3):
  - Every committed `**/openapi/*.json`, and the control plane's must exist. It checks every path, parameter, header and property **name**, and every `enum`/`const` value, against TC-F-002-05's pattern. Prose (`description`, `summary`, `title`) is not read.
  - Client code in `packages/auth`, `apps/cli`, `apps/desktop` and `apps/web`, with tests and comment lines skipped: a password input, the password grant, a client secret, or a password, PIN or one-time-code prompt or field.
- **dependency-cruiser rule `no-dev-only-in-shipped`** (SEC-F002-13 a): `@ralysa/dev-stack`, `oidc-provider` or a relative path into `tooling/dev-stack/`, imported from anywhere outside `tooling/**` and `**/test/**`. `boundaries.js` gains `DEV_ONLY_IMPORT_ALLOWED_IN` and `DEV_ONLY_MESSAGE` beside `DEV_ONLY_PACKAGES`, which it documents as the list for all four layers.
- **`check-banned-deps` production-closure mode** (SEC-F002-13 b): from every `shipped: true` workspace, only production edges are followed: the importer's `dependencies` and `optionalDependencies`, then those of every package, through linked workspaces. The finding is `banned-deps/dev-only-in-shipped`, with a witness path. `npm:` aliases are resolved, and a shipped workspace missing from the lockfile fails closed.
- **`deploy/docker/control-plane.Dockerfile`** and **`/.dockerignore`** (SEC-F002-29):
  - Multi-stage, with `node:24.21.0-alpine` pinned by the same digest as the compose `mock-idp` service.
  - The build stage runs the pre-install gate before pnpm, then `pnpm install --frozen-lockfile --filter "@ralysa/control-plane..."`, the filtered build and `pnpm --filter @ralysa/control-plane deploy --prod /out`.
  - Third-party test folders are removed, then a module-graph smoke import runs (T14-6).
  - The runtime stage drops npm, corepack and yarn, copies `/out` owned by root, and runs as `USER 1000:1000`, with `ENTRYPOINT ["node", "dist/main.js"]` and `CMD ["serve", "--config", "/etc/ralysa/control-plane.yaml"]`.
  - There is no `ARG`, and no `ENV` other than `NODE_ENV` (plus the base image's `NODE_VERSION`, `YARN_VERSION` and `PATH`).
  - `.dockerignore` excludes `**/.env*`, `deploy/docker/dev/`, `.git`, `**/*.pem`, `**/*.key`, other key stores, `.npmrc`/`.netrc`, `.tools`, `.claude`, `node_modules`, build output, `docs`, `requirements` and `packs`.
  - `"files": ["dist"]` was added to `@ralysa/control-plane`, `@ralysa/auth` and `@ralysa/secrets`, and `["dist", "src/schema/generated"]` to `@ralysa/protocol` (its `./schema/*.json` export). This makes `pnpm deploy` copy no `src/` or `test/`: the tests name `@ralysa/dev-stack`.
  - The image is 275 MB on disk (65.7 MB compressed). Building it locally took about 45 s.
- **`secret-scan-cli.ts image`** (`src/secret-scan-image.ts`, SEC-F002-13 c, -29): see the README.
  - It builds (`--dockerfile`) or takes (`--image`) an image, `docker export`s the merged root filesystem, and scans all of it with the artefact config.
  - It scans the `docker image inspect` config and the `docker history --no-trunc` instructions the same way.
  - It fails on a root user, or on a secret-named `ENV` or build `ARG` (both BuildKit history forms).
  - It searches every `--exact-values` value byte for byte.
  - It fails if the dev stack or `oidc-provider` is present by path, is a production dependency in a `package.json`, or appears in a lockfile.
  - The positive control is a `package.json` in `WorkingDir`.
  - The container and the scan tag are removed afterwards.
- **`secret-scan-cli.ts dir <path>`**: one folder with the artefact config and the exact-value search. An empty folder is refused.
- **CI `integration` job**:
  - The hash-pinned gitleaks install moved before the tests.
  - A new step **"Image secret scan (AC-9)"** runs `secret-scan-cli.ts image --dockerfile deploy/docker/control-plane.Dockerfile --exact-values deploy/docker/dev/.env` after the tests (`if: !cancelled()`).
  - New invariant **`ci/integration-image-scan`**: the step must be there, uncommented, with that Dockerfile and that `.env`.
- **`services/control-plane/test/integration/scans.int.ts`** (TC-F-002-14, -20). One pino instance at `debug` captures everything two apps log while these run:
  - flow A (device code through `@ralysa/auth`, then the exchange over HTTP);
  - a refresh, then refresh-token reuse;
  - flow B (authorize, the mock IdP, the callback, the redemption), `/v1/me` and sign-out;
  - a second redemption of the same code;
  - a tampered bearer;
  - a flow-B callback with no binding cookie and the IdP's `code` and `state` in its URL;
  - an exchange whose Graph directory reads the IdP client secret from real OpenBao as the serve AppRole, at a path that role may not read (403);
  - a direct failed OpenBao read, logged through the same instance.

  The scans then run:
  - The log text is checked for JWT, `rly_rt_`/`rly_ac_`, query-string, fixture-email and OpenBao-token shapes, and for **every value the flows produced**: user code, Entra access token, access and refresh tokens, IdP code and state, PKCE verifier, `state` and authorization code. It must also hold no secret: the IdP client secret, the audit HMAC key, both AppRole secret ids, the Postgres password, the OpenBao root token and all six DB role passwords. `user_id`-like fields must be UUIDs, and no `email` or `display_name` field may appear. Then the log file goes through `secret-scan-cli.ts dir` with the ≥ 16-character values as exact values.
  - `pg_dump --data-only` of the test database (through `docker compose exec -T postgres`) goes through the same scan. Its positive control is `COPY cp.app_user`, `COPY audit.audit_event` and alice's oid in the dump.
  - `cp.credential`: a vault path is accepted, a secret-shaped value is refused by the CHECK (23514), and every row matches the path pattern.
  - `transit/keys/ralysa-rts-signing` and `ralysa-audit-checkpoint` report `exportable: false` and `allow_plaintext_backup: false`.
  - The tracked `deploy/**` files (`git ls-files`, so the committed configs) go through the same scan.
- READMEs: `tooling/repo-scripts` (the new check, the `image` and `dir` commands, the production-closure mode, the dependency-cruiser rule and the new invariant), `deploy/docker` (the Dockerfile and the scan command), and `docs/engineering/repo-conventions.md` (the `integration` job row and the invariant). No new environment variable or configuration.

### SEC-F002-13 and SEC-F002-29 status

| Item | Status | Where |
|---|---|---|
| SEC-F002-13 (a) dependency-cruiser rule | Done | `no-dev-only-in-shipped` in `.dependency-cruiser.cjs`; `check-imports.test.ts` TC-F-002-35 case |
| SEC-F002-13 (b) `oidc-provider` not in any shipped production closure | **Confirmed and extended.** T01's `check-workspaces` `deps/dev-only-in-shipped` enforces it over the workspace graph: it is in `repo:check`, and both `services/control-plane` and `packages/secrets` hold `@ralysa/dev-stack` as a devDependency only. T14 adds the lockfile closure, which also catches a third-party package that pulls `oidc-provider` in at any depth. | `check-banned-deps` production-closure mode; `check-banned-deps.test.ts` |
| SEC-F002-13 (c) image assertion; `pnpm deploy --prod` | Done | `secret-scan-cli.ts image`; the CI `integration` step; `secret-scan-image.test.ts` |
| SEC-F002-13 (d), (e) per-run keys; loopback control API with a per-run bearer | Done in T09 | `tooling/dev-stack/test/mock-idp.test.ts` ("refuses a request without the per-run bearer, or with another one") |
| SEC-F002-29 `.dockerignore`; multi-stage with `pnpm deploy --prod`; no secret in `ARG`/`ENV`; scan of the image config and history | Done | `/.dockerignore`, the Dockerfile, `checkImageConfig` plus the config and history gitleaks run |
| SEC-F002-29 `.env` generator hygiene; role passwords over stdin | Done in T02 and T05 | T02-2, T05-2 |

### Recorded decisions and deviations

Items marked **self-decided** were open questions decided under the standing authorization (CLAUDE.md), taking the recommended option.

| # | Type | What | Why |
|---|---|---|---|
| T14-1 | Implementation choice | The rule regexes are the design's, used as the secret group with no word boundary or terminator. `entropy = 3.5`. | A leading `\b` would miss a token glued to `_` or a letter (`token_rly_rt_…`). A real token (32 random bytes, base64url) measures about 5 bits per character with its prefix, while a placeholder such as `rly_rt_AAAA…` measures under 1.5. 3.5 is the floor of the other alphanumeric custom rules. |
| T14-2 | Scope (**self-decided**) | `check-no-password` reads every committed `**/openapi/*.json` and requires the control plane's. For client code it covers `packages/auth` and the three user-facing apps (`cli`, `desktop`, `web`). Tests and comment lines are skipped. OpenAPI prose is not read. | The design names `packages/auth` and "(later) `apps/cli`". Desktop and web sign users in too (F-005, F-007), so the rule is in place before their code lands. Tests must be able to assert that the password grant is refused, and prose may say that no password exists. TC-F-002-05's substring pattern stays on the whole document in `openapi.test.ts`. |
| T14-3 | Scope (**self-decided**) | No ESLint `no-restricted-imports` entry for the development-only packages; the import layer is dependency-cruiser alone. | The design's T14 row asks for a dependency-cruiser rule. dependency-cruiser already sees static imports, `require()`, literal `import()` and type-only imports in every workspace and in `packs/`, and it runs in `repo:check`. An ESLint copy would need per-workspace `test/**` exceptions, and it would add no coverage. `boundaries.js` still holds the lists, so an ESLint rule can be added from them later. |
| T14-4 | Implementation choice | The production closure starts only from `shipped: true` workspaces. Today that is `services/control-plane`; the libraries are `shipped: false` and are reached through it. | This matches SEC-F002-13 (b) ("the production closure of any `shipped: true` workspace"). An unshipped library that took `oidc-provider` as a dependency would still fail once a shipped workspace depends on it. |
| T14-5 | Addition (**self-decided**) | `"files"` fields on the four workspaces the image contains. | Without them, `pnpm deploy` copies each injected workspace whole (`src/`, `test/`, configs). Their tests name `@ralysa/dev-stack`, and an image scan that allowed that name inside test files would be weaker. `files` also keeps TypeScript sources and test fixtures out of the image. |
| T14-6 | Addition (**self-decided**) | The build stage deletes `test`, `tests` and `__tests__` folders and `*.test.*`/`*.spec.*` files inside third-party packages (`find … -mindepth 4`, under `node_modules/.pnpm`). It then imports `dist/serve.js` and `dist/app.js`, so the build fails if anything needed was removed. | The first image scan found **2 `jwt` findings in zod's published tests** (`zod/src/v4/mini/tests/string.test.ts`, sample JWTs). There were three other options. An allow-list is ruled out: the artefact config must never have one (T05-1). Scanning only `/app` would leave the rest of the image unscanned. Accepting the findings would make the scan useless. None of the 38 pruned folders is loaded at run time, and the import check proves that for the serve module graph. |
| T14-7 | Implementation choice | The `image` subcommand scans the **whole** exported root filesystem (the Alpine and Node base included), not only `/app`. `docker export` is used rather than walking the layer tarballs. | This is what a pod actually sees. A secret in a base layer would ship just the same. The export is the merged view, so a file deleted in a later layer is not reported: it is not in the running container. The history scan still sees every instruction. The base image scanned clean with the artefact config. |
| T14-8 | Implementation choice | "Development-only package in the image" means: a path under `node_modules/<name>` or `.pnpm/<name>@`, a `package.json` whose `name` or production fields name it, or any lockfile mention. `devDependencies` in a third-party manifest don't count. | `openid-client` and `oauth4webapi` list `oidc-provider` among their own devDependencies. That is not an install, and a plain text search flagged them. |
| T14-9 | Addition (**self-decided**) | A `dir` subcommand; exact values come from a mode-0600 `KEY=VALUE` file, never argv. Values shorter than 16 characters are refused. | The integration suite needs the same artefact config and exact-value logic for the DB dump, the logs and `deploy/**`, without a second implementation. Keeping values off argv keeps them out of the process list. A short value would give false positives. The one short value the flows produce, the device user code, is checked inside the test. |
| T14-10 | CI decision | The image is built and scanned **in the `integration` job**, after the tests, with `if: !cancelled()`. The gitleaks install moved before the tests. No new job. | Docker is on the hosted runner, and the job already has this run's generated `.env`, which provides the exact values the design's YAML names. Local timing: build about 45 s, scan about 6 s. CI pays the npm download that the local pnpm store hides, which is within the design's "about 2 min" budget. Every existing invariant still holds (no `secrets.*`, `contents: read`, the gate first, Postgres-only logs). `ci/integration-image-scan` keeps the step from being dropped. |
| T14-11 | Interpretation | TC-F-002-20 says "logs captured during TC-07 and TC-15". `scans.int.ts` drives its own representative flows (listed above), on the same pino options `serve` uses (`createPinoLogger`, §6.6), rather than collecting other files' logs. | Test files run in parallel in separate workers, so one file can't read another's logger. TC-07's paths (flow A, flow B, refused and reused codes) are all exercised here. **TC-15 (rotation) is T13's.** Once T13 lands, the rotation flow should log through the same capture, or `scans.int.ts` should run a rotation. This is in the open items. |
| T14-12 | Implementation choice | `pg_dump` runs inside the Postgres container (`docker compose … exec -T postgres pg_dump --data-only`), as the superuser, over the per-file test database. | No host `pg_dump` is needed, and its version matches the server. The positive control (the `COPY` blocks and alice's oid) stops an empty dump from passing. |
| T14-13 | Interpretation | The `deploy/**` scan covers **tracked** files only (`git ls-files deploy`). | The generated, git-ignored `deploy/docker/dev/.env` *is* the source of the exact values, so scanning it would always report. "Committed config" is exactly the tracked set. The test also asserts that no `.env` is tracked. |
| T14-14 | Known local effect | The control-plane `test:integration` suite now needs the hash-pinned gitleaks (`pnpm tools:install`), like the repo-scripts tests. | The scans run the same CLI as CI. Without the binary the scan exits 2, and the test fails with the CLI's install hint. It never passes silently. |

### Tests (T14)

- `tooling/repo-scripts`:
  - `gitleaks-rules.test.ts`: TC-F-001-39 extended with the two rules, in both configs.
  - `secret-scan-selftest.test.ts` and the `selftest` command plant both rules in the dir, git and artefact cases.
  - `secret-scan-entropy.test.ts`: `RULE_ENTROPY` matches the configs, and 2,000 generated sets clear every floor.
  - `check-gitleaks-config.test.ts`: the real configs pass, and the custom-rule sync covers the new ids.
  - `check-no-password.test.ts` (21), **TC-F-002-06** and the OpenAPI half of **TC-F-002-05**:
    - the real repository passes;
    - comments and tests are clean;
    - 10 client fixtures fail: a password input in TSX and JSX, an Ink or inquirer prompt, a readline prompt, a PIN field, an OTP field, a one-time code prompt, the password grant, a client secret, and a catalog string;
    - a missing OpenAPI document fails;
    - 6 OpenAPI fixtures fail: a property, a query parameter, a header, a grant-type enum value, `client_secret`, and a path.
  - `check-imports.test.ts`, **TC-F-002-35**: shipped code that imports `@ralysa/dev-stack/mock-idp`, `require('oidc-provider')`, a type from `oidc-provider`, or `import()` of `tooling/dev-stack/…` fails (4 findings). The same imports from `test/integration/**` and `tooling/dev-stack` pass.
  - `check-banned-deps.test.ts` (6 new), **TC-F-002-35**:
    - devDependency-only (the real layout) passes;
    - `@ralysa/dev-stack` as a production dependency fails (two findings: it and `oidc-provider`);
    - `oidc-provider` three levels down through a library workspace and an optional dependency fails, with the witness path;
    - an `npm:` alias fails;
    - an unshipped workspace is ignored, and a missing shipped importer fails closed;
    - the real lockfile is clean.
  - `secret-scan-image.test.ts` (24), **TC-F-002-14 and -35 image parts**. It uses a fake `docker` that serves a fixture root filesystem as a tar, and the real gitleaks:
    - exact values: parsing, and refusals of short, malformed and empty input; a value is found and only its key reported;
    - dev-only: 5 fixtures fail (the virtual store, hoisted, the linked dev stack, the dev stack in the virtual store, outside `/app`); third-party devDependencies pass; production fields and lockfiles fail; the positive control fails without an application;
    - config: 6 root-user forms fail; secret-named `ENV` and both `ARG` history forms fail;
    - `scanImage`: a clean image passes and the container is removed; a canary in the filesystem, a canary in `Env`, an exact value in a file and in the history, and `oidc-provider` are each found, and the value never appears in the result; a Dockerfile build and tag removal; a docker failure is a scanner error;
    - `scanDirectory`: gitleaks and exact-value findings; an empty folder is refused.
  - `check-ci-invariants.test.ts` (4 new): no step, no `--exact-values`, another Dockerfile, and the command commented out each fail `ci/integration-image-scan`.
- `services/control-plane` `test:integration` `scans.int.ts` (6), **TC-F-002-20** and **TC-F-002-14**, as listed above. It passed locally against the dev stack. A mutation check (logging the Postgres password once) made TC-F-002-20 fail with "POSTGRES_PASSWORD is in the log".
- The real image, locally: `secret-scan-cli.ts image --dockerfile deploy/docker/control-plane.Dockerfile --exact-values deploy/docker/dev/.env` reported 0 findings for the image checks, the filesystem and the config and history. Before T14-6 it reported the zod JWTs; before T14-8 it reported the third-party devDependencies.
- **TC-F-002-05**, the rest: `openapi.test.ts` (the substring pattern over the whole document), `app.test.ts` (metadata advertises `none` and `private_key_jwt` only, with no `password` grant) and `sessions.int.ts` (the token endpoint refuses `password`, unknown grants, client secrets and Basic auth) were already green from T07, T08 and T10.
- Full local run (Node 24.21.0): `pnpm lint`, `pnpm typecheck`, `pnpm test` (repo-scripts 28 files, 685 tests; control-plane 24 files, 369), `pnpm build` (23 tasks) and `pnpm repo:check` (including `check-no-password` and prettier) all pass. `turbo run test:integration` against the dev stack passes: control-plane 11 files, 161 tests; dev-stack 66; secrets 5.
