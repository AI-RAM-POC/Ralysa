// TC-F-001-38, config part (SEC-F001-05, -24; T05-1 decision): check-gitleaks-config fails on an
// artefact config that gains [extend] or any allow-list, an unanchored repo path allow-list,
// diverging custom rules, copied rules that drift from the vendored gitleaks default, and a
// vendored default that isn't the pinned file.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  VENDORED_DEFAULT,
  checkGitleaksConfigFiles,
  checkGitleaksConfigs,
  checkVendoredDefault,
} from '../src/check-gitleaks-config.ts';
import { REAL_ROOT } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const realRepo = readFileSync(join(REAL_ROOT, '.gitleaks.toml'), 'utf8');
const realArtefacts = readFileSync(join(REAL_ROOT, '.gitleaks.artefacts.toml'), 'utf8');
const vendoredDefault = parse(readFileSync(join(REAL_ROOT, VENDORED_DEFAULT), 'utf8'));

function check(repo = realRepo, artefacts = realArtefacts, repoFiles: string[] = []): string[] {
  return checkGitleaksConfigs(
    { repo: parse(repo), artefacts: parse(artefacts), vendoredDefault },
    repoFiles,
  ).map((f) => `${f.path}: ${f.message}`);
}

const A = '.gitleaks.artefacts.toml';

/** Inserts top-level TOML before the first [[rules]] (a function replacement: no `$` patterns). */
const beforeRules = (text: string, table: string): string =>
  text.replace('\n[[rules]]', () => `\n${table}\n[[rules]]`);

