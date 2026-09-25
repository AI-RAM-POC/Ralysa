// The web-platform APIs @ralysa/secrets uses, reached through `globalThis` with structural types
// (the same approach as @ralysa/protocol, T03-3): lib-isomorphic.json has neither DOM nor Node
// types. All of these exist in Node 24, browsers, Deno, Bun and workers. Lookups happen at call
// time so test fake timers and fetch stubs take effect.

export interface FetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: unknown;
}
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface CryptoKeyHandle {
  readonly extractable: boolean;
}
export interface CryptoKeyPairHandle {
  privateKey: CryptoKeyHandle;
  publicKey: CryptoKeyHandle;
}
type EcParams = { name: 'ECDSA'; namedCurve: 'P-256' };
type EcSignParams = { name: 'ECDSA'; hash: 'SHA-256' };
export interface Subtle {
  importKey(
    format: 'spki' | 'jwk',
    keyData: Uint8Array | Record<string, unknown>,
    algorithm: EcParams,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<CryptoKeyHandle>;
  exportKey(format: 'jwk', key: CryptoKeyHandle): Promise<Record<string, unknown>>;
  generateKey(
    algorithm: EcParams,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<CryptoKeyPairHandle>;
  sign(algorithm: EcSignParams, key: CryptoKeyHandle, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: EcSignParams,
    key: CryptoKeyHandle,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

type TimerId = unknown;
interface Platform {
  fetch?: Fetch;
  crypto?: { subtle?: Subtle };
  atob?: (data: string) => string;
  btoa?: (data: string) => string;
  AbortSignal?: { timeout?: (ms: number) => unknown };
  setInterval?: (fn: () => void, ms: number) => TimerId;
  clearInterval?: (id: TimerId) => void;
}

const platform = (): Platform => globalThis as unknown as Platform;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`@ralysa/secrets needs ${what}`);
  return value;
}

export function defaultFetch(): Fetch {
  const fetch = need(platform().fetch, 'fetch');
  return (url, init) => fetch(url, init);
}

export function subtle(): Subtle {
  return need(platform().crypto?.subtle, 'WebCrypto (globalThis.crypto.subtle)');
}

export function timeoutSignal(ms: number): unknown {
  return platform().AbortSignal?.timeout?.(ms);
}

export function startInterval(fn: () => void, ms: number): () => void {
  const p = platform();
  const id = need(p.setInterval, 'setInterval')(fn, ms);
  return () => {
    need(p.clearInterval, 'clearInterval')(id);
  };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return need(platform().btoa, 'btoa')(binary);
}

/** Standard or URL-safe base64, padded or not. */
export function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw new Error('not base64');
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = need(platform().atob, 'atob')(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
