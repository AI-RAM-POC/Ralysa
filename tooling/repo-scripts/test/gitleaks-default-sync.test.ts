// T05-1 decision: the artefact config copies high-value rules from gitleaks 8.30.1's default
// config instead of inheriting it (and its global allow-list) through [extend]. This test pins
// the vendored default by sha256 and asserts every copied rule's id, regex, keywords and entropy
// (and path and secretGroup) match it exactly, so a gitleaks upgrade shows up as drift.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  COPIED_DEFAULT_RULE_IDS,
  CUSTOM_RULE_IDS,
  VENDORED_DEFAULT,
  VENDORED_DEFAULT_SHA256,
} from '../src/check-gitleaks-config.ts';
import { HASH_FILE } from '../src/secret-scan.ts';
import { REAL_ROOT } from './repo-copy.ts';

type Rule = Record<string, unknown>;

const vendoredText = readFileSync(join(REAL_ROOT, VENDORED_DEFAULT));
const vendored = parse(vendoredText.toString('utf8')) as { rules: Rule[] };
const artefacts = parse(
  readFileSync(join(REAL_ROOT, '.gitleaks.artefacts.toml'), 'utf8'),
) as Record<string, unknown> & { rules: Rule[] };

describe('artefact config ↔ vendored gitleaks 8.30.1 default', () => {
  it('the vendored file is the pinned gitleaks 8.30.1 config/gitleaks.toml', () => {
    expect(createHash('sha256').update(vendoredText).digest('hex')).toBe(VENDORED_DEFAULT_SHA256);
    expect(readFileSync(join(REAL_ROOT, 'tooling/repo-scripts/vendor/SHA256SUMS'), 'utf8')).toBe(
      `${VENDORED_DEFAULT_SHA256}  gitleaks-8.30.1-default.toml\n`,
    );
    // The vendored default and the installed binary are the same gitleaks version.
    expect(readFileSync(join(REAL_ROOT, HASH_FILE), 'utf8')).toMatch(/^gitleaks 8\.30\.1 /m);
  });

  it.each([...COPIED_DEFAULT_RULE_IDS])('%s matches the default exactly', (id) => {
    const original = vendored.rules.find((rule) => rule.id === id);
    const copy = artefacts.rules.find((rule) => rule.id === id);
    expect(original, `${id} in the vendored default`).toBeDefined();
    expect(copy, `${id} in .gitleaks.artefacts.toml`).toBeDefined();
    for (const field of ['id', 'regex', 'keywords', 'entropy', 'path', 'secretGroup']) {
      expect(copy?.[field], `${id}.${field}`).toStrictEqual(original?.[field]);
    }
    // The copy drops the rule-level allow-lists: the artefact config has none (SEC-F001-05).
    expect(copy?.allowlists).toBeUndefined();
    expect(copy?.allowlist).toBeUndefined();
  });

  it('holds exactly the custom rules plus the copied ones, and no [extend] or global allow-list', () => {
    expect(artefacts.rules.map((rule) => rule.id)).toEqual([
      ...CUSTOM_RULE_IDS,
      ...COPIED_DEFAULT_RULE_IDS,
    ]);
    expect(artefacts.extend).toBeUndefined();
    expect(artefacts.allowlist).toBeUndefined();
    expect(artefacts.allowlists).toBeUndefined();
  });

  it('generic-api-key is deliberately not copied (too noisy without its stopwords)', () => {
    expect(vendored.rules.some((rule) => rule.id === 'generic-api-key')).toBe(true);
    expect(artefacts.rules.some((rule) => rule.id === 'generic-api-key')).toBe(false);
  });
});