describe('check-gitleaks-config', () => {
  it('passes the real configs and repository', () => {
    expect(checkGitleaksConfigFiles(REAL_ROOT)).toEqual([]);
    expect(check()).toEqual([]);
  });

  describe('the artefact config inherits nothing and never has an allow-list', () => {
    it.each([
      ['[extend] useDefault = true', '[extend]\nuseDefault = true\n'],
      ['[extend] path', '[extend]\npath = "other.toml"\n'],
      ['an empty [extend]', '[extend]\n'],
    ])('fails on %s', (_, extend) => {
      // [extend] must come before the first [[rules]] table to stay top-level.
      const artefacts = beforeRules(realArtefacts, extend);
      expect(check(realRepo, artefacts).join('\n')).toContain(`${A}: must not have [extend]`);
    });

    it.each([
      ['a global [allowlist] with paths', "[allowlist]\npaths = ['''^node_modules/''']\n"],
      ['[[allowlists]]', "[[allowlists]]\npaths = ['''(?i)\\.svg$''']\n"],
      ['an empty [allowlist]', '[allowlist]\n'],
    ])('fails on %s', (_, table) => {
      const artefacts = beforeRules(realArtefacts, table);
      expect(check(realRepo, artefacts).join('\n')).toContain(`${A}: has an allow-list`);
    });

    it('fails on a rule-level allow-list (the defaults carry some; the copy must not)', () => {
      const findings = check(
        realRepo,
        `${realArtefacts}\n[[rules.allowlists]]\nregexes = ['''x''']\n`,
      );
      expect(findings.join('\n')).toContain(`${A}: has an allow-list (rules[jwt].allowlists[0])`);
    });
  });

  describe('copied default rules stay in sync with the vendored gitleaks 8.30.1 default', () => {
    it('fails when a copied rule changes its regex', () => {
      const changed = realArtefacts.replace(
        /(id = "aws-access-token"[\s\S]*?regex = ''')[^\n]*'''/,
        "$1\\b(AKIA[A-Z2-7]{16})\\b'''",
      );
      expect(changed).not.toBe(realArtefacts);
      expect(check(realRepo, changed).join('\n')).toContain('rule "aws-access-token" drifted from');
    });

    it('fails when a copied rule changes its entropy', () => {
      const changed = realArtefacts.replace(
        /(id = "aws-access-token"[\s\S]*?)entropy = 3\.0/,
        '$1entropy = 2.0',
      );
      expect(changed).not.toBe(realArtefacts);
      expect(check(realRepo, changed).join('\n')).toContain('rule "aws-access-token" drifted from');
    });

    it('fails when a copied rule changes its keywords', () => {
      const changed = realArtefacts.replace(
        /(id = "github-pat"[\s\S]*?keywords = )\[[^\]]*\]/,
        '$1["ghp_", "extra"]',
      );
      expect(changed).not.toBe(realArtefacts);
      expect(check(realRepo, changed).join('\n')).toContain('rule "github-pat" drifted from');
    });

    it('fails when a required copied rule is removed', () => {
      const changed = realArtefacts.replace(/\[\[rules\]\]\nid = "private-key"[\s\S]*?\n\n/, '');
      expect(changed).not.toBe(realArtefacts);
      expect(check(realRepo, changed)).toContain(
        `${A}: copied default rule "private-key" is missing`,
      );
    });

    it('fails on a rule that is neither custom nor in the vendored default', () => {
      const extra = `${realArtefacts}\n[[rules]]\nid = "home-made"\nregex = '''x{40}'''\nkeywords = ["x"]\n`;
      expect(check(realRepo, extra)).toContain(
        `${A}: rule "home-made" is neither a custom rule nor in the vendored gitleaks default`,
      );
    });
  });

  describe('the vendored default file', () => {
    function fixture(edit?: (text: string) => string): string {
      const root = makeTempDir('ralysa-vendored-');
      for (const file of [VENDORED_DEFAULT, 'tooling/repo-scripts/vendor/SHA256SUMS']) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        copyFileSync(join(REAL_ROOT, file), join(root, file));
      }
      if (edit) {
        const path = join(root, VENDORED_DEFAULT);
        writeFileSync(path, edit(readFileSync(path, 'utf8')));
      }
      return root;
    }

    it('passes when it is the pinned file', () => {
      expect(checkVendoredDefault(fixture())).toEqual([]);
    });

    it('fails when its content changes (so the copied rules can’t be synced to an edited copy)', () => {
      const [finding] = checkVendoredDefault(
        fixture((t) => t.replace('entropy = 3', 'entropy = 1')),
      );
      expect(finding?.message).toMatch(/is not the pinned e163e53b/);
    });
  });

  describe('the custom rules', () => {
    it('fails when the custom rule sets differ', () => {
      const artefacts = realArtefacts.replace(
        'entropy = 3.5\nkeywords = ["mistral"]',
        'entropy = 3.6\nkeywords = ["mistral"]',
      );
      expect(artefacts).not.toBe(realArtefacts);
      expect(check(realRepo, artefacts)).toContain(
        `${A}: its custom [[rules]] differ from .gitleaks.toml; the two custom rule sets must be identical`,
      );
    });

    it('fails when a custom rule is missing from both', () => {
      const drop = (text: string) =>
        text.replace(/\[\[rules\]\]\nid = "groq-api-key"[\s\S]*?keywords = \["gsk_"\]\n/, '');
      const findings = check(drop(realRepo), drop(realArtefacts));
      expect(findings).toContain(
        '.gitleaks.toml: custom rule "groq-api-key" is missing (SEC-F001-24)',
      );
      expect(findings).toContain(`${A}: custom rule "groq-api-key" is missing (SEC-F001-24)`);
    });

    it('fails when a custom rule has no keywords or entropy floor', () => {
      const weaken = (text: string) =>
        text.replace('entropy = 3.5\nkeywords = ["gsk_"]', 'entropy = 1.0\nkeywords = ["gsk_"]');
      expect(check(weaken(realRepo), weaken(realArtefacts))).toContain(
        '.gitleaks.toml: custom rule "groq-api-key" needs keywords and an entropy floor of at least 3',
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

    it.each([
      ['useDefault = false', 'useDefault = true is required'],
      ['useDefault = true\npath = "other.toml"', 'may not load another config file'],
    ])('fails on [extend] %s', (replacement, message) => {
      expect(check(realRepo.replace('useDefault = true', replacement)).join('\n')).toContain(
        message,
      );
    });
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
