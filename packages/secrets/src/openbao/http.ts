// Minimal OpenBao/Vault HTTP client over `fetch` (F-002 design §3.7). Paths are validated so a
// caller-supplied key or secret name can't walk to another endpoint, and errors carry the path
// and status only.
import { SecretsError } from '../errors.js';
import { type Fetch, defaultFetch, timeoutSignal } from '../platform.js';

export type BaoMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface BaoReply {
  status: number;
  body: Record<string, unknown> | undefined;
}

export interface BaoHttp {
  request(method: BaoMethod, path: string, body?: unknown, token?: string): Promise<BaoReply>;
}

export interface BaoHttpOptions {
  addr: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

const SEGMENT = /^[A-Za-z0-9_.+-]+$/;

/** Throws unless `path` is `seg(/seg)*` with no empty, `.` or `..` segment. */
export function assertApiPath(path: string): void {
  const segments = path.split('/');
  const ok = segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!ok) throw new SecretsError('config', `invalid OpenBao path ${JSON.stringify(path)}`);
}

export function createBaoHttp(options: BaoHttpOptions): BaoHttp {
  // Scheme, host (name, IPv4 or bracketed IPv6), optional port and path: no credentials, query or
  // fragment. (No `URL` global under the isomorphic lib, and this is all an address needs.)
  const match =
    /^(https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?)(\/[A-Za-z0-9._~/-]*)?$/.exec(
      options.addr,
    );
  if (match === null) throw new SecretsError('config', 'vault addr must be a plain http(s) URL');
  const base = `${match[1] ?? ''}${(match[2] ?? '').replace(/\/+$/, '')}`;
  const fetch = options.fetch ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? 5000;

  return {
    async request(method, path, body, token) {
      assertApiPath(path);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (token !== undefined) headers['x-vault-token'] = token;
      if (body !== undefined) headers['content-type'] = 'application/json';
      let response;
      try {
        response = await fetch(`${base}/v1/${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: timeoutSignal(timeoutMs),
        });
      } catch {
        throw new SecretsError(
          'unavailable',
          `OpenBao ${method} ${path}: unreachable or timed out`,
        );
      }
      let parsed: unknown;
      try {
        parsed = response.status === 204 ? undefined : await response.json();
      } catch {
        parsed = undefined;
      }
      const record =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      return { status: response.status, body: record };
    },
  };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Maps a non-2xx reply to a typed error that names only the operation and status. */
export function replyError(reply: BaoReply, what: string): SecretsError {
  if (reply.status === 403) return new SecretsError('access_denied', `${what}: denied`, 403);
  if (reply.status === 404) return new SecretsError('not_found', `${what}: not found`, 404);
  if (reply.status === 429 || reply.status >= 500) {
    return new SecretsError(
      'unavailable',
      `${what}: OpenBao ${String(reply.status)}`,
      reply.status,
    );
  }
  return new SecretsError(
    'invalid_response',
    `${what}: HTTP ${String(reply.status)}`,
    reply.status,
  );
}
