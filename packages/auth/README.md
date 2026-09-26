# auth

`@ralysa/auth`: the access-token verifier every Ralysa service uses (JWKS cache, revocation feed,
principal resolver, service-token source, rejection reporter) and the isomorphic client sign-in
flows the CLI wraps (F-002 design §3.6).

- **Isomorphic.** No DOM and no Node built-ins (the `isomorphic` lint preset enforces it). It runs
  in Node 24, browsers and workers.
- **One entry point.** Everything below is imported from `@ralysa/auth`. Wire types (claims,
  `Audience`, `Principal`, `AuthConfig`, reason codes) come from `@ralysa/protocol`.
- **No environment variables and no config files.** Callers pass URLs and identifiers explicitly,
  from their own validated config.
- **Every network call** takes an optional `fetch` and `timeoutMs` (default 10 s; JWKS 5 s), follows no
  redirects, and validates the answer with the protocol's zod contract.
- **No file-backed `TokenStore`.** F-005 implements the interface on the OS credential store.

Who uses what:

| Integrator | Uses |
| --- | --- |
| F-003 Agent Host (server side), F-004 model gateway, any service that accepts user tokens | [Services](#services-policy-enforcement-points): verifier, revocation feed, principal resolver, service-token source, Transit assertion signer, rejection reporter |
| F-005 CLI (and later Desktop main process) | [Clients](#clients): flows A and B, the token manager, sign-out |
| F-003 local Agent Host | Neither directly: it gets access tokens from the one refresher over IPC ([contract](#contract-one-refresher-per-device-sec-f002-17)) |
| The control plane | `createAccessTokenVerifier` and `createServiceTokenVerifier` over its own key set and a database `RevocationSource` |

The control plane's side of all of this (routes, grants, rate limits, the governance feed, the
audit paths) is in the [control-plane README](../../services/control-plane/README.md).

## Services (policy enforcement points)

A service needs four things from its own config: the control plane's base URL (possibly an
internal address), RTS's `public_base_url` (the token issuer), the org id, and its service name.
It must be registered in the control plane's `services[]` (client id `svc:<name>`, Transit key
`ralysa-svc-<name>`, and `auth.token_rejected` in its `audit_actions` if it reports rejections).

### Wiring

```ts
import {
  createAccessTokenVerifier,
  createPrincipalResolver,
  createRejectionReporter,
  createRevocationFeed,
  createServiceTokenSource,
  createTransitAssertionSigner,
} from '@ralysa/auth';
import { createOpenBao } from '@ralysa/secrets';

// The service's own OpenBao login (its role may only sign with ralysa-svc-<name>).
const { keys: custody } = createOpenBao({ addr: vaultAddr, auth: vaultAuth, env });

const serviceTokens = createServiceTokenSource({
  tokenEndpoint: `${controlPlane}/oauth2/token`, // may be an internal address
  assertionAudience: `${rtsPublicBaseUrl}/oauth2/token`, // RTS's own name for it, when they differ
  clientId: 'svc:model-gateway',
  signer: createTransitAssertionSigner({ custody, transitKey: 'ralysa-svc-model-gateway' }),
});

const feed = createRevocationFeed({ url: `${controlPlane}/v1/internal/governance`, serviceTokens });
await feed.start(); // first poll, then every 5 s; feed.stop() on shutdown

const rejections = createRejectionReporter({
  url: `${controlPlane}/v1/audit/events`,
  serviceTokens,
  audience: 'model-gateway',
  onError: (error) => log.warn('token_rejected_report_failed', { error: error.message }),
});
rejections.start(); // sends every second; on shutdown: rejections.stop(), then await rejections.flush()

const verifier = createAccessTokenVerifier({
  issuer: rtsPublicBaseUrl, // exact match, no trailing slash needed
  audience: 'model-gateway', // exactly one Audience
  jwksUrl: `${controlPlane}/.well-known/jwks.json`,
  kidPrefix: 'ralysa-rts-signing', // the control plane's signing_key
  revocation: feed,
  orgId, // from the service's config
  onReject: (r) => rejections.record(r), // never blocks, never sees the token
});

const principals = createPrincipalResolver({ baseUrl: controlPlane, serviceTokens });
```

### Per request

```ts
import {
  PrincipalNotFoundError,
  PrincipalSessionRefusedError,
  VerifierUnavailableError,
} from '@ralysa/auth';

try {
  const result = await verifier.verify(request.headers.authorization ?? '', {
    clientIp, // your trusted-proxy-aware client address
    traceId,
  });
  if (!result.ok) return reply401(result.reason); // a TokenRejectReason, already reported
  // Always pass the token's sid: the answer then carries that session's roles.
  const principal = await principals.resolve(result.principal.userId, result.principal.sessionId);
  if (principal.status !== 'active') return reply403();
  // Authorize on principal.session_roles: the roles this session holds now (its sign-in roles ∩
  // current memberships). principal.roles are directory roles and are never enough on their own
  // for platform_admin (an admin who signed in by device code has no admin session role).
  if (!principal.session_roles.includes('user')) return reply403();
} catch (error) {
  if (error instanceof PrincipalNotFoundError) return reply403();
  if (error instanceof PrincipalSessionRefusedError) return reply401('session_revoked');
  if (error instanceof VerifierUnavailableError) return reply503(); // fail closed, not a rejection
  throw error; // a RevocationSource fault, a ServiceTokenUnavailableError, …: 503, fail closed
}
```

### Verifier and JWKS cache

`verify(bearer, { clientIp, traceId })` accepts the token with or without `Bearer ` (any case) and
returns `{ ok: true, principal }` or `{ ok: false, reason }`. `principal` is a `VerifiedPrincipal`:
`userId`, `orgId`, `sessionId`, `idpSubject`, `audience`, `surface`, `expiresAt`, and `tokenId`
(the `jti`, for audit correlation). The checks, in order, each with its reason code, are in the
header comment of `src/verify/access-token-verifier.ts`:

1. shape (`malformed`);
2. header: ES256 only, `typ: at+jwt`, no `jku`/`jwk`/`x5u`/`x5c`/`crit` (SEC-F002-19), `kid`
   `<kidPrefix>.v<n>`;
3. the signature against RTS's JWKS;
4. claims: exact issuer, exactly one string audience, the org when `orgId` is set, `exp`/`nbf` with
   30 s skew (`clockSkewSeconds`), no future `iat` (SEC-F002-18 e), `token_use: access` and the
   protocol claim contract;
5. revocation: `governance_stale`, `user_revoked`, `session_revoked`.

**JWKS cache** (`createJwksCache`, used by default): at most `JWKS_CACHE_MAX_AGE_MS` (60 s) old,
re-fetched on an unknown `kid` at most every `JWKS_COOLDOWN_MS` (5 s), 5 s fetch timeout. RTS
publishes a new key 120 s before it signs with it, so every verifier holds it in time. Pass
`keySet` instead to verify against a key set you already hold (tests; the control plane).

**Failure modes:**

- The JWKS can't be fetched at all: `verify` throws `VerifierUnavailableError` (the fault is in
  `cause`; scrub it before logging). Answer 503, and it is not recorded as a rejection.
