// The OpenAPI document (§3.10): the committed file equals the generator output; every contract
// is a registered route; no route takes a password or client secret (AC-3, TC-F-002-05 part).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ROUTES } from '../src/http/contracts.js';
import { openApiText } from '../src/http/openapi.js';
import { fakeRts } from './fixtures/fake-rts.js';
import { fakeKeys } from './fixtures/fake-keys.js';
import { serveConfig } from './fixtures/serve-config.js';

const committed = readFileSync(
  new URL('../openapi/control-plane.v1.json', import.meta.url),
  'utf8',
);

describe('OpenAPI document', () => {
  it('the committed file equals the generator output (run check:generated after a change)', () => {
    expect(committed).toBe(openApiText());
  });

  it('every route contract is registered by the app', async () => {
    const app = await buildApp({
      config: serveConfig(),
      keys: (await fakeKeys()).keys,
      rts: fakeRts(),
      pingDatabase: () => Promise.resolve(true),
    });
    for (const route of Object.values(ROUTES)) {
      expect({
        route: route.url,
        registered: app.hasRoute({ method: route.method, url: route.url }),
      }).toEqual({
        route: route.url,
        registered: true,
      });
    }
  });

  it('no path, parameter or schema property is a password, PIN, OTP or client secret (AC-3)', () => {
    // TC-F-002-05's substring pattern, over the whole document.
    expect(committed).not.toMatch(/pass(word|wd|phrase)|\bpin\b|otp|client_secret/i);
  });
});
