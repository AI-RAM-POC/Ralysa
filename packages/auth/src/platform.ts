// The web-platform APIs @ralysa/auth uses, reached through `globalThis` with structural types
// (the approach of @ralysa/protocol and @ralysa/secrets): lib-isomorphic.json has neither DOM nor
// Node types. Everything here exists in Node 24, browsers, Deno, Bun and workers. Lookups happen
// at call time so test fetch stubs and fake timers take effect.

export interface FetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: unknown;
  redirect?: 'manual' | 'error' | 'follow';
}
/** The subset of `fetch` the package calls. Every entry point accepts one for tests and proxies. */
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>;

interface Subtle {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}
interface Utf8Encoder {
  encode(input: string): Uint8Array;
}
interface UrlSearchParamsLike {
  toString(): string;
}
interface UrlConstructor {
  new (url: string): { readonly href: string; toString(): string };
}

type TimerId = unknown;
interface Platform {
  fetch?: Fetch;
  crypto?: {
    subtle?: Subtle;
    getRandomValues?<T extends Uint8Array>(array: T): T;
    randomUUID?(): string;
  };
  TextEncoder?: new () => Utf8Encoder;
  URLSearchParams?: new (init: Record<string, string>) => UrlSearchParamsLike;
  URL?: UrlConstructor;
  btoa?: (data: string) => string;
  AbortSignal?: { timeout?: (ms: number) => unknown; any?: (signals: unknown[]) => unknown };
  setTimeout?: (fn: () => void, ms: number) => TimerId;
  clearTimeout?: (id: TimerId) => void;
  performance?: { now(): number };
}

const platform = (): Platform => globalThis as unknown as Platform;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`@ralysa/auth needs ${what}`);
  return value;
}

export function defaultFetch(): Fetch {
  const fetch = need(platform().fetch, 'fetch');
  return (url, init) => fetch(url, init);
}

export function randomBytes(length: number): Uint8Array {
  const crypto = platform().crypto;
  if (crypto?.getRandomValues === undefined) throw new Error('@ralysa/auth needs WebCrypto');
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomUuid(): string {
  const crypto = platform().crypto;
  if (crypto?.randomUUID === undefined) throw new Error('@ralysa/auth needs WebCrypto');
  return crypto.randomUUID();
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const subtle = need(platform().crypto?.subtle, 'WebCrypto (globalThis.crypto.subtle)');
  return new Uint8Array(await subtle.digest('SHA-256', data));
}

let encoder: Utf8Encoder | undefined;
export function utf8(text: string): Uint8Array {
  encoder ??= new (need(platform().TextEncoder, 'TextEncoder'))();
  return encoder.encode(text);
}

/** RFC 4648 §5 base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return need(
    platform().btoa,
    'btoa',
  )(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** `application/x-www-form-urlencoded` body. */
export function formBody(params: Record<string, string>): string {
  return new (need(platform().URLSearchParams, 'URLSearchParams'))(params).toString();
}

/** A WHATWG `URL` (built from a string this package has validated). */
export function newUrl(href: string): { readonly href: string; toString(): string } {
  return new (need(platform().URL, 'URL'))(href);
}

export function timeoutSignal(ms: number, outer?: unknown): unknown {
  const signals = platform().AbortSignal;
  const timeout = signals?.timeout?.(ms);
  if (outer === undefined) return timeout;
  if (timeout === undefined) return outer;
  return signals?.any?.([outer, timeout]) ?? outer;
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  const p = platform();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      need(p.clearTimeout, 'clearTimeout')(id);
      reject(abortReason(signal));
    };
    const id = need(p.setTimeout, 'setTimeout')(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function startTimer(fn: () => void, ms: number): () => void {
  const p = platform();
  const id = need(p.setTimeout, 'setTimeout')(fn, ms);
  return () => {
    need(p.clearTimeout, 'clearTimeout')(id);
  };
}

export function monotonicMs(): number {
  return platform().performance?.now() ?? Date.now();
}

/** The part of `AbortSignal` the package uses. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

function abortReason(signal: AbortSignalLike | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
