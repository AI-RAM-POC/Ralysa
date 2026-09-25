// OpenBao authentication (F-002 design §3.7, §6.5; SEC-F002-12, -22). Kubernetes auth in a
// cluster, AppRole outside one (production only when the config allows it), a static token in
// dev and test only. Login tokens are renewed by logging in again at half their lease. A 403 on a
// login token triggers one re-login and retry only when `lookup-self` shows the token itself is
// no longer valid; a policy denial is returned as is.
import { SecretsError } from '../errors.js';
import type { RuntimeEnv, VaultAuth } from '../ports.js';
import { type BaoHttp, type BaoMethod, type BaoReply, record } from './http.js';

export interface AuthOptions {
  auth: VaultAuth;
  env: RuntimeEnv;
  /** Config `vault.allow_approle`; AppRole is refused in production without it. */
  allowAppRole?: boolean;
  now?: () => number;
}

/** Refuses auth methods the environment doesn't allow. Pure, so config tests can call it too. */
export function assertAuthAllowed(options: Omit<AuthOptions, 'now'>): void {
  const { auth, env } = options;
  if (auth.method === 'token' && env !== 'dev' && env !== 'test') {
    throw new SecretsError('config', `vault token auth is refused when env=${env}`);
  }
  if (auth.method === 'approle' && env === 'production' && options.allowAppRole !== true) {
    throw new SecretsError(
      'config',
      'vault AppRole auth is refused in production without allow_approle',
    );
  }
}

export interface AuthedBao {
  /** A request with the current token; re-logs in once if the token turned out to be invalid. */
  request(method: BaoMethod, path: string, body?: unknown): Promise<BaoReply>;
}

export function createAuthedBao(http: BaoHttp, options: AuthOptions): AuthedBao {
  assertAuthAllowed(options);
  const { auth } = options;
  const now = options.now ?? (() => Date.now());
  let current: { token: string; renewAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const login = async (): Promise<string> => {
    if (auth.method === 'token') return auth.token;
    const [path, body] =
      auth.method === 'kubernetes'
        ? [`auth/${auth.mount ?? 'kubernetes'}/login`, { role: auth.role, jwt: await auth.jwt() }]
        : [
            `auth/${auth.mount ?? 'approle'}/login`,
            { role_id: auth.roleId, secret_id: await auth.secretId() },
          ];
    const reply = await http.request('POST', path, body);
    if (reply.status < 200 || reply.status >= 300) {
      throw new SecretsError(
        reply.status >= 500 ? 'unavailable' : 'auth_failed',
        `OpenBao ${auth.method} login failed: HTTP ${String(reply.status)}`,
        reply.status,
      );
    }
    const info = record(reply.body?.auth);
    const token = info?.client_token;
    const lease = info?.lease_duration;
    if (typeof token !== 'string' || token === '') {
      throw new SecretsError('invalid_response', `OpenBao ${auth.method} login returned no token`);
    }
    const leaseMs = typeof lease === 'number' && lease > 0 ? lease * 1000 : 60_000;
    current = { token, renewAt: now() + leaseMs / 2 };
    return token;
  };

  const token = async (): Promise<string> => {
    if (auth.method === 'token') return auth.token;
    if (current !== undefined && now() < current.renewAt) return current.token;
    // Single-flight: concurrent callers share one login.
    pending ??= login().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  return {
    async request(method, path, body) {
      const used = await token();
      const reply = await http.request(method, path, body, used);
      if (reply.status !== 403 || auth.method === 'token') return reply;
      // 403 is both "policy denies this path" and "token invalid or expired". Only the second
      // warrants a new login (a login may consume a single-use secret_id): ask the token itself.
      const self = await http.request('GET', 'auth/token/lookup-self', undefined, used);
      if (self.status !== 403) return reply;
      if (current?.token === used) current = undefined;
      return http.request(method, path, body, await token());
    },
  };
}
