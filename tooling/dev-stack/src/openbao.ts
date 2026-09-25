// A minimal OpenBao HTTP helper for the dev-stack bootstrap and harness (dependency-free: global
// fetch). The product client is @ralysa/secrets (F-002-T04); this one only needs raw requests,
// including the operator calls (mounts, policies, key config) the product must never make.
export interface BaoResponse {
  status: number;
  body: Record<string, unknown> | undefined;
}

export type BaoRequest = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'LIST',
  path: string,
  body?: unknown,
) => Promise<BaoResponse>;

export class BaoError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** `path` is relative to `/v1/`. Errors carry the status and OpenBao's error strings, never the token. */
export function baoClient(addr: string, token?: string, timeoutMs = 10_000): BaoRequest {
  return async (method, path, body) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers['X-Vault-Token'] = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${addr}/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> | undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { raw: text.slice(0, 200) };
      }
    }
    return { status: response.status, body: parsed };
  };
}

/** Throws unless the status is 2xx. */
export function expectOk(response: BaoResponse, what: string): Record<string, unknown> {
  if (response.status >= 200 && response.status < 300) return response.body ?? {};
  const errors = response.body?.errors;
  const detail = Array.isArray(errors) ? errors.map(String).join('; ') : '';
  throw new BaoError(`${what}: HTTP ${String(response.status)} ${detail}`.trim(), response.status);
}

export function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  const data = body.data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}