- An error thrown by the `RevocationSource` propagates as-is (T11-3). Treat it like
  `VerifierUnavailableError`: 503, fail closed.
- `onReject` receives `{ reason, clientIp, traceId }`, never the token. An exception it throws is
  swallowed and doesn't change the answer. Rejections are aggregated under the service's
  **configured** org, never the rejected token's `tid`.

**Service tokens at the control plane.** `createServiceTokenVerifier({ issuer, jwksUrl, kidPrefix,
orgId, isRegistered })` applies steps 1–4 to `token_use: service` tokens (`aud: control-plane`,
`sub` = `client_id` = `svc:<name>`) and refuses an unregistered client as `wrong_token_use`. Only
the control plane accepts service tokens; no other service should create one.

### Revocation feed (G-1)

`createRevocationFeed({ url, serviceTokens })` polls `GET /v1/internal/governance` every 5 s
(`pollMs`) with the service's token and keeps revoked sessions, per-user `revoked_before`, and the
kill-switch state. It is the verifier's `RevocationSource`.

- A poll is a **confirmation** only if the answer is authenticated and valid, its `issued_at` is
  within 30 s of this process's clock (`maxIssuedAtSkewMs`), and its `epoch` is not lower than the
  last one seen (SEC-F002-18 a). Revocations from any valid answer are merged (adding one is always
  safe).
- With no confirmation for more than 60 s (`staleAfterMs`), `check()` answers `governance_stale`
  and every token is rejected until the feed is back.
