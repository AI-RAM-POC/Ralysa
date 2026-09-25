// Key activation timing (§3.2.4; AC-10): publish-then-activate, first key at once, pin, JWKS
// retention of a superseded key.
import { describe, expect, it } from 'vitest';
import { type KeyRow, jwksRows, selectActiveVersion } from '../src/auth/tokens/signing-keys.js';

const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' };
const t0 = Date.parse('2026-09-25T10:00:00Z');
const at = (s: number) => new Date(t0 + s * 1000);
const row = (version: number, fields: Partial<KeyRow> = {}): KeyRow => ({
  kid: `ralysa-rts-signing.v${String(version)}`,
  version,
  public_jwk: jwk,
  published_at: at(0),
  activated_at: null,
  superseded_at: null,
  retired_at: null,
  ...fields,
});
const timing = { activationDelayMs: 120_000, retentionMs: (900 + 300) * 1000 };

describe('selectActiveVersion', () => {
  it('the first key ever is active at once', () => {
    expect(selectActiveVersion([row(1)], at(0), timing)).toBe(1);
    expect(selectActiveVersion([], at(0), timing)).toBeUndefined();
  });

  it('a new version is published at once but used only after the activation delay (DB clock)', () => {
    const rows = [row(1, { activated_at: at(-600) }), row(2, { published_at: at(0) })];
    expect(selectActiveVersion(rows, at(119), timing)).toBe(1);
    expect(selectActiveVersion(rows, at(120), timing)).toBe(2);
  });

  it('the worst case new-key-in-use time is poll (30 s) + activation delay (120 s) ≤ 5 min (AC-10)', () => {
    expect(30_000 + timing.activationDelayMs).toBeLessThanOrEqual(5 * 60_000);
    expect(30_000 + 60_000 + 5_000).toBeLessThan(timing.activationDelayMs); // verifiers see it first
  });

  it('a pin forces a known version (rollback) and nothing else', () => {
    const rows = [
      row(1, { activated_at: at(-600) }),
      row(2, { published_at: at(-600), activated_at: at(-400) }),
    ];
    expect(selectActiveVersion(rows, at(0), { ...timing, pinVersion: 1 })).toBe(1);
    expect(selectActiveVersion(rows, at(0), { ...timing, pinVersion: 7 })).toBeUndefined();
  });

  it('retired versions are never used', () => {
    expect(selectActiveVersion([row(1, { retired_at: at(-1) })], at(0), timing)).toBeUndefined();
  });
});

describe('jwksRows', () => {
  it('publishes pending and active keys, keeps a superseded one until max TTL + 5 min, newest first', () => {
    const rows = [
      row(1, { activated_at: at(-3000), superseded_at: at(-100) }),
      row(2, { activated_at: at(-100) }),
      row(3, { published_at: at(-10) }),
      row(0, { retired_at: at(-5000) }),
    ];
    expect(jwksRows(rows, at(0), timing).map((r) => r.version)).toEqual([3, 2, 1]);
    expect(jwksRows(rows, at(1200), timing).map((r) => r.version)).toEqual([3, 2]);
  });
});
