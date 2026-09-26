// The flow-B relying party's secret reads are inside its 3 s bound (review of #35): a KV read that
// hangs ends the redemption as `unavailable` after OIDC_TIMEOUT_S, before any IdP call. Fake
// timers only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OIDC_TIMEOUT_S, createOidcClient } from '../src/auth/idp/oidc-client.js';
import type { IdpClientSecret } from '../src/secrets/runtime.js';
import { serveConfig } from './fixtures/serve-config.js';

const hanging: IdpClientSecret = {
  current: () => new Promise(() => undefined),
  refreshAfterInvalidClient: () => new Promise(() => undefined),
  start: () => () => undefined,
  version: () => undefined,
};

describe('OIDC client secret reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a secret read that never answers ends the redemption as unavailable at the 3 s bound', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const oidc = createOidcClient({ config: serveConfig({ env: 'test' }), clientSecret: hanging });
    let settled: unknown;
    void oidc
      .redeem(new URL('https://ralysa.example.qa/oauth2/idp/callback?code=x&state=s'), {
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'.repeat(43),
      })
      .then((result) => (settled = result));
    await vi.advanceTimersByTimeAsync(OIDC_TIMEOUT_S * 1000 - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ kind: 'unavailable', reason: 'client_secret' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
