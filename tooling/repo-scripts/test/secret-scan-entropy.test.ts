// F-001-T05 follow-up (PR #20 flake): the self-test's synthetic credentials must always be
// reportable. gitleaks drops a match whose entropy is <= its rule's floor; a random
// `AKIA` + 16-character value fell below 3 about once in 6 000 draws (seen in CI as
// "aws-access-token not reported"), so detectable() redraws until the value clears the floor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  RULE_ENTROPY,
  canary,
  detectable,
  frag,
  shannonEntropy,
  syntheticSet,
} from '../src/secret-scan-selftest.ts';
import { REAL_ROOT } from './repo-copy.ts';

// The key CI missed (run 36160986910). It is 20 characters of the AWS key shape with entropy
// 2.97, below the floor, so gitleaks correctly ignored it. It is not a credential.
const MISSED = frag('AK', 'IA', 'XJXIAGWXFLALLQAA');

describe('shannonEntropy', () => {
  it('matches hand-computed values', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBe(1);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(shannonEntropy(MISSED)).toBeCloseTo(2.971, 3);
  });
});

describe('detectable()', () => {
  it('redraws a value below the floor (the CI miss) and returns the next good one', () => {
    const draws = [MISSED.slice(4), 'QWERTYZ234567ABCD'.slice(0, 16)];
    const draw = (): string => draws.shift() ?? '';
    const value = detectable(frag('AK', 'IA'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16, 3, { draw });
    expect(value).toBe(`${frag('AK', 'IA')}QWERTYZ234567ABC`);
    expect(draws).toEqual([]);
  });

  it('redraws a value the rule allow-lists', () => {
    const draws = ['ABCDEFGHIEXAMPLE', 'ABCDEFGHIJKLMNOP'];
    const value = detectable('X', 'A', 16, 3, {
      draw: () => draws.shift() ?? '',
      reject: /EXAMPLE$/,
    });
    expect(value).toBe('XABCDEFGHIJKLMNOP');
  });

  it('fails loudly instead of looping forever on an impossible floor', () => {
    expect(() => detectable('', 'a', 8, 3)).toThrow(/after 1000 draws/);
  });

  it('every generated set clears every floor with margin (2 000 sets)', () => {
    for (let i = 0; i < 2000; i++) {
      for (const plant of syntheticSet()) {
        const floor = RULE_ENTROPY[plant.rule as keyof typeof RULE_ENTROPY] as number | undefined;
        if (floor === undefined) continue;
        const value = /"([^"]+)"/.exec(plant.line)?.[1] ?? '';
        expect(shannonEntropy(value), `${plant.rule} ${String(i)}`).toBeGreaterThan(floor);
      }
      expect(shannonEntropy(canary())).toBeGreaterThan(RULE_ENTROPY['ralysa-selftest-canary']);
    }
  });
});

describe('RULE_ENTROPY matches the gitleaks configs', () => {
  type Rules = { rules?: { id: string; entropy?: number }[] };
  const read = (path: string): Rules => parse(readFileSync(join(REAL_ROOT, path), 'utf8'));
  const rules = [
    ...(read('.gitleaks.toml').rules ?? []),
    ...(read('tooling/repo-scripts/vendor/gitleaks-8.30.1-default.toml').rules ?? []),
  ];

  it.each(Object.entries(RULE_ENTROPY))('%s: floor %s', (id, floor) => {
    const rule = rules.find((r) => r.id === id);
    expect(rule, id).toBeDefined();
    // A config floor above ours would let a generated value through that gitleaks then skips.
    expect(rule?.entropy).toBe(floor);
  });
});
