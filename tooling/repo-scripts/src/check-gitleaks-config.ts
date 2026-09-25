// check-gitleaks-config (F-001 design §6.2.2; TC-F-001-38; SEC-F001-05, -24): the two gitleaks
// configs stay what the design says. The artefact config never gets an allow-list; the repo
// config's path allow-list entries are anchored at the repo root and it has no content entries;
// both keep gitleaks' default rules and carry the same custom rules; and no .gitleaksignore file
// (an allow-list outside the configs) is tracked anywhere.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { type Finding, isRecord, listRepoFiles } from './lib/repo.ts';
import { ARTEFACT_CONFIG, REPO_CONFIG } from './secret-scan.ts';

/** The custom rules both configs must define (design §6.2.2). */
export const CUSTOM_RULE_IDS = [
  'azure-openai-key',
  'litellm-key',
  'mistral-api-key',
  'groq-api-key',
  'ralysa-selftest-canary',
] as const;

const ALLOWLIST_KEYS = ['allowlist', 'allowlists'] as const;
const CONTENT_KEYS = ['regexes', 'stopwords', 'commits'] as const;

export interface GitleaksConfigs {
  repo: unknown;
  artefacts: unknown;
}

/** Every allow-list table in a config: top level and per rule, both spellings. */
function allowlistsOf(
  config: Record<string, unknown>,
): { where: string; list: Record<string, unknown> }[] {
  const out: { where: string; list: Record<string, unknown> }[] = [];
  const collect = (where: string, owner: Record<string, unknown>): void => {
    for (const key of ALLOWLIST_KEYS) {
      const value = owner[key];
      const lists = Array.isArray(value) ? value : value === undefined ? [] : [value];
      for (const [index, list] of lists.entries()) {
        out.push({
          where: `${where}${key}${Array.isArray(value) ? `[${String(index)}]` : ''}`,
          list: isRecord(list) ? list : {},
        });
      }
    }
  };
  collect('', config);
  const rules = Array.isArray(config.rules) ? config.rules : [];
  for (const rule of rules) {
    if (isRecord(rule)) collect(`rules[${String(rule.id)}].`, rule);
  }
  return out;
}

function customRules(config: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(config.rules) ? config.rules : []).filter(isRecord);
}

export function checkGitleaksConfigs(
  configs: GitleaksConfigs,
  repoFiles: string[] = [],
): Finding[] {
  const findings: Finding[] = [];
  const add = (path: string, message: string): void => {
    findings.push({ rule: 'gitleaks/config', path, message });
  };
  const repo = isRecord(configs.repo) ? configs.repo : undefined;
  const artefacts = isRecord(configs.artefacts) ? configs.artefacts : undefined;
  if (repo === undefined) add(REPO_CONFIG, 'not a TOML table');
  if (artefacts === undefined) add(ARTEFACT_CONFIG, 'not a TOML table');
  if (repo === undefined || artefacts === undefined) return findings;

  for (const [file, config] of [
    [REPO_CONFIG, repo],
    [ARTEFACT_CONFIG, artefacts],
  ] as const) {
    const extend = isRecord(config.extend) ? config.extend : {};
    if (extend.useDefault !== true) {
      add(file, '[extend] useDefault = true is required: the default rules must stay on');
    }
    if (extend.path !== undefined || extend.url !== undefined) {
      add(file, '[extend] may not load another config file: it could bring an allow-list with it');
    }
    const ids = customRules(config).map((rule) => rule.id);
    for (const id of CUSTOM_RULE_IDS) {
      if (!ids.includes(id)) add(file, `custom rule "${id}" is missing (SEC-F001-24)`);
    }
    for (const rule of customRules(config)) {
      const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
      if (keywords.length === 0 || typeof rule.entropy !== 'number' || rule.entropy < 3) {
        add(
          file,
          `custom rule "${String(rule.id)}" needs keywords and an entropy floor of at least 3`,
        );
      }
    }
  }

  // The artefact config: no allow-list, ever, and no rule switched off (SEC-F001-05).
  for (const { where } of allowlistsOf(artefacts)) {
    add(ARTEFACT_CONFIG, `has an allow-list (${where}); the artefact config must never have one`);
  }
  const extend = isRecord(artefacts.extend) ? artefacts.extend : {};
  if (Array.isArray(extend.disabledRules) && extend.disabledRules.length > 0) {
    add(
      ARTEFACT_CONFIG,
      '[extend] disabledRules would switch default rules off for the artefact scan',
    );
  }

  // The repo config: path entries anchored at the repo root; no content entries.
  for (const { where, list } of allowlistsOf(repo)) {
    const paths = Array.isArray(list.paths) ? list.paths : [];
    for (const path of paths) {
      if (typeof path !== 'string' || !path.startsWith('^')) {
        add(
          REPO_CONFIG,
          `${where}.paths entry ${JSON.stringify(path)} must be anchored at the repo root with ^`,
        );
      }
    }
    for (const key of CONTENT_KEYS) {
      if (Array.isArray(list[key]) && list[key].length > 0) {
        add(REPO_CONFIG, `${where}.${key} is a content allow-list; the design allows none`);
      }
    }
  }

  // Same custom rules in both files.
  if (JSON.stringify(customRules(repo)) !== JSON.stringify(customRules(artefacts))) {
    add(
      ARTEFACT_CONFIG,
      `its [[rules]] differ from ${REPO_CONFIG}; the two custom rule sets must be identical`,
    );
  }

  for (const file of repoFiles) {
    if (basename(file) === '.gitleaksignore') {
      add(
        file,
        '.gitleaksignore is an allow-list outside the configs; the configs are the only allow-list',
      );
    }
  }
  return findings;
}

export function checkGitleaksConfigFiles(root: string): Finding[] {
  const configs: Partial<Record<'repo' | 'artefacts', unknown>> = {};
  const findings: Finding[] = [];
  for (const [key, file] of [
    ['repo', REPO_CONFIG],
    ['artefacts', ARTEFACT_CONFIG],
  ] as const) {
    const path = join(root, file);
    if (!existsSync(path)) {
      findings.push({ rule: 'gitleaks/config', path: file, message: 'missing' });
      continue;
    }
    try {
      configs[key] = parseToml(readFileSync(path, 'utf8'));
    } catch (error) {
      findings.push({
        rule: 'gitleaks/config',
        path: file,
        message: `not valid TOML: ${String(error)}`,
      });
    }
  }
  if (findings.length > 0) return findings;
  return checkGitleaksConfigs(
    { repo: configs.repo, artefacts: configs.artefacts },
    listRepoFiles(root),
  );
}