- `start()` resolves after the first poll with its `PollOutcome` (`confirmed`, `stale_response`,
  `epoch_regressed`, `invalid_response`, `unauthorized`, `unavailable`). Until a poll confirms,
  every token is `governance_stale`, so check the outcome or wait for readiness before serving.
- `status()` gives `confirmedAt`, `epoch` and `stale` (for `/readyz`); `onPoll` sees every outcome
  (for metrics). `killSwitches()` returns the last confirmed kill-switch state; F-002 only carries
  it, and enforcement belongs to the PEP (F-012).

### Principal resolver

Groups and roles are not in the token. `createPrincipalResolver({ baseUrl, serviceTokens })`
returns a resolver whose `resolve(userId, sessionId)` calls
`GET /v1/internal/principals/{user_id}?sid={sessionId}` and returns the protocol `Principal`
(`user_id`, `org_id`, `status`, `roles`, `groups`, `as_of`) plus `session_id` and
`session_roles` (design §3.4.2 and §6.1, revision 10; #47, SEC-F002-42).

**Which roles to authorize on.** PEPs **must** use `session_roles` for any privileged decision,
and for every other authorization decision; `roles` never authorize anything on their own:

| Field | What it is | Use it for |
|---|---|---|
| `session_roles` | The roles of the session behind the token: decided at sign-in by the strong-flow rule, narrowed at every refresh, and intersected with the user's current memberships of the configured groups at request time | Every authorization decision, and the only basis for `platform_admin` |
| `roles` | Directory roles: what the user's current memberships of the configured groups would allow. The same for all of the user's sessions | Display and diagnostics only. Never enough on their own for `platform_admin`: an admin who signed in by device code has `platform_admin` here but not in `session_roles` |

"Current memberships" means what Microsoft Graph last confirmed for the two configured groups, at
the user's last sign-in or refresh (RTS writes Graph's answer back at both). A removal from a
group therefore reaches `Principal` at the user's next refresh, and a client holding an access
token refreshes at least every access-token TTL (15 min). The cache below adds up to 30 s.
`resolve(userId)` without a session id is **deprecated** (SEC-F002-54): it returns no
`session_roles`, and `@typescript-eslint/no-deprecated` (on in `@ralysa/eslint-config`) flags every
call. It stays only for diagnostics where no user session is involved, and no PEP may authorize on
its answer.

- Cached for 30 s (`ttlMs`) per (user, session), at most 10,000 entries (`maxEntries`); one
  session's answer never serves another. Concurrent lookups for one key share one request.
- A 404 or a non-UUID user id is `PrincipalNotFoundError`. A session the control plane refuses
  (unknown, another user's, revoked, pending or past its absolute expiry: 403) or a non-UUID
  session id is `PrincipalSessionRefusedError`; answer 401. Anything else (unreachable, another
  status, an answer for another user or session, or one without `session_roles` when a session
  id was given) is `PrincipalUnavailableError`: fail closed.

### Service-token source and renewal

`createServiceTokenSource({ tokenEndpoint, assertionAudience, clientId, signer })` returns a source
whose `getToken()` resolves to a valid service token (`aud: control-plane`, `token_use: service`,
5 minutes by default). The feed, the principal resolver and the rejection reporter share one.

- **Renewal** starts at 50–60 % of the token's lifetime (random jitter so replicas don't renew in
  lockstep), in the background: callers keep getting the current token until it expires (AR-1).
- A token is not handed out in its **last 5 s**, so it can't expire on the way.
- A failed renewal is retried with a backoff of 1 s, doubling up to 30 s. The backoff holds after
  expiry too: during an outage `getToken()` throws `ServiceTokenUnavailableError` without calling
  OpenBao or RTS again until the backoff ends. Every caller then fails closed, which is why OpenBao
  is in the control-plane HA tier.
- `settled()` resolves when no renewal is in flight (tests, graceful shutdown).
- `clientId` must be `svc:<name>`; the constructor throws otherwise.

### Transit assertion signer

`createTransitAssertionSigner({ custody, transitKey })` signs the RFC 7523 client assertion through
the service's own non-exportable Transit key `ralysa-svc-<name>`; no static service secret exists.
`custody` is anything with `describe(key)` and `sign(key, version, input)`: `createOpenBao(...).keys`
from `@ralysa/secrets` in a service, or its in-memory double in tests.

- It signs with the key's latest version, and the header's `kid` is `<transitKey>.v<version>` of
  that same version.
- `describe` refuses a key that is `exportable` or allows plaintext backup, so a custody violation
  stops assertions (SEC-F002-11).
