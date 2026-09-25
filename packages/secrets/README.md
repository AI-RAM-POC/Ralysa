# secrets

`@ralysa/secrets`: the `SecretStore` and `KeyCustody` ports, OpenBao KV v2 and Transit adapters
over `fetch`, and in-memory test doubles (F-002 design §3.7, §6.5). Isomorphic: no DOM and no
Node built-ins. Used by the control plane now and by model-gateway (F-004) next.

## Use

```ts
import { createOpenBao } from '@ralysa/secrets';

const { secrets, keys } = createOpenBao({
  addr: config.vault.addr,
  env: config.env, // the only source of the environment [SEC-F002-12]
  allowAppRole: config.vault.allow_approle,
  auth: { method: 'kubernetes', role: 'ralysa-cp-serve', jwt: readServiceAccountToken },
});
const { value, version } = await secrets.get('kv/ralysa/control-plane/idp-client-secret');
const stop = secrets.watch(path, onNewVersion, 60_000, onPollError);
const { latestVersion, versions } = await keys.describe('ralysa-rts-signing'); // public JWKs
const signature = await keys.sign('ralysa-rts-signing', latestVersion, signingInput); // r‖s
```

- **Auth.** `kubernetes` (the caller reads the ServiceAccount token file), `approle` (refused when
  `env=production` unless `allowAppRole`), `token` (refused unless `env` is `dev` or `test`).
  Login tokens are renewed at half their lease. After a 403, the adapter logs in again only when
  `auth/token/lookup-self` says the token itself is invalid, so a policy denial never consumes a
  single-use `secret_id`.
- **KV v2.** Paths name the mount first (`kv/…`); the entry's `value` field is the secret.
  `watch` polls and reports each new version, not the starting one.
- **Transit.** `describe` refuses a key with `exportable` or `allow_plaintext_backup` set
  (`CustodyViolationError`, SEC-F002-11) or of any type but `ecdsa-p256`, and returns every
  available version's public key as a JWK. `sign` passes `key_version` and
  `marshaling_algorithm=jws` and returns the 64-byte r‖s.
- **Errors** are `SecretsError` with a `code` (`config`, `unavailable`, `auth_failed`,
  `access_denied`, `not_found`, `invalid_response`, `custody_violation`, `unsupported_key`).
  Messages name the path, key and status only, never a token or value, so they are safe to log.
- **Doubles.** `createInMemorySecretStore(seed)` (`put`, `fail`) and `createInMemoryKeyCustody()`
  (`rotate`, `setFlags`, `setMinAvailableVersion`; WebCrypto keys with non-extractable private
  halves).

No environment variables or config of its own: the caller passes everything.

## Tests

`pnpm test` runs the hermetic unit tests (fake `fetch`, in-memory doubles). `pnpm test:integration`
runs `test/integration/*.int.ts` against the dev stack (`deploy/docker/dev`, see
`docs/engineering/repo-conventions.md`).
