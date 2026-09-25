// One small request helper for every call the package makes: a timeout on each request, no
// redirects followed (an OAuth endpoint that redirects is misconfigured or hostile), and a body
// that is always parsed as untrusted JSON. Callers validate it with their zod contract.
import { type Fetch, defaultFetch, formBody, timeoutSignal } from './platform.js';

export interface HttpOptions {
  /** Defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Per request; default 10 s. */
  timeoutMs?: number;
}

export interface HttpReply {
  status: number;
  /** The parsed JSON body, or undefined when there is none or it isn't JSON. */
  body: unknown;
}

/** The fetch itself failed (DNS, connection, timeout): nothing is known about the server side. */
export class NetworkError extends Error {
  constructor(what: string) {
    super(`${what}: unreachable or timed out`);
    this.name = 'NetworkError';
  }
}

export async function request(
  options: HttpOptions,
  method: 'GET' | 'POST',
  url: string,
  init: {
    form?: Record<string, string>;
    json?: unknown;
    bearer?: string;
    signal?: unknown;
    /** Describes the call in errors; never contains a secret. */
    what: string;
  },
): Promise<HttpReply> {
  const fetch = options.fetch ?? defaultFetch();
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (init.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = formBody(init.form);
  } else if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      signal: timeoutSignal(options.timeoutMs ?? 10_000, init.signal),
    });
  } catch (error) {
    if (isAbort(error, init.signal)) throw error;
    throw new NetworkError(init.what);
  }
  let parsed: unknown;
  try {
    parsed = response.status === 204 ? undefined : await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

/** True when the caller's own signal aborted (a user cancel), as opposed to our timeout. */
function isAbort(error: unknown, signal: unknown): boolean {
  return (
    typeof signal === 'object' &&
    signal !== null &&
    (signal as { aborted?: unknown }).aborted === true &&
    error instanceof Error
  );
}

/** `<base>/<path>` for a base that is an absolute http(s) URL without query or fragment. */
export function joinUrl(base: string, path: string): string {
  if (!/^https?:\/\/[^\s?#]+$/.test(base)) throw new Error('base URL must be a plain http(s) URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}
