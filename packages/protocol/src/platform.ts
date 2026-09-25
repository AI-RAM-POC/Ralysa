// The few web-platform APIs @ralysa/protocol uses, reached through `globalThis` with structural
// types. lib-isomorphic.json has neither DOM nor Node types, so neither `crypto` nor
// `TextEncoder` is declared; typing only what we call keeps the isomorphic base honest. Both
// exist in browsers, Node 24, Deno, Bun and workers (the WinterTC minimum common API).

interface SubtleDigest {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}
export interface WebCrypto {
  subtle: SubtleDigest;
  getRandomValues<T extends Uint8Array>(array: T): T;
}
interface Utf8Encoder {
  encode(input: string): Uint8Array;
}

const platform = globalThis as unknown as {
  crypto?: WebCrypto;
  TextEncoder?: new () => Utf8Encoder;
};

export function webCrypto(): WebCrypto {
  const crypto = platform.crypto;
  if (crypto?.subtle === undefined) {
    throw new Error('@ralysa/protocol needs WebCrypto (globalThis.crypto.subtle)');
  }
  return crypto;
}

let encoder: Utf8Encoder | undefined;

export function utf8(text: string): Uint8Array {
  if (encoder === undefined) {
    if (platform.TextEncoder === undefined) {
      throw new Error('@ralysa/protocol needs TextEncoder');
    }
    encoder = new platform.TextEncoder();
  }
  return encoder.encode(text);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await webCrypto().subtle.digest('SHA-256', data));
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('not lowercase hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomHex(bytes: number): string {
  return toHex(webCrypto().getRandomValues(new Uint8Array(bytes)));
}
