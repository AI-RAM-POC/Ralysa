// A SigningKeys over the in-memory custody (no database), for hermetic app and mint tests.
import { kidFor } from '@ralysa/protocol/auth';
import { type InMemoryKeyCustody, createInMemoryKeyCustody } from '@ralysa/secrets';
import type { Jwk, SigningKeys } from '../../src/auth/tokens/signing-keys.js';
import { SigningUnavailableError } from '../../src/auth/tokens/signing-keys.js';

export async function fakeKeys(): Promise<{
  keys: SigningKeys;
  custody: InMemoryKeyCustody;
  state: { ready: boolean; violation: string | undefined };
}> {
  const custody = createInMemoryKeyCustody();
  await custody.rotate('ralysa-rts-signing');
  const state = { ready: true, violation: undefined as string | undefined };
  const keys: SigningKeys = {
    poll: () => Promise.resolve(),
    async sign(build) {
      if (state.violation !== undefined) throw new SigningUnavailableError('custody violation');
      const version = (await custody.describe('ralysa-rts-signing')).latestVersion;
      const kid = kidFor('ralysa-rts-signing', version);
      const input = build(kid);
      return { kid, input, signature: await custody.sign('ralysa-rts-signing', version, input) };
    },
    async jwks() {
      const described = await custody.describe('ralysa-rts-signing');
      return {
        keys: described.versions.map((v): Jwk => ({
          ...v.jwk,
          kid: kidFor('ralysa-rts-signing', v.version),
          alg: 'ES256',
          use: 'sig',
        })),
      };
    },
    status: () => ({
      ready: state.ready && state.violation === undefined,
      activeVersion: state.ready ? 1 : undefined,
      custodyViolation: state.violation,
    }),
  };
  return { keys, custody, state };
}