- Each assertion (`createClientAssertion`) has `iss` = `sub` = `clientId`, `aud` = the assertion
  audience, a fresh `jti`, and lives `ASSERTION_LIFETIME_S` (50 s; RTS allows at most 60 s).
- The service's OpenBao role may only call `transit/sign/ralysa-svc-<name>`.

### Rejection reporter

`createRejectionReporter({ url, serviceTokens, audience })` turns the verifier's rejections into
`auth.token_rejected` reports on `POST /v1/audit/events` (SEC-F002-16).

- `record` queues a rejection and never throws or waits.
- Every second (`flushMs`) the queue goes out in batches of up to 100 (`batchSize`) with the
  service's token; the control plane aggregates them per client /24 or /64, reason and audience,
  and stores them under the service's source and org.
- The queue holds 1,000 (`maxQueue`); what doesn't fit is counted per reason and sent as a
  `dropped_count` report.
- A batch the control plane couldn't take (no answer, 401, 429, 5xx, no service token) is resent
  with the same event ids (a repeat is answered `duplicate`). One it refuses (400, 403, 413, 422)
  is dropped and reported through `onError`. A 403 usually means the service isn't allow-listed for
  `auth.token_rejected`.
- `status()` gives `queued` and `dropped`.

## Clients

For the CLI (F-005) now, Desktop and Web later. Every function takes `ClientOptions`
(`fetch`, `timeoutMs`) last. Start from the discovery document:

```ts
import { fetchAuthConfig } from '@ralysa/auth';

const cfg = await fetchAuthConfig(issuer); // GET /v1/auth/config; its issuer must equal `issuer`
```

`cfg.flows.idp_device` says whether flow A is enabled for the tenant; flow B (`loopback_pkce`)
always is.

### Flow A: device code at the IdP, then token exchange

```ts
import { exchangeIdpToken, startIdpDeviceSignIn } from '@ralysa/auth';

const signIn = await startIdpDeviceSignIn(cfg, { classifyIdpError, deviceLabel });
show(signIn.userCode, signIn.verificationUri); // expires after signIn.expiresInSeconds
const { idpAccessToken } = await signIn.poll(abortSignal);
const tokens = await exchangeIdpToken(cfg, idpAccessToken, { deviceLabel });
await manager.signedIn(tokens); // then drop idpAccessToken; it is never stored
```

- `startIdpDeviceSignIn` throws `AccessDeniedError` (`auth.denied.device_code_disabled`) when the
  tenant switched flow A off.
- `poll()` honours the IdP's interval and `slow_down`, backs off on network faults, and reports
  every IdP-side failure to `/v1/auth/sign-in-failures` **before** it throws (AC-4). A user cancel
  through the `AbortSignal` is not reported. Call it once per sign-in.
- Pass `classifyIdpError` to map vendor codes (Entra `AADSTS…`); for example 53003, a Conditional
  Access block, to `conditional_access_blocked`, which throws `DeviceCodeBlockedError` so the CLI
  can suggest `/login --browser`. The table lives in the CLI (AR-18); without it only the RFC 8628
  codes are known.
- RTS burns the IdP token on first presentation, whatever the outcome: a failed exchange means
  starting the device flow again.

### Flow B: system browser, loopback redirect, PKCE

```ts
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  readAuthorizationCallback,
  redeemAuthorizationCode,
} from '@ralysa/auth';

const { verifier, challenge } = await createPkcePair();
const state = createState();
const redirectUri = `http://127.0.0.1:${port}/callback`; // the CLI's listener, 127.0.0.1 only
openBrowser(buildAuthorizeUrl(cfg, { redirectUri, challenge, state }).href);
// …on the loopback request:
const code = readAuthorizationCallback(queryParams, state);
const tokens = await redeemAuthorizationCode(cfg, { code, redirectUri, verifier });
await manager.signedIn(tokens);
```

- `buildAuthorizeUrl` refuses parameters RTS would refuse (it validates against the protocol's
  `AuthorizeQuery`).
- `readAuthorizationCallback` compares `state` without an early exit, throws `AuthProtocolError`
  on a mismatch (a forged or stale callback), and `AccessDeniedError` for a refusal (with the
  reason's i18n key when RTS names a known one).
- Redeem from the same host that received the callback: RTS denies a redemption from another IP
  by default (`access.loopback_ip_mismatch: deny`).

### Token manager (single flight)

```ts
import { createTokenManager } from '@ralysa/auth';

