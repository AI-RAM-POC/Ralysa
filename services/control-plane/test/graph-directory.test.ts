// The Microsoft Graph directory (F-002 design §6.3; SEC-F002-08, -09; TC-F-002-09 unit part):
// checkMemberGroups for exactly the two configured groups, accountEnabled, Entra session
// revocation, 404 = deleted, timeouts, the circuit breaker, the app token and secret re-read, and
// group display names. Hermetic: fetch is a fake.
import { createInMemorySecretStore } from '@ralysa/secrets';
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_FAILURES,
  CIRCUIT_OPEN_MS,
  createGraphDirectory,
} from '../src/auth/idp/graph-directory.js';
import { serveConfig } from './fixtures/serve-config.js';

const config = serveConfig({ env: 'test', idp: { ...serveConfig().idp, graph_timeout_ms: 200 } });
const ACCESS = config.access.access_group_id;
const ADMIN = config.access.admin_group_id;
const OID = '6a0e5a4e-1111-4222-8333-444455556666';
const TOKEN_URL = 'https://login.example/token';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response | 'hang'> | 'hang';

const bodyOf = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

function fakeGraph(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = init ?? {};
    calls.push({ url, init: request });
    const answer = await handler(url, request);
    if (answer !== 'hang') return answer;
    return new Promise<Response>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        reject(request.signal?.reason as Error);
      });
    });
  }) as typeof fetch;
  return { doFetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tokenOk = () =>
  json(200, { access_token: 'app-token', expires_in: 3600, token_type: 'Bearer' });

function graphHandler(user: {
  status?: number;
  accountEnabled?: boolean;
  validFrom?: string | null;
  groups?: string[];
}): Handler {
  return (url, init) => {
    if (url === TOKEN_URL) return tokenOk();
    if (url.includes('/checkMemberGroups')) {
      if (user.status === 404) return json(404, { error: { code: 'Request_ResourceNotFound' } });
      const body = JSON.parse(bodyOf(init)) as { groupIds: string[] };
      return json(200, { value: body.groupIds.filter((g) => (user.groups ?? []).includes(g)) });
    }
    if (url.includes('/users/')) {
      if (user.status !== undefined && user.status !== 200) {
        return json(user.status, { error: { code: 'Request_ResourceNotFound' } });
      }
      return json(200, {
        accountEnabled: user.accountEnabled ?? true,
        signInSessionsValidFromDateTime:
          'validFrom' in user ? user.validFrom : '2026-01-01T00:00:00Z',
      });
    }
    return json(400, {});
  };
}

function directory(handler: Handler, clock = { t: 1_000_000 }) {
  const secrets = createInMemorySecretStore({ [config.idp.client_secret_path]: 'secret-v1' });
  const fake = fakeGraph(handler);
  const dir = createGraphDirectory({
    config,
    secrets,
    tokenEndpoint: () => Promise.resolve(TOKEN_URL),
    fetch: fake.doFetch,
    now: () => clock.t,
  });
  return { dir, calls: fake.calls, secrets, clock };
}

const user = { idpSubject: OID, tenantId: config.idp.tenant_id };

describe('Graph directory', () => {
  it('asks checkMemberGroups for exactly the two configured groups and reads the account state', async () => {
    const { dir, calls } = directory(graphHandler({ groups: [ACCESS, 'other'] }));
    expect(await dir.check(user)).toEqual({
      kind: 'ok',
      inAccessGroup: true,
      inAdminGroup: false,
      sessionsValidFrom: new Date('2026-01-01T00:00:00Z'),
    });
    const member = calls.find((c) => c.url.endsWith(`/v1.0/users/${OID}/checkMemberGroups`));
    expect(JSON.parse(bodyOf(member?.init))).toEqual({ groupIds: [ACCESS, ADMIN] });
    const state = calls.find((c) => c.url.includes('$select=accountEnabled'));
    expect(state?.url).toBe(
      `https://graph.microsoft.com/v1.0/users/${OID}?$select=accountEnabled,signInSessionsValidFromDateTime`,
    );
    expect(new Headers(state?.init.headers).get('authorization')).toBe('Bearer app-token');
    // Only the configured Graph base and the pinned token endpoint are ever called.
    for (const call of calls) {
      expect(call.url.startsWith('https://graph.microsoft.com/') || call.url === TOKEN_URL).toBe(
        true,
      );
    }
  });

  it('gets an app-only token with the client secret and scope .default, and caches it', async () => {
    const { dir, calls } = directory(graphHandler({ groups: [ACCESS] }));
    await dir.check(user);
    await dir.check(user);
    const tokenCalls = calls.filter((c) => c.url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(bodyOf(tokenCalls[0]?.init)))).toEqual({
      grant_type: 'client_credentials',
      client_id: config.idp.rts_client_id,
      client_secret: 'secret-v1',
      scope: 'https://graph.microsoft.com/.default',
    });
  });

  it('re-reads the client secret once on invalid_client (rotation)', async () => {
    let first = true;
    const { dir, calls, secrets } = directory((url, init) => {
      if (url === TOKEN_URL) {
        const secret = new URLSearchParams(bodyOf(init)).get('client_secret');
        if (first) {
          first = false;
          secrets.put(config.idp.client_secret_path, 'secret-v2');
          return json(401, { error: 'invalid_client' });
        }
        return secret === 'secret-v2' ? tokenOk() : json(401, { error: 'invalid_client' });
      }
      return graphHandler({ groups: [ACCESS] })(url, init);
    });
    expect((await dir.check(user)).kind).toBe('ok');
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it('maps accountEnabled=false to disabled and 404 to deleted (SEC-F002-09)', async () => {
    expect((await directory(graphHandler({ accountEnabled: false })).dir.check(user)).kind).toBe(
      'disabled',
    );
    expect((await directory(graphHandler({ status: 404 })).dir.check(user)).kind).toBe('deleted');
  });

  it('reports a null signInSessionsValidFromDateTime as null', async () => {
    const result = await directory(graphHandler({ validFrom: null, groups: [ADMIN] })).dir.check(
      user,
    );
    expect(result).toMatchObject({ kind: 'ok', inAdminGroup: true, sessionsValidFrom: null });
  });

  it.each([
    ['a 5xx', graphHandler({ status: 503 }), '503'],
    ['a 429', graphHandler({ status: 429 }), '429'],
    [
      'a malformed body',
      (url: string) => (url === TOKEN_URL ? tokenOk() : json(200, { value: 'x' })),
      'malformed',
    ],
    [
      'a failed token request',
      (url: string) => (url === TOKEN_URL ? json(500, {}) : json(200, {})),
      'token 500',
    ],
  ])('fails closed on %s', async (_name, handler, reason) => {
    const result = await directory(handler).dir.check(user);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toContain(reason);
  });

  // Deterministic (R29 follow-up): the deadline is a controller the test aborts itself, so these
  // don't depend on real timers. `times out at graph_timeout_ms` below keeps one real-timer check
  // of the default AbortSignal.timeout.
  function manualDeadlines() {
    const created: { ms: number; controller: AbortController }[] = [];
    return {
      created,
      deadline: (ms: number) => {
        const controller = new AbortController();
        created.push({ ms, controller });
        return controller.signal;
      },
      expire(index = 0) {
        created[index]?.controller.abort(new DOMException('deadline', 'TimeoutError'));
      },
    };
  }
  const signalled = () => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('one deadline covers the whole check, the token request included (R29-3)', async () => {
    const deadlines = manualDeadlines();
    const tokenAsked = signalled();
    const release = signalled();
    const graphAsked = signalled();
    let graphCalls = 0;
    const fake = fakeGraph(async (url) => {
      if (url === TOKEN_URL) {
        tokenAsked.resolve();
        await release.promise;
        return tokenOk();
      }
      if (++graphCalls === 2) graphAsked.resolve();
      return 'hang'; // aborted by the check's deadline
    });
    const dir = createGraphDirectory({
      config,
      secrets: createInMemorySecretStore({ [config.idp.client_secret_path]: 'secret-v1' }),
      tokenEndpoint: () => Promise.resolve(TOKEN_URL),
      fetch: fake.doFetch,
      deadline: deadlines.deadline,
    });
    const result = dir.check(user);
    await tokenAsked.promise;
    release.resolve();
    await graphAsked.promise;
    deadlines.expire();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'timeout' });
    // One deadline of graph_timeout_ms for the check; the token request and both Graph calls
    // carried that same signal.
    expect(deadlines.created.map((d) => d.ms)).toEqual([200]);
    expect(fake.calls).toHaveLength(3);
    for (const call of fake.calls) {
      expect(call.init.signal).toBe(deadlines.created[0]?.controller.signal);
    }
  });

  it('a slow secret read counts against the same deadline', async () => {
    const deadlines = manualDeadlines();
    const secretAsked = signalled();
    const secrets = createInMemorySecretStore();
    const slow = {
      get: () => {
        secretAsked.resolve();
        return new Promise<never>(() => undefined);
      },
      watch: secrets.watch.bind(secrets),
    };
    const fake = fakeGraph(graphHandler({ groups: [ACCESS] }));
    const dir = createGraphDirectory({
      config,
      secrets: slow,
      tokenEndpoint: () => Promise.resolve(TOKEN_URL),
      fetch: fake.doFetch,
      deadline: deadlines.deadline,
    });
    const result = dir.check(user);
    await secretAsked.promise;
    deadlines.expire();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(deadlines.created).toHaveLength(1);
    // The secret never arrived, so nothing was sent.
    expect(fake.calls).toEqual([]);
  });

  it('a 404 that is not Request_ResourceNotFound is a fault, not a deletion (review of #29)', async () => {
    const { dir } = directory((url) =>
      url === TOKEN_URL ? tokenOk() : json(404, { error: { code: 'BadRequest' } }),
    );
    expect(await dir.check(user)).toEqual({ kind: 'unavailable', reason: 'not_found_unexpected' });
    const html = directory((url) =>
      url === TOKEN_URL ? tokenOk() : new Response('<html>Not Found</html>', { status: 404 }),
    );
    expect((await html.dir.check(user)).kind).toBe('unavailable');
  });

  it('times out at graph_timeout_ms', async () => {
    const { dir } = directory((url) => (url === TOKEN_URL ? tokenOk() : 'hang'));
    const started = performance.now();
    expect(await dir.check(user)).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('opens the circuit after 5 consecutive failures for 30 s, then tries again', async () => {
    let down = true;
    const healthy = graphHandler({ groups: [ACCESS] });
    const { dir, calls, clock } = directory((url, init) =>
      down && url !== TOKEN_URL ? json(503, {}) : healthy(url, init),
    );
    for (let i = 0; i < CIRCUIT_FAILURES; i++)
      expect((await dir.check(user)).kind).toBe('unavailable');
    expect(dir.circuit().open).toBe(true);
    const before = calls.length;
    expect(await dir.check(user)).toEqual({ kind: 'unavailable', reason: 'circuit_open' });
    expect(calls.length).toBe(before); // no call while open
    down = false;
    clock.t += CIRCUIT_OPEN_MS - 1;
    expect(await dir.check(user)).toEqual({ kind: 'unavailable', reason: 'circuit_open' });
    clock.t += 1;
    expect((await dir.check(user)).kind).toBe('ok');
    expect(dir.circuit()).toEqual({ open: false, consecutiveFailures: 0 });
  });

  it('a success resets the failure count', async () => {
    let fail = true;
    const healthy = graphHandler({ groups: [ACCESS] });
    const { dir } = directory((url, init) =>
      fail && url !== TOKEN_URL ? json(500, {}) : healthy(url, init),
    );
    for (let i = 0; i < CIRCUIT_FAILURES - 1; i++) await dir.check(user);
    fail = false;
    await dir.check(user);
    fail = true;
    await dir.check(user);
    expect(dir.circuit()).toEqual({ open: false, consecutiveFailures: 1 });
  });

  it('reads group display names for display only; 404 is null, a fault undefined', async () => {
    const { dir } = directory((url) => {
      if (url === TOKEN_URL) return tokenOk();
      if (url.includes('/groups/g1')) return json(200, { displayName: 'فَرِيقُ المالِيَّة' });
      if (url.includes('/groups/g2')) return json(404, {});
      return json(500, {});
    });
    expect(await dir.groupDisplayName?.('g1')).toBe('فَرِيقُ المالِيَّة');
    expect(await dir.groupDisplayName?.('g2')).toBeNull();
    expect(await dir.groupDisplayName?.('g3')).toBeUndefined();
  });
});
