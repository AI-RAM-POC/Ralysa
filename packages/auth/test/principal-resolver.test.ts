// PrincipalResolver (§3.4.2, §5.5; AC-7 "yields groups"): service token, 30 s cache, one request
// per user in flight, fail closed.
//
// The one-argument resolve(userId) is deprecated for PEPs (SEC-F002-54). These tests still cover
// it on purpose, through `plain()`, the one place that names the deprecated overload.
import { describe, expect, it } from 'vitest';
import {
  PrincipalNotFoundError,
  PrincipalSessionRefusedError,
  type PrincipalResolver,
  PrincipalUnavailableError,
  createPrincipalResolver,
} from '../src/index.js';
import type { Principal } from '@ralysa/protocol/control-plane';
import { ORG, USER, clock, fakeFetch } from './support.js';

/** The deprecated one-argument lookup, called on purpose (no `?sid=`). */
type PlainLookup = (userId: string) => Promise<Principal>;
const plain = (resolver: PrincipalResolver, userId: string): Promise<Principal> =>
  (Reflect.get(resolver, 'resolve') as PlainLookup).call(resolver, userId);

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
    const [a, b] = await Promise.all([plain(resolver, USER), plain(resolver, USER)]);
    expect(a).toEqual(principal);
    expect(b).toEqual(principal);
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]?.headers.authorization).toBe('Bearer svc');
    c.advance(30_000);
    await plain(resolver, USER);
    expect(fetch.requests).toHaveLength(1);
    c.advance(1);
    await plain(resolver, USER);
    expect(fetch.requests).toHaveLength(2);
  });

  it('404 → PrincipalNotFoundError; a non-UUID id is never sent', async () => {
    const { fetch, resolver } = setup(() => ({ status: 404, body: {} }));
    await expect(plain(resolver, USER)).rejects.toBeInstanceOf(PrincipalNotFoundError);
    await expect(plain(resolver, '../../v1/me')).rejects.toBeInstanceOf(PrincipalNotFoundError);
    expect(fetch.requests).toHaveLength(1);
  });

  describe('with a session id (rev 10, #47, SEC-F002-42)', () => {
    const SID = '0199a1b2-0000-7000-8000-00000000a001';
    const OTHER_SID = '0199a1b2-0000-7000-8000-00000000a002';
    const urlFor = (sid: string) => `${URL_USER}?sid=${sid}`;
    const forSession = (sid: string, sessionRoles: string[]) => ({
      ...principal,
      roles: ['user', 'platform_admin'],
      session_id: sid,
      session_roles: sessionRoles,
    });
    // fakeFetch routes on the path; the answer is chosen by the full URL (with ?sid=).
    const setupSessions = (routes: Record<string, () => { status: number; body?: unknown }>) => {
      const c = clock();
      const fetch = fakeFetch({
        [`GET ${URL_USER}`]: (r) => routes[`GET ${r.url}`]?.() ?? { status: 404, body: {} },
      });
      const resolver = createPrincipalResolver({
        baseUrl: BASE,
        serviceTokens: { getToken: () => Promise.resolve('svc') },
        fetch,
        now: c.now,
      });
      return { c, fetch, resolver };
    };

    it('asks with ?sid= and caches per (user, session): one session never answers for another', async () => {
      const { c, fetch, resolver } = setupSessions({
        [`GET ${urlFor(SID)}`]: () => ({ status: 200, body: forSession(SID, ['user']) }),
        [`GET ${urlFor(OTHER_SID)}`]: () => ({
          status: 200,
          body: forSession(OTHER_SID, ['user', 'platform_admin']),
        }),
        [`GET ${URL_USER}`]: () => ({ status: 200, body: principal }),
      });
      const weak = await resolver.resolve(USER, SID);
      expect(weak.session_roles).toEqual(['user']);
      expect(weak.roles).toContain('platform_admin'); // directory roles: never enough on their own
      const strong = await resolver.resolve(USER, OTHER_SID.toUpperCase());
      expect(strong.session_roles).toEqual(['user', 'platform_admin']);
      const noSession = await plain(resolver, USER);
      expect(noSession.session_roles).toBeUndefined();
      expect(fetch.requests.map((r) => r.url)).toEqual([urlFor(SID), urlFor(OTHER_SID), URL_USER]);
      c.advance(30_000);
      await resolver.resolve(USER, SID);
      expect(fetch.requests).toHaveLength(3);
      c.advance(1);
      await resolver.resolve(USER, SID);
      expect(fetch.requests).toHaveLength(4);
    });

    it('403 → PrincipalSessionRefusedError; a non-UUID sid is never sent', async () => {
      const { fetch, resolver } = setupSessions({
        [`GET ${urlFor(SID)}`]: () => ({ status: 403, body: {} }),
      });
      await expect(resolver.resolve(USER, SID)).rejects.toBeInstanceOf(
        PrincipalSessionRefusedError,
      );
      await expect(resolver.resolve(USER, '../x')).rejects.toBeInstanceOf(
        PrincipalSessionRefusedError,
      );
      expect(fetch.requests).toHaveLength(1);
    });

    it('fails closed on an answer without session_roles or for another session', async () => {
      for (const body of [
        principal,
        { ...forSession(SID, ['user']), session_roles: undefined },
        forSession(OTHER_SID, ['user']),
      ]) {
        const { resolver } = setupSessions({
          [`GET ${urlFor(SID)}`]: () => ({ status: 200, body }),
        });
        await expect(resolver.resolve(USER, SID)).rejects.toBeInstanceOf(PrincipalUnavailableError);
      }
      // An answer to a plain lookup that carries session roles is not what was asked for either.
      const { resolver } = setupSessions({
        [`GET ${URL_USER}`]: () => ({ status: 200, body: forSession(SID, ['user']) }),
      });
      await expect(plain(resolver, USER)).rejects.toBeInstanceOf(PrincipalUnavailableError);
    });
  });

  it('fails closed on errors, bad bodies and an answer for another user', async () => {
    for (const reply of [
      { status: 503, body: {} },
      { status: 200, body: { ...principal, roles: ['root'] } },
      { status: 200, body: { ...principal, user_id: ORG } },
    ]) {
      const { resolver } = setup(() => reply);
      await expect(plain(resolver, USER)).rejects.toBeInstanceOf(PrincipalUnavailableError);
    }
  });
});