const manager = createTokenManager({ cfg, store }); // store: F-005's OS credential store
const accessToken = await manager.getAccessToken(); // 'control-plane' by default
const gatewayToken = await manager.getAccessToken('model-gateway');
await manager.signOut(); // revokes the session at RTS, then clears the store
```

- `signedIn(tokens)` takes over a fresh sign-in and saves its refresh token.
- `getAccessToken(audience)` returns a cached token, or refreshes 60 s before expiry (at most half
  the token's life for short lifetimes). Access tokens live in memory only.
- `hasSession()` is true while a refresh token is stored; the next refresh may still refuse it.
- `signOut()` calls `POST /oauth2/revoke` (RFC 7009) and then forgets the session. If RTS can't be
  reached it keeps the local state and throws, unless `{ localOnly: true }`. `revokeSession(cfg,
  refreshToken)` is the same call without a manager.
- `TokenStore` is `load()`, `save(refreshToken)` and `clear()`; implement it on the OS credential
  store only.

### Errors

Every client error extends `AuthError` and carries `code`, `i18nKey` (always one of the protocol's
`AUTH_I18N_KEYS`; a key RTS sends is used only when it is one of them) and `reason` (the RTS
`ralysa_error.code` or the reported IdP failure). Turn `i18nKey` into en/ar text in the CLI's
catalog; never show a server string directly.

| Error | `code` | Meaning | What to do |
| --- | --- | --- | --- |
| `AccessDeniedError` | `access_denied` | The IdP or RTS refused the sign-in (not in the access group, disabled, admin needs the browser flow, …) | Show the message for `i18nKey` |
| `DeviceCodeExpiredError` | `device_code_expired` | The device code expired | Start flow A again |
| `DeviceCodeBlockedError` | `device_code_blocked` | Conditional Access blocks device code | Suggest `/login --browser` |
| `SessionRevokedError` | `session_revoked` | Signed out, reuse detected, user disabled | Sign in again (the store is already cleared) |
| `TemporarilyUnavailableError` | `temporarily_unavailable` | The server **answered** that it can't serve now (`temporarily_unavailable`, 429, 5xx); nothing was consumed | Retry later |
| `ResponseLostError` (subclass, `lostResponse: true`) | `temporarily_unavailable` | **No answer** arrived; the request may have been processed | See the contract below; don't retry a sign-in grant blindly |
| `AuthProtocolError` | `protocol_error` | An answer the client can't use | Report; don't retry |

## Contract: one refresher per device (SEC-F002-17)

This is a contract on F-003 and F-005.

**Exactly one process per device refreshes a user's session, through one `TokenManager`**: the CLI
(F-005) or the Desktop main process. Every other local consumer, the Agent Host (F-003) included,
asks that process for access tokens over IPC (the `TokenProvider` of the identity-and-policy
architecture, §4.3; this package doesn't define it) and never reads the refresh token.

- RTS rotates the refresh token on every use and treats a second presentation of a rotated token as
  **reuse**: the losing request gets `invalid_grant` with `ralysa_error.code = reuse_detected`, and
  the whole session is revoked. So a second refresher on the device, or a second `TokenManager`
  over the same store, signs the user out. There is no grace window (D-27).
- Within one `TokenManager`, refreshes are single flight: concurrent callers for one audience share
  one request, and a refresh for another audience waits for the one in flight, so a rotated token
  is never presented again. Sign-in and sign-out are serialised with them.
- On `invalid_grant` the manager clears the store and throws `SessionRevokedError`.
- On `temporarily_unavailable`, 429 or 5xx it keeps the refresh token and throws
  `TemporarilyUnavailableError`; a retry is safe.
- When no answer arrives it throws `ResponseLostError` and keeps the old token. A retry presents a
  token RTS may already have rotated: that is reuse, the session is revoked, the retry throws
  `SessionRevokedError`, and the user signs in again. Treat a lost refresh answer as a likely
  sign-out.

**For F-005's `TokenStore`.** If `store.save()` fails after a successful rotation, the manager keeps
the new refresh token in memory and rethrows the store error. This process keeps working, but the
credential store still holds the **rotated** token, so the next process start presents it, RTS sees
reuse and revokes the session. The CLI should tell the user the sign-in couldn't be saved, and at
exit it should either retry the save or sign out. The server-side rules are in the control-plane
README, under "Sessions and grants".
