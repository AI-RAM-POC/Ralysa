// TC-F-001-23 (AC-11): every pair in tokens/contrast-pairs.json passes in both themes, using the
// same parsed token model the generator emits; a failing fixture pair fails. The gate itself
// (ratio maths, MIN_RATIO per kind) is @ralysa/repo-scripts check-contrast (TC-F-001-22).
import {
  checkContrast,
  type ContrastColor,
  formatContrastTable,
} from '@ralysa/repo-scripts/check-contrast';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTokenSet, type ResolvedToken, validateTokenSet } from '../scripts/build-tokens.ts';
import { ContrastPairsFile, type Theme } from '../src/contracts/tokens.ts';

const tokensDir = join(fileURLToPath(new URL('..', import.meta.url)), 'tokens');
const PAIRS_FILE = 'packages/ui/tokens/contrast-pairs.json';

const resolved = validateTokenSet(loadTokenSet(tokensDir));
const pairsFile = ContrastPairsFile.parse(
  JSON.parse(readFileSync(join(tokensDir, 'contrast-pairs.json'), 'utf8')),
);

function resolver(
  tokens: Record<Theme, Map<string, ResolvedToken>>,
): (theme: string, token: string) => ContrastColor | undefined {
  return (theme, token) => {
    const found = tokens[theme as Theme].get(token);
    return found?.type === 'color' ? (found.value as ContrastColor) : undefined;
  };
}

describe('contrast gate on the real tokens (AC-11)', () => {
  const { results, findings } = checkContrast({
    pairs: pairsFile.pairs,
    exempt: pairsFile.exempt,
    resolve: resolver(resolved),
    file: PAIRS_FILE,
  });

  it('checks every pair in both themes', () => {
    expect(results).toHaveLength(pairsFile.pairs.length * 2);
  });

  it('passes every pair', () => {
    console.log(
      `contrast results (${String(results.length)} checks)\n${formatContrastTable(results)}`,
    );
    expect(findings).toEqual([]);
  });

  it('lists every semantic colour token in a pair or as exempt', () => {
    const used = new Set([
      ...pairsFile.pairs.flatMap((pair) => [pair.fg, pair.bg]),
      ...pairsFile.exempt.map((entry) => entry.token),
    ]);
    const semanticColours = [...resolved.light.values()]
      .filter((token) => token.type === 'color' && token.path.startsWith('color.'))
      .map((token) => token.path);
    expect(semanticColours.filter((path) => !used.has(path))).toEqual([]);
  });
});

describe('contrast gate on a failing fixture', () => {
  it('fails a pair below its minimum', () => {
    const tokens = validateTokenSet(loadTokenSet(tokensDir));
    const fixture = {
      ...(tokens.light.get('color.fg.muted') as ResolvedToken),
      value: { colorSpace: 'srgb', components: [0.4667, 0.4667, 0.4667], hex: '#777777' },
    };
    tokens.light.set('color.fg.muted', fixture);
    const { findings } = checkContrast({
      pairs: pairsFile.pairs.filter((pair) => pair.fg === 'color.fg.muted'),
      resolve: resolver(tokens),
      file: PAIRS_FILE,
    });
    expect(findings.map((f) => f.rule)).toContain('contrast/below-minimum');
    expect(findings[0]?.message).toMatch(/\[light\]: 4\.48:1 is below 4\.5:1/);
  });

  it('fails a translucent colour in a pair', () => {
    const tokens = validateTokenSet(loadTokenSet(tokensDir));
    const base = tokens.dark.get('color.fg.default') as ResolvedToken;
    tokens.dark.set('color.fg.default', {
      ...base,
      value: { ...(base.value as object), alpha: 0.5 },
    });
    const { findings } = checkContrast({
      pairs: pairsFile.pairs.filter((pair) => pair.fg === 'color.fg.default'),
      resolve: resolver(tokens),
    });
    expect(findings.map((f) => f.rule)).toContain('contrast/translucent');
  });
});
