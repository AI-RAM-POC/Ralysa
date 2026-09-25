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

  it('TC-F-002-17: /v1/audit has POST ingestion and GET query only, no PUT, PATCH or DELETE (AC-11)', async () => {
    const doc = JSON.parse(committed) as { paths: Record<string, Record<string, unknown>> };
    const audit = Object.entries(doc.paths).filter(([path]) => path.startsWith('/v1/audit'));
    expect(Object.fromEntries(audit.map(([path, ops]) => [path, Object.keys(ops).sort()]))).toEqual(
      {
        '/v1/audit/client-events': ['post'],
        '/v1/audit/events': ['get', 'post'],
      },
    );
    const app = await buildApp({
      config: serveConfig(),
      keys: (await fakeKeys()).keys,
      rts: fakeRts(),
      pingDatabase: () => Promise.resolve(true),
    });
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/v1/audit/events', '/v1/audit/client-events']) {
        expect(app.hasRoute({ method, url })).toBe(false);
      }
    }
  });

  it('no path, parameter or schema property is a password, PIN, OTP or client secret (AC-3)', () => {
    // TC-F-002-05's substring pattern, over the whole document.
    expect(committed).not.toMatch(/pass(word|wd|phrase)|\bpin\b|otp|client_secret/i);
  });
});
