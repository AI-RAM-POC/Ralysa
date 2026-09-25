// TC-F-001-38, config part (SEC-F001-05, -24): check-gitleaks-config fails on an artefact
// config with an allow-list, an unanchored path allow-list, diverging custom rules, and the other
// ways a config could silence a finding.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { checkGitleaksConfigFiles, checkGitleaksConfigs } from '../src/check-gitleaks-config.ts';
import { REAL_ROOT } from './repo-copy.ts';

const realRepo = readFileSync(join(REAL_ROOT, '.gitleaks.toml'), 'utf8');
const realArtefacts = readFileSync(join(REAL_ROOT, '.gitleaks.artefacts.toml'), 'utf8');

function check(repo = realRepo, artefacts = realArtefacts, repoFiles: string[] = []): string[] {
  return checkGitleaksConfigs({ repo: parse(repo), artefacts: parse(artefacts) }, repoFiles).map(
    (f) => `${f.path}: ${f.message}`,
  );
}

describe('check-gitleaks-config', () => {
  it('passes the real configs and repository', () => {
    expect(checkGitleaksConfigFiles(REAL_ROOT)).toEqual([]);
    expect(check()).toEqual([]);
  });

  describe('the artefact config never has an allow-list', () => {
    it.each([
      ['[allowlist]', "\n[allowlist]\npaths = ['''^dist/''']\n"],
      ['[[allowlists]]', "\n[[allowlists]]\npaths = ['''^dist/''']\n"],
      ['an empty [allowlist]', '\n[allowlist]\n'],
      ['a rule-level [[rules.allowlists]]', "\n[[rules.allowlists]]\nregexes = ['''x''']\n"],
    ])('fails on %s', (_, extra) => {
      const findings = check(realRepo, realArtefacts + extra);
      expect(
        findings.some((f) => f.startsWith('.gitleaks.artefacts.toml: has an allow-list')),
      ).toBe(true);
    });

    it('fails on [extend] disabledRules', () => {
      const artefacts = realArtefacts.replace(
        'useDefault = true',
        'useDefault = true\ndisabledRules = ["aws-access-token"]',
      );
      expect(check(realRepo, artefacts)).toContain(
        '.gitleaks.artefacts.toml: [extend] disabledRules would switch default rules off for the artefact scan',
      );
    });
  });

  describe('the repository config', () => {
    it('fails on an unanchored path entry and passes an anchored one', () => {
      expect(check(`${realRepo}\n[allowlist]\npaths = ['''dist/''']\n`).join('\n')).toMatch(
        /paths entry "dist\/" must be anchored at the repo root/,
      );
      expect(check(`${realRepo}\n[[allowlists]]\npaths = ['''^apps/web/fixtures/''']\n`)).toEqual(
        [],
      );
    });

    it.each(['regexes', 'stopwords', 'commits'])('fails on a content allow-list (%s)', (key) => {
      expect(check(`${realRepo}\n[allowlist]\n${key} = ['''x''']\n`).join('\n')).toMatch(
        new RegExp(`allowlist\\.${key} is a content allow-list`),
      );
    });
  });

  it('fails when the custom rule sets differ', () => {
    const artefacts = realArtefacts.replace(
      'entropy = 3.5\nkeywords = ["mistral"]',
      'entropy = 3.6\nkeywords = ["mistral"]',
    );
    expect(artefacts).not.toBe(realArtefacts);
    expect(check(realRepo, artefacts)).toContain(
      '.gitleaks.artefacts.toml: its [[rules]] differ from .gitleaks.toml; the two custom rule sets must be identical',
    );
  });

  it('fails when a custom rule is missing from both', () => {
    const drop = (text: string) =>
      text.replace(/\[\[rules\]\]\nid = "groq-api-key"[\s\S]*?keywords = \["gsk_"\]\n/, '');
    const findings = check(drop(realRepo), drop(realArtefacts));
    expect(findings).toContain(
      '.gitleaks.toml: custom rule "groq-api-key" is missing (SEC-F001-24)',
    );
    expect(findings).toContain(
      '.gitleaks.artefacts.toml: custom rule "groq-api-key" is missing (SEC-F001-24)',
    );
  });

  it('fails when a custom rule has no keywords or entropy floor', () => {
    const weaken = (text: string) =>
      text.replace('entropy = 3.5\nkeywords = ["gsk_"]', 'entropy = 1.0\nkeywords = ["gsk_"]');
    expect(check(weaken(realRepo), weaken(realArtefacts))).toContain(
      '.gitleaks.toml: custom rule "groq-api-key" needs keywords and an entropy floor of at least 3',
    );
  });

  it.each([
    ['useDefault = false', 'useDefault = true is required'],
    ['useDefault = true\npath = "other.toml"', 'may not load another config file'],
  ])('fails on [extend] %s', (replacement, message) => {
    const findings = check(realRepo, realArtefacts.replace('useDefault = true', replacement));
    expect(findings.join('\n')).toContain(message);
    expect(
      check(realRepo.replace('useDefault = true', replacement), realArtefacts).join('\n'),
    ).toContain(message);
  });

  it('fails on a tracked .gitleaksignore anywhere', () => {
    expect(
      check(realRepo, realArtefacts, [
        '.gitleaksignore',
        'apps/web/public/.gitleaksignore',
        'docs/x.md',
      ]),
    ).toEqual([
      '.gitleaksignore: .gitleaksignore is an allow-list outside the configs; the configs are the only allow-list',
      'apps/web/public/.gitleaksignore: .gitleaksignore is an allow-list outside the configs; the configs are the only allow-list',
    ]);
  });
});
