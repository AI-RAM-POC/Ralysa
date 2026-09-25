// The client-assertion time rules (review of #26, B2): exp at most 60 s ahead of the verifier's
// clock with no extra skew, a lifetime (exp - iat) of at most 60 s, iat not in the future beyond
// the skew. With these, a replay row kept until exp + skew + 60 s covers every accepted assertion.
import { describe, expect, it } from 'vitest';
import { REPLAY_MARGIN_S, assertionTimeProblem } from '../src/auth/grants/client-credentials.js';

const NOW = 1_800_000_000;

describe('client assertion time rules', () => {
  it('accepts a 60 s assertion issued now', () => {
    expect(assertionTimeProblem({ iat: NOW, exp: NOW + 60 }, NOW)).toBeUndefined();
  });

  it('refuses exp more than 60 s ahead, even inside the skew', () => {
    expect(assertionTimeProblem({ iat: NOW + 10, exp: NOW + 61 }, NOW)).toBe('exp too far ahead');
    expect(assertionTimeProblem({ iat: NOW + 30, exp: NOW + 89 }, NOW)).toBe('exp too far ahead');
  });

  it('refuses a lifetime over 60 s, whatever the clock', () => {
    expect(assertionTimeProblem({ iat: NOW - 600, exp: NOW + 30 }, NOW)).toBe('lifetime over 60 s');
    expect(assertionTimeProblem({ iat: NOW - 1, exp: NOW + 60 }, NOW)).toBe('lifetime over 60 s');
  });

  it('refuses iat in the future beyond the skew, and missing times', () => {
    expect(assertionTimeProblem({ iat: NOW + 31, exp: NOW + 60 }, NOW)).toBe('iat in the future');
    expect(assertionTimeProblem({ iat: NOW }, NOW)).toBe('iat and exp required');
    expect(assertionTimeProblem({ exp: NOW + 10 }, NOW)).toBe('iat and exp required');
  });

  it('the replay window outlives acceptance: exp + skew + margin', () => {
    expect(REPLAY_MARGIN_S).toBeGreaterThanOrEqual(60);
  });
});
