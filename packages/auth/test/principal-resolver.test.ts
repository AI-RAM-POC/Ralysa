// PrincipalResolver (§3.4.2, §5.5; AC-7 "yields groups"): service token, 30 s cache, one request
// per user in flight, fail closed.
import { describe, expect, it } from 'vitest';
import {
  PrincipalNotFoundError,
  PrincipalUnavailableError,
  createPrincipalResolver,
} from '../src/index.js';
import { ORG, USER, clock, fakeFetch } from './support.js';

const BASE = 'https://cp.internal';
const URL_USER = `${BASE}/v1/internal/principals/${USER}`;
const principal = {
  user_id: USER,
  org_id: ORG,
  status: 'active',
  roles: ['user'],
  groups: [{ idp_group_id: '4f1c2e3d-0000-4000-8000-0000000000d1', role: 'access' }],
  as_of: '2026-09-25T10:00:00.000Z',
};

describe('createPrincipalResolver', () => {
  const setup = (reply: () => { status: number; body?: unknown }) => {
    const c = clock();
    const fetch = fakeFetch({ [`GET ${URL_USER}`]: reply });
    const resolver = createPrincipalResolver({
      baseUrl: BASE,
      serviceTokens: { getToken: () => Promise.resolve('svc') },
      fetch,
      now: c.now,
    });
    return { c, fetch, resolver };
  };

  it('returns groups and roles with the service token, cached for 30 s, one request in flight', async () => {
    const { c, fetch, resolver } = setup(() => ({ status: 200, body: principal }));
    const [a, b] = await Promise.all([resolver.resolve(USER), resolver.resolve(USER)]);
    expect(a).toEqual(principal);
    expect(b).toEqual(principal);
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]?.headers.authorization).toBe('Bearer svc');
    c.advance(30_000);
    await resolver.resolve(USER);
    expect(fetch.requests).toHaveLength(1);
    c.advance(1);
    await resolver.resolve(USER);
    expect(fetch.requests).toHaveLength(2);
  });

  it('404 → PrincipalNotFoundError; a non-UUID id is never sent', async () => {
    const { fetch, resolver } = setup(() => ({ status: 404, body: {} }));
    await expect(resolver.resolve(USER)).rejects.toBeInstanceOf(PrincipalNotFoundError);
    await expect(resolver.resolve('../../v1/me')).rejects.toBeInstanceOf(PrincipalNotFoundError);
    expect(fetch.requests).toHaveLength(1);
  });

  it('fails closed on errors, bad bodies and an answer for another user', async () => {
    for (const reply of [
      { status: 503, body: {} },
      { status: 200, body: { ...principal, roles: ['root'] } },
      { status: 200, body: { ...principal, user_id: ORG } },
    ]) {
      const { resolver } = setup(() => reply);
      await expect(resolver.resolve(USER)).rejects.toBeInstanceOf(PrincipalUnavailableError);
    }
  });
});
