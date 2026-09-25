// JCS (RFC 8785), I-JSON (RFC 7493) and the audit hash chain (F-002 design §4.6, [AR-5], [AR-7]).
import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';
import {
  GENESIS_PREV_HASH,
  IJsonError,
  canonicalEnvelope,
  canonicalSize,
  chainHash,
  eventHash,
  eventHashHex,
  iJsonViolations,
  isIJson,
  jcs,
} from '../src/audit/index.js';
import { fromHex, sha256, toHex } from '../src/common/index.js';

import { utf8 } from '../src/platform.js';

describe('RFC 8785 canonicalisation', () => {
  it('§3.2.2: the RFC example serialises byte for byte', () => {
    const input = {
      // The RFC's first number has more digits than a double holds; parse it from its text.
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it('§3.2.3: members are sorted by UTF-16 code units', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    expect(jcs(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it.each([
    [0, '0'],
    [-0, '0'],
    [5e-324, '5e-324'],
    [1e-7, '1e-7'],
    [0.000001, '0.000001'],
    [1e20, '100000000000000000000'],
    [1e21, '1e+21'],
    [9007199254740992, '9007199254740992'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
  ])('Appendix B-style number %d serialises as %s (ECMAScript Number::toString)', (value, text) => {
    expect(canonicalize(value)).toBe(text);
  });

  it('keeps Arabic text and harakat byte-identical (no normalisation, AC-15)', () => {
    const name = 'فَاطِمَة';
    expect(jcs({ name })).toBe(`{"name":"${name}"}`);
    expect(jcs({ name }).normalize('NFC')).toBe(jcs({ name }));
  });
});

describe('I-JSON (RFC 7493)', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 9007199254740992],
    ['a large integral double', 1e30],
    ['a lone high surrogate', 'a\ud800b'],
    ['a lone low surrogate', '\udc00'],
    ['undefined', undefined],
    ['a Date', new Date(0)],
    ['a function', () => 1],
    ['a bigint', 1n],
  ])('refuses %s', (_label, value) => {
    expect(isIJson({ nested: [value] })).toBe(false);
    expect(() => jcs({ nested: [value] })).toThrow(IJsonError);
  });

  it('refuses a member name with a lone surrogate, and names the path', () => {
    expect(iJsonViolations({ a: { '\ud800': 1 } })).toEqual([
      { path: '$.a.\ud800', reason: 'member name has a lone surrogate' },
    ]);
  });

  it('refuses nesting deeper than 64', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(isIJson(deep)).toBe(false);
  });

  it('accepts safe integers at the edge, finite doubles, surrogate pairs and nulls', () => {
    expect(
      isIJson({
        max: Number.MAX_SAFE_INTEGER,
        min: Number.MIN_SAFE_INTEGER,
        pi: 3.14159,
        tiny: 5e-324,
        emoji: '😀',
        nothing: null,
        list: [true, false, 'x'],
      }),
    ).toBe(true);
  });
});

const BASE_EVENT = {
  event_id: '0192f0a0-7b3c-7d4e-8f00-000000000001',
  action: 'auth.sign_in',
  actor: {
    type: 'user',
    user_id: '0192f0a0-7b3c-7d4e-8f00-0000000000aa',
    idp_subject: '4f1c2e3d-0000-4000-8000-000000000001',
    service: null,
  },
  surface: 'cli',
  resource: null,
  outcome: 'success',
  reason_code: null,
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
  span_id: null,
  policy_version: 'p0-static:0123456789ab',
  details: { flow: 'idp_device', protocol: 'oidc', note: null },
  schema_version: 1,
  ts: '2026-09-25T10:00:00.000Z',
  org_id: '0192f0a0-7b3c-7d4e-8f00-00000000000f',
  source: 'control-plane',
  attestation: 'server',
} as const;

/**
 * Golden values: the canonical form is frozen. If this changes, every stored chain breaks
 * (ADR-0021); never update these to make a test pass. Both hashes were cross-checked outside
 * this code (shasum -a 256 and Python hashlib, 2026-09-25).
 */
const BASE_CANONICAL =
  '{"action":"auth.sign_in","actor":{"idp_subject":"4f1c2e3d-0000-4000-8000-000000000001","type":"user","user_id":"0192f0a0-7b3c-7d4e-8f00-0000000000aa"},"attestation":"server","details":{"flow":"idp_device","note":null,"protocol":"oidc"},"event_id":"0192f0a0-7b3c-7d4e-8f00-000000000001","org_id":"0192f0a0-7b3c-7d4e-8f00-00000000000f","outcome":"success","policy_version":"p0-static:0123456789ab","schema_version":1,"source":"control-plane","surface":"cli","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","ts":"2026-09-25T10:00:00.000Z"}';
const BASE_HASH = '939a8a46e933aa02d3bb25569abffa96be33966aecc2989baeb1ed96353d8a7e';
const BASE_CHAIN = '18c0ae2ec72a72445b9152793cde63104e0016b7c957666f4c83c65306706c3d';

describe('audit canonical form and hash chain (§4.6)', () => {
  it('omits null and absent envelope members, and nulls inside actor/act/resource', () => {
    expect(jcs(canonicalEnvelope(BASE_EVENT))).toBe(BASE_CANONICAL);
  });

  it('keeps nulls inside details: they are data', () => {
    expect(BASE_CANONICAL).toContain('"note":null');
  });

  it('pins the event hash of the reference event', async () => {
    expect(await eventHashHex(BASE_EVENT)).toBe(BASE_HASH);
    expect(toHex(await sha256(utf8(BASE_CANONICAL)))).toBe(BASE_HASH);
  });

  it('[AR-7] adding a nullable column later leaves the hash unchanged', async () => {
    const after = {
      ...BASE_EVENT,
      // Envelope fields F-004/F-011 will add as nullable columns, not yet set on this row.
      grant_id: null,
      approval_id: null,
      exception_id: undefined,
      content_ref: null,
      rows: null,
      masked_entity_counts: null,
      endpoint_region: null,
      actor: { ...BASE_EVENT.actor, on_behalf_of: null },
    };
    expect(await eventHashHex(after)).toBe(BASE_HASH);
  });

  it('any change to a value changes the hash', async () => {
    for (const changed of [
      { ...BASE_EVENT, outcome: 'denied' },
      { ...BASE_EVENT, ts: '2026-09-25T10:00:00.001Z' },
      { ...BASE_EVENT, details: { ...BASE_EVENT.details, note: 'x' } },
      { ...BASE_EVENT, details: { flow: 'idp_device', protocol: 'oidc' } },
      { ...BASE_EVENT, actor: { ...BASE_EVENT.actor, service: 'x' } },
    ]) {
      expect(await eventHashHex(changed)).not.toBe(BASE_HASH);
    }
  });

  it('chains SHA-256(prev ‖ event_hash) from 32 zero bytes', async () => {
    expect(GENESIS_PREV_HASH).toEqual(new Uint8Array(32));
    const first = await chainHash(GENESIS_PREV_HASH, await eventHash(BASE_EVENT));
    const joined = new Uint8Array([...GENESIS_PREV_HASH, ...fromHex(BASE_HASH)]);
    expect(toHex(first)).toBe(toHex(await sha256(joined)));
    expect(toHex(first)).toBe(BASE_CHAIN);
    const second = await chainHash(first, await eventHash({ ...BASE_EVENT, outcome: 'denied' }));
    expect(toHex(second)).not.toBe(toHex(first));
  });

  it('chainHash refuses values that are not 32 bytes', async () => {
    await expect(chainHash(new Uint8Array(31), new Uint8Array(32))).rejects.toThrow(/32-byte/);
  });

  it('refuses to hash an event whose details are not I-JSON', async () => {
    await expect(eventHash({ ...BASE_EVENT, details: { big: 2 ** 60 } })).rejects.toThrow(
      IJsonError,
    );
  });

  it('measures the canonical size in UTF-8 bytes', () => {
    expect(canonicalSize(BASE_EVENT)).toBe(utf8(BASE_CANONICAL).length);
    expect(canonicalSize({ name: 'فاطمة' })).toBe(utf8('{"name":"فاطمة"}').length);
  });
});

describe('platform helpers', () => {
  it('SHA-256 of "abc" (FIPS 180-2 vector)', async () => {
    expect(toHex(await sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hex round-trips and refuses upper case or odd length', () => {
    expect(toHex(fromHex('00ff10'))).toBe('00ff10');
    expect(() => fromHex('0F')).toThrow();
    expect(() => fromHex('abc')).toThrow();
  });
});
