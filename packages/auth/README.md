# auth

`@ralysa/auth`: the access-token verifier every Ralysa service uses (JWKS cache, revocation feed,
principal resolver, service-token source) and the isomorphic client sign-in flows the CLI wraps
(F-002 design §3.6). Isomorphic: no DOM and no Node built-ins (the `isomorphic` lint preset
enforces it). Every network call takes an optional `fetch` and a timeout.

There are **no environment variables and no config files**. Callers pass URLs and identifiers
explicitly, from their own validated config.

There is deliberately **no file-backed `TokenStore`**. F-005 implements the interface on the OS
credential store.

## Services (policy enforcement points)

```ts
const serviceTokens = createServiceTokenSource({
  tokenEndpoint: `${controlPlane}/oauth2/token`,
  assertionAudience: `${rtsPublicBaseUrl}/oauth2/token`, // when the two differ
  clientId: 'svc:model-gateway',
  signer: createTransitAssertionSigner({ custody, transitKey: 'ralysa-svc-model-gateway' }),
});
const feed = createRevocationFeed({ url: `${controlPlane}/v1/internal/governance`, serviceTokens });
await feed.start(); // polls every 5 s; call feed.stop() on shutdown
const verifier = createAccessTokenVerifier({
  issuer: rtsPublicBaseUrl,
  audience: 'model-gateway',
  jwksUrl: `${controlPlane}/.well-known/jwks.json`,
  kidPrefix: 'ralysa-rts-signing',
  revocation: feed,
  orgId, // from the service's config
  onReject: (r) => aggregator.record({ ...r, orgId }), // auth.token_rejected (T12)
});
const principals = createPrincipalResolver({ baseUrl: controlPlane, serviceTokens });
```

- `verify(bearer, { clientIp, traceId })` returns `{ ok: true, principal }` or
  `{ ok: false, reason }` with a `TokenRejectReason`. The checks and their order are in the header
  comment of `src/verify/access-token-verifier.ts`. They cover ES256 only, `typ: at+jwt`, no
  `jku`/`jwk`/`x5u`/`x5c`/`crit` [SEC-F002-19], a `kid` built from the configured signing key, an
  exact issuer, one string audience, the org, `exp`/`nbf` with 30 s skew, and no future `iat`
  [SEC-F002-18 e], followed by revocation.
- If the JWKS can't be fetched at all, `verify` throws `VerifierUnavailableError`. Answer 503, and
  don't record it as a token rejection.
- An error thrown by the `RevocationSource` (for example the control plane's database source)
  propagates from `verify` as-is. It is not turned into a rejection reason (T11-3). Treat it like
  `VerifierUnavailableError`: answer 503 and fail closed.
- `onReject` never receives the token. Aggregate rejections under the service's **configured**
  org, never the rejected token's `tid`.
- **G-1.** The feed counts a poll as a confirmation only if all of these hold:
  - the answer is authenticated and valid;
  - its `issued_at` is within 30 s of this process's clock;
  - its `epoch` is not lower than the last one seen [SEC-F002-18 a].

  With no confirmation for more than 60 s, every token is rejected with `governance_stale`.
- **Service tokens.** They are renewed at 50–60 % of their lifetime (jitter) while the current
  token stays in use until it expires [AR-1]. A token is not handed out in its **last 5 s**, so it
  can't expire on the way to the control plane. A failed renewal is retried with a backoff of 1 s,
  doubling up to 30 s, and the backoff holds after expiry too: during an outage `getToken()`
  throws `ServiceTokenUnavailableError` without calling OpenBao or RTS again until the backoff
  ends. The PEP then fails closed. OpenBao is therefore in the control-plane HA tier.
- **Principals.** They are cached for 30 s. A 404 is `PrincipalNotFoundError`. Any other failure
  throws.

## Clients (CLI in F-005)

- Flow A: `fetchAuthConfig(issuer)`, then `startIdpDeviceSignIn(cfg)`. Show `userCode` and
  `verificationUri`, call `poll()`, then `exchangeIdpToken(cfg, idpAccessToken)`, then drop the
  IdP token.
  - `poll()` reports every IdP-side failure to `/v1/auth/sign-in-failures` **before** it throws
    (AC-4).
  - Pass `classifyIdpError` to map Entra `AADSTS` codes (for example 53003, a Conditional Access
    block, to `conditional_access_blocked`, which throws `DeviceCodeBlockedError` so the CLI can
    suggest `/login --browser`). The table lives in the CLI [AR-18].
- Flow B: `createPkcePair()` and `createState()`, then `buildAuthorizeUrl(cfg, …)`. Next,
  `readAuthorizationCallback(query, state)` on the loopback request (127.0.0.1 only), then
  `redeemAuthorizationCode(cfg, …)`.
- `createTokenManager({ cfg, store })` keeps the session: `signedIn(tokens)`,
  `getAccessToken(audience)`, `signOut()`.
- Errors are typed (`AccessDeniedError`, `DeviceCodeExpiredError`, `DeviceCodeBlockedError`,
  `SessionRevokedError`, `TemporarilyUnavailableError` and its subclass `ResponseLostError`,
  `AuthProtocolError`). `TemporarilyUnavailableError` means the server answered that it can't
  serve now, so a retry is safe. `ResponseLostError` (`lostResponse: true`) means no answer
  arrived, so the request may have been processed; see the contract below. Each carries an
  `i18nKey` from the protocol's `AUTH_I18N_KEYS`. A key RTS sends is used only when it is one of
  those.

## Contract for integrators: one refresher per device (SEC-F002-17)

Exactly one process per device refreshes a user's session, through one `TokenManager`: the CLI
(F-005) or the Desktop main process. Every other local consumer, the Agent Host (F-003) included,
asks that process for access tokens through the `TokenProvider` over IPC and never reads the
refresh token.

RTS treats a second refresher as refresh-token reuse. The losing request gets `invalid_grant` with
`ralysa_error.code = reuse_detected`, and the whole session is revoked.

Within one `TokenManager`, refreshes are single flight:

- concurrent callers for one audience share one request;
- a refresh for another audience waits for the one in flight, so a rotated token is never
  presented again.

On `invalid_grant` the manager clears the store and throws `SessionRevokedError`. On
`temporarily_unavailable`, 429 or 5xx it keeps the refresh token and throws
`TemporarilyUnavailableError`; a retry is safe.

When no answer arrives, it throws `ResponseLostError`. A retry after a **lost** answer presents a
token RTS may already have rotated. That is reuse: the session is revoked, the retry throws
`SessionRevokedError`, and the user signs in again.

**For F-005's `TokenStore`.** If `store.save()` fails after a successful rotation, the manager
keeps the new refresh token in memory and rethrows the store error. This process keeps working,
but the credential store still holds the **rotated** token. The next process start presents it,
RTS sees reuse and revokes the session. The CLI should tell the user the sign-in couldn't be
saved, and at exit it should either retry the save or sign out. The full rules are in the control-plane README,
under Sessions and grants.
