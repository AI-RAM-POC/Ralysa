// Key activation timing (§3.2.4; AC-10): publish-then-activate, first key at once, pin, JWKS
// retention of a superseded key.
import { describe, expect, it } from 'vitest';
import {
  type KeyRow,
  jwksRows,
  selectActiveVersion,
  versionsToRetire,
  versionsToSupersede,
  versionToUnsupersede,
} from '../src/auth/tokens/signing-keys.js';

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

describe('versionsToSupersede (T07 follow-up, review of #35)', () => {
  it('three versions at the first poll: v3 activates, v1 and v2 (never active) are superseded and leave JWKS after retention', () => {
    const published = [row(1), row(2), row(3)];
    expect(selectActiveVersion(published, at(0), timing)).toBe(3);
    expect(versionsToSupersede(published, 3)).toEqual([1, 2]);
    const after = [
      row(1, { superseded_at: at(0) }),
      row(2, { superseded_at: at(0) }),
      row(3, { activated_at: at(0) }),
    ];
    expect(jwksRows(after, at(1), timing).map((r) => r.version)).toEqual([3, 2, 1]);
    expect(jwksRows(after, at(1200), timing).map((r) => r.version)).toEqual([3]);
    // Without the fix, a never-active version kept superseded_at null and stayed for ever.
    expect(jwksRows(published, at(1_000_000), timing).map((r) => r.version)).toEqual([3, 2, 1]);
  });

  it('two rotations within one poll: the skipped version is superseded with the old active one', () => {
    const rows = [
      row(1, { activated_at: at(-600) }),
      row(2, { published_at: at(0) }),
      row(3, { published_at: at(0) }),
    ];
    expect(selectActiveVersion(rows, at(120), timing)).toBe(3);
    expect(versionsToSupersede(rows, 3)).toEqual([1, 2]);
  });

  it('never supersedes a newer version, an already superseded one or a retired one', () => {
    const rows = [
      row(1, { retired_at: at(-10) }),
      row(2, { superseded_at: at(-100) }),
      row(3),
      row(5),
    ];
    expect(versionsToSupersede(rows, 4)).toEqual([3]);
  });
});

describe('versionsToSupersede while pinned (review of #37)', () => {
  // v1 was active, v2 (bad) took over and superseded it, the operator pins v1.
  const afterBadV2 = [
    row(1, { activated_at: at(-3000), superseded_at: at(-600) }),
    row(2, { activated_at: at(-600) }),
  ];

  it('supersedes the newer version that was active, so it retires after the retention', () => {
    expect(versionsToSupersede(afterBadV2, 1, 1)).toEqual([2]);
    const superseded = [
      row(1, { activated_at: at(-3000) }),
      row(2, { activated_at: at(-600), superseded_at: at(0) }),
    ];
    const pinned = { ...timing, pinVersion: 1 };
    expect(jwksRows(superseded, at(1199), pinned).map((r) => r.version)).toEqual([2, 1]);
    expect(versionsToRetire(superseded, at(1199), pinned, 1)).toEqual([]);
    expect(versionsToRetire(superseded, at(1200), pinned, 1)).toEqual([2]);
  });

  it('leaves a newer version that was never active (it activates once the pin is removed)', () => {
    const rows = [...afterBadV2, row(3, { published_at: at(-10) })];
    expect(versionsToSupersede(rows, 1, 1)).toEqual([2]);
  });

  it('does nothing above the selected version when it is not the pin', () => {
    expect(versionsToSupersede(afterBadV2, 1)).toEqual([]);
    expect(versionsToSupersede(afterBadV2, 1, 2)).toEqual([]);
  });

  it('never touches a retired or already superseded newer version', () => {
    const rows = [
      row(1, { activated_at: at(-3000) }),
      row(2, { activated_at: at(-2000), superseded_at: at(-100) }),
      row(3, { activated_at: at(-1000), retired_at: at(-1) }),
    ];
    expect(versionsToSupersede(rows, 1, 1)).toEqual([]);
  });
});

describe('versionToUnsupersede (#36, review of #37)', () => {
  it('a pinned version that had been superseded is live again', () => {
    const rows = [
      row(1, { activated_at: at(-3000), superseded_at: at(-600) }),
      row(2, { activated_at: at(-600) }),
    ];
    expect(selectActiveVersion(rows, at(0), { ...timing, pinVersion: 1 })).toBe(1);
    expect(versionToUnsupersede(rows, 1)).toBe(1);
  });

  it('unpinned before the newer version retired: it signs again, unsuperseded, and the former pin is superseded', () => {
    const rows = [
      row(1, { activated_at: at(-3000) }),
      row(2, { activated_at: at(-600), superseded_at: at(-100) }),
    ];
    expect(selectActiveVersion(rows, at(0), timing)).toBe(2);
    expect(versionToUnsupersede(rows, 2)).toBe(2);
    expect(versionsToSupersede(rows, 2)).toEqual([1]);
    // Past the retention in the same read: the selected version is still never retired.
    expect(versionsToRetire(rows, at(1_000_000), timing, 2)).toEqual([]);
  });

  it('unpinned after the newer version retired: the former pin simply keeps signing', () => {
    const rows = [
      row(1, { activated_at: at(-3000) }),
      row(2, { activated_at: at(-3000), superseded_at: at(-2000), retired_at: at(-700) }),
    ];
    expect(selectActiveVersion(rows, at(0), timing)).toBe(1);
    expect(versionToUnsupersede(rows, 1)).toBeUndefined();
    expect(versionsToSupersede(rows, 1)).toEqual([]);
    expect(versionsToRetire(rows, at(1_000_000), timing, 1)).toEqual([]);
  });

  it('nothing for a version that is not superseded, is retired, or when none is selected', () => {
    expect(versionToUnsupersede([row(1, { activated_at: at(-1) })], 1)).toBeUndefined();
    expect(
      versionToUnsupersede([row(1, { superseded_at: at(-9), retired_at: at(-1) })], 1),
    ).toBeUndefined();
    expect(versionToUnsupersede([row(1, { superseded_at: at(-9) })], undefined)).toBeUndefined();
  });
});

describe('versionsToRetire (#36)', () => {
  const superseded = [
    row(1, { activated_at: at(-3000), superseded_at: at(-1300) }),
    row(2, { activated_at: at(-1300), superseded_at: at(-100) }),
    row(3, { activated_at: at(-100) }),
  ];

  it('retires a version superseded for longer than the retention, and only that one', () => {
    expect(versionsToRetire(superseded, at(0), timing)).toEqual([1]);
    expect(versionsToRetire(superseded, at(1100), timing)).toEqual([1, 2]);
  });

  it('never retires the pinned version (a rollback keeps signing)', () => {
    const pinned = { ...timing, pinVersion: 1 };
    expect(versionsToRetire(superseded, at(1_000_000), pinned)).toEqual([2]);
    expect(selectActiveVersion(superseded, at(1_000_000), pinned)).toBe(1);
  });

  it('skips retired and never-superseded rows', () => {
    const rows = [row(1, { superseded_at: at(-5000), retired_at: at(-100) }), row(2)];
    expect(versionsToRetire(rows, at(1_000_000), timing)).toEqual([]);
  });
});
