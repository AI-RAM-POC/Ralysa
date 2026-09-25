// check-gitleaks-config (F-001 design §6.2.2; TC-F-001-38; SEC-F001-05, -24; T05-1 decision):
// the two gitleaks configs stay what they must be.
// - .gitleaks.toml (repository scans) keeps gitleaks' default rules through
//   [extend] useDefault = true, loads no other config, anchors any path allow-list entry at the
//   repo root and has no content allow-list.
// - .gitleaks.artefacts.toml (shipped artefacts) has NO [extend] and NO allow-list of any kind,
//   so it inherits nothing, in particular not the default config's global path allow-list. It
//   holds our custom rules (identical to the repo config's) plus a verbatim copy of the
//   high-value default rules, which must match the vendored gitleaks 8.30.1 default field by
//   field, so a gitleaks upgrade shows up as drift.
// - No .gitleaksignore (an allow-list outside the configs) is tracked anywhere.
import { createHash } from 'node:crypto';
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

/**
 * The default rules the artefact config must carry, copied from the vendored default (T05-1).
 * generic-api-key is left out on purpose: without its stopword allow-list it is too noisy on
 * real bundles (implementation-notes T05-1). gitleaks 8.30.1 has no dedicated GCP
 * service-account rule; those keys are JSON around a PEM block, which private-key covers.
 */
export const COPIED_DEFAULT_RULE_IDS = [
  'aws-access-token',
  'gcp-api-key',
  'azure-ad-client-secret',
  'anthropic-api-key',
  'anthropic-admin-api-key',
  'openai-api-key',
  'github-pat',
  'github-fine-grained-pat',
  'github-oauth',
  'github-app-token',
  'github-refresh-token',
  'gitlab-pat',
  'gitlab-pat-routable',
  'slack-bot-token',
  'slack-user-token',
  'slack-app-token',
  'slack-config-access-token',
  'slack-config-refresh-token',
  'slack-legacy-bot-token',
  'slack-legacy-token',
  'slack-legacy-workspace-token',
  'slack-webhook-url',
  'stripe-access-token',
  'private-key',
  'jwt',
] as const;

/** The fields of a copied rule that must equal the vendored default exactly. */
export const SYNCED_RULE_FIELDS = [
  'id',
  'regex',
  'path',
  'secretGroup',
  'entropy',
  'keywords',
] as const;

export const VENDORED_DEFAULT = 'tooling/repo-scripts/vendor/gitleaks-8.30.1-default.toml';
/**
 * sha256 of gitleaks v8.30.1 config/gitleaks.toml (git blob 256f64790ea6d954f0041024be2938089ae1e7a7
 * at the tag), checked 2026-09-25. Also in vendor/SHA256SUMS.
 */
export const VENDORED_DEFAULT_SHA256 =
  'e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf';

/**
 * The keys each table may have, in their exact spelling (code review finding 1). gitleaks reads
 * its config through viper, which matches keys case-insensitively, so `[Allowlist]`,
 * `[[AllowLists]]`, `[Extend]` or `UseDefault` would take effect in gitleaks while a
 * case-sensitive lookup here saw nothing. So this is an allow-list of exact keys: anything
 * else, including another capitalisation of an allowed key, is a finding.
 */
export const CONFIG_KEYS = {
  repoTop: ['title', 'description', 'rules', 'extend', 'allowlists'],
  artefactTop: ['title', 'description', 'rules'],
  // Only useDefault: disabledRules would switch default rules off in the PR, tree and history
  // scans, and path/url would load another config (finding 2).
  repoExtend: ['useDefault'],
  // Only path entries: no regexes, stopwords, commits, condition or targetRules.
  repoAllowlist: ['description', 'paths'],
  rule: ['id', 'description', 'regex', 'secretGroup', 'entropy', 'keywords', 'path', 'tags'],
} as const;

/**
 * A repo allow-list path entry must be one exact file: `^`, a literal repo-relative path (letters,
 * digits, `_ @ / -` and escaped dots only), then `$`. `^.*`, `^.*\.env$` or a directory prefix
 * would silence far more than one reviewed file (finding 3). The first character may be an
 * escaped dot too, for dot-folders such as `^\.github/fixtures/sample\.txt$` (round 2).
 */
export const ANCHORED_LITERAL_PATH = /^\^(?:[A-Za-z0-9_@-]|\\\.)(?:[A-Za-z0-9_@/-]|\\\.)*\$$/;

type Add = (path: string, message: string) => void;

/** Reports every key of `table` that isn't in `allowed` with that exact spelling. */
function checkKeys(
  file: string,
  where: string,
  table: Record<string, unknown>,
  allowed: readonly string[],
  add: Add,
  explain: (key: string) => string | undefined = () => undefined,
): void {
  for (const key of Object.keys(table)) {
    if (allowed.includes(key)) continue;
    const sameLetters = allowed.find((a) => a.toLowerCase() === key.toLowerCase());
    const reason =
      explain(key.toLowerCase()) ??
      (sameLetters === undefined
        ? `allowed keys are ${allowed.join(', ')}`
        : `gitleaks matches keys case-insensitively; write it exactly as "${sameLetters}"`);
    add(file, `${where}"${key}" is not an allowed key: ${reason}`);
  }
}

function tablesOf(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(isRecord) ? value : undefined;
}

function checkRules(file: string, config: Record<string, unknown>, add: Add): void {
  if (config.rules === undefined) return;
  const rules = tablesOf(config.rules);
  if (rules === undefined) {
    add(file, '"rules" must be an array of [[rules]] tables');
    return;
  }
  for (const rule of rules) {
    checkKeys(file, `rules[${String(rule.id)}].`, rule, CONFIG_KEYS.rule, add, (key) =>
      key === 'allowlist' || key === 'allowlists'
        ? 'a rule-level allow-list silences findings; neither config may have one'
        : undefined,
    );
  }
}

function checkRepoSchema(repo: Record<string, unknown>, add: Add): void {
  checkKeys(REPO_CONFIG, '', repo, CONFIG_KEYS.repoTop, add, (key) =>
    key === 'allowlist' ? 'use [[allowlists]] with exact anchored paths only' : undefined,
  );
  checkRules(REPO_CONFIG, repo, add);

  const extend = repo.extend;
  if (!isRecord(extend)) {
    add(REPO_CONFIG, '[extend] useDefault = true is required: the default rules must stay on');
  } else {
    checkKeys(REPO_CONFIG, 'extend.', extend, CONFIG_KEYS.repoExtend, add, (key) => {
      if (key === 'disabledrules')
        return 'it would switch default rules off in the PR, tree and history scans';
      if (key === 'path' || key === 'url')
        return 'it would load another config file, which could bring an allow-list';
      return undefined;
    });
    if (extend.useDefault !== true) {
      add(REPO_CONFIG, '[extend] useDefault = true is required: the default rules must stay on');
    }
  }

  if (repo.allowlists !== undefined) {
    const lists = tablesOf(repo.allowlists);
    if (lists === undefined) {
      add(REPO_CONFIG, '"allowlists" must be an array of [[allowlists]] tables');
      return;
    }
    for (const [index, list] of lists.entries()) {
      const where = `allowlists[${String(index)}]`;
      checkKeys(REPO_CONFIG, `${where}.`, list, CONFIG_KEYS.repoAllowlist, add, (key) =>
        ['regexes', 'stopwords', 'commits'].includes(key)
          ? 'a content allow-list; only exact anchored paths are allowed'
          : undefined,
      );
      const paths = Array.isArray(list.paths) ? (list.paths as unknown[]) : [];
      if (paths.length === 0) add(REPO_CONFIG, `${where} has no paths`);
      for (const path of paths) {
        if (typeof path !== 'string' || !ANCHORED_LITERAL_PATH.test(path)) {
          add(
            REPO_CONFIG,
            `${where}.paths entry ${JSON.stringify(path)} must be one exact file anchored at the repo root: ^literal/path$ (escaped dots only, no wildcards)`,
          );
        }
      }
    }
  }
}

function checkArtefactSchema(artefacts: Record<string, unknown>, add: Add): void {
  checkKeys(ARTEFACT_CONFIG, '', artefacts, CONFIG_KEYS.artefactTop, add, (key) => {
    if (key === 'extend')
      return "the artefact config must not have [extend] in any spelling: useDefault would inherit gitleaks' global allow-list (node_modules, images, fonts, vendor bundles), and path/url could load one";
    if (key === 'allowlist' || key === 'allowlists')
      return 'the artefact config must never have an allow-list, in any spelling';
    return undefined;
  });
  checkRules(ARTEFACT_CONFIG, artefacts, add);
}

export interface GitleaksConfigs {
  repo: unknown;
  artefacts: unknown;
  /** The parsed vendored default config. */
  vendoredDefault: unknown;
}

function rulesOf(config: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(config.rules) ? config.rules : []).filter(isRecord);
}

/** The synced fields of a rule, in a fixed order, for comparison. */
export function syncedFields(rule: Record<string, unknown>): string {
  return JSON.stringify(SYNCED_RULE_FIELDS.map((field) => [field, rule[field] ?? null]));
}

function isCustom(id: unknown): boolean {
  return (CUSTOM_RULE_IDS as readonly unknown[]).includes(id);
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
  const vendored = isRecord(configs.vendoredDefault) ? configs.vendoredDefault : undefined;
  if (repo === undefined) add(REPO_CONFIG, 'not a TOML table');
  if (artefacts === undefined) add(ARTEFACT_CONFIG, 'not a TOML table');
  if (vendored === undefined) add(VENDORED_DEFAULT, 'not a TOML table');
  if (repo === undefined || artefacts === undefined || vendored === undefined) return findings;

  // Custom rules: present in both, with keyword context and an entropy floor (SEC-F001-24).
  for (const [file, config] of [
    [REPO_CONFIG, repo],
    [ARTEFACT_CONFIG, artefacts],
  ] as const) {
    const ids = rulesOf(config).map((rule) => rule.id);
    for (const id of CUSTOM_RULE_IDS) {
      if (!ids.includes(id)) add(file, `custom rule "${id}" is missing (SEC-F001-24)`);
    }
    for (const rule of rulesOf(config).filter((r) => isCustom(r.id))) {
      const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
      if (keywords.length === 0 || typeof rule.entropy !== 'number' || rule.entropy < 3) {
        add(
          file,
          `custom rule "${String(rule.id)}" needs keywords and an entropy floor of at least 3`,
        );
      }
    }
  }

  // Strict, exact-case schemas (code review findings 1 to 3).
  checkRepoSchema(repo, add);
  checkArtefactSchema(artefacts, add);
  if (rulesOf(repo).some((rule) => !isCustom(rule.id))) {
    add(REPO_CONFIG, 'only the custom rules belong here; the default rules come from [extend]');
  }

  // Custom rules identical in both files, in the same order.
  const repoCustom = rulesOf(repo).filter((r) => isCustom(r.id));
  const artefactCustom = rulesOf(artefacts).filter((r) => isCustom(r.id));
  if (JSON.stringify(repoCustom) !== JSON.stringify(artefactCustom)) {
    add(
      ARTEFACT_CONFIG,
      `its custom [[rules]] differ from ${REPO_CONFIG}; the two custom rule sets must be identical`,
    );
  }

  // Copied rules: each required one present, and every non-custom rule equal to the vendored
  // default in id, regex, path, secretGroup, entropy and keywords.
  const defaults = new Map(rulesOf(vendored).map((rule) => [rule.id, rule]));
  const artefactIds = rulesOf(artefacts).map((rule) => rule.id);
  for (const id of COPIED_DEFAULT_RULE_IDS) {
    if (!artefactIds.includes(id)) add(ARTEFACT_CONFIG, `copied default rule "${id}" is missing`);
  }
  for (const rule of rulesOf(artefacts).filter((r) => !isCustom(r.id))) {
    const original = defaults.get(rule.id);
    if (original === undefined) {
      add(
        ARTEFACT_CONFIG,
        `rule "${String(rule.id)}" is neither a custom rule nor in the vendored gitleaks default`,
      );
    } else if (syncedFields(rule) !== syncedFields(original)) {
      add(
        ARTEFACT_CONFIG,
        `rule "${String(rule.id)}" drifted from ${VENDORED_DEFAULT} (${SYNCED_RULE_FIELDS.join(', ')} must match exactly)`,
      );
    }
  }
  if (new Set(artefactIds).size !== artefactIds.length) {
    add(ARTEFACT_CONFIG, 'duplicate rule ids');
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

/** The vendored default must be the pinned file (sha256 in code and in vendor/SHA256SUMS). */
export function checkVendoredDefault(root: string): Finding[] {
  const add = (message: string): Finding[] => [
    { rule: 'gitleaks/vendored-default', path: VENDORED_DEFAULT, message },
  ];
  const path = join(root, VENDORED_DEFAULT);
  if (!existsSync(path)) return add('missing');
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== VENDORED_DEFAULT_SHA256) {
    return add(`sha256 ${actual} is not the pinned ${VENDORED_DEFAULT_SHA256} (gitleaks 8.30.1)`);
  }
  const sums = join(root, 'tooling/repo-scripts/vendor/SHA256SUMS');
  const listed = existsSync(sums) ? readFileSync(sums, 'utf8') : '';
  if (!listed.includes(`${VENDORED_DEFAULT_SHA256}  ${basename(VENDORED_DEFAULT)}`)) {
    return add('vendor/SHA256SUMS does not record the pinned sha256');
  }
  return [];
}

export function checkGitleaksConfigFiles(root: string): Finding[] {
  const vendoredFindings = checkVendoredDefault(root);
  if (vendoredFindings.length > 0) return vendoredFindings;
  const parsed: Partial<Record<'repo' | 'artefacts' | 'vendoredDefault', unknown>> = {};
  const findings: Finding[] = [];
  for (const [key, file] of [
    ['repo', REPO_CONFIG],
    ['artefacts', ARTEFACT_CONFIG],
    ['vendoredDefault', VENDORED_DEFAULT],
  ] as const) {
    const path = join(root, file);
    if (!existsSync(path)) {
      findings.push({ rule: 'gitleaks/config', path: file, message: 'missing' });
      continue;
    }
    try {
      parsed[key] = parseToml(readFileSync(path, 'utf8'));
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
    { repo: parsed.repo, artefacts: parsed.artefacts, vendoredDefault: parsed.vendoredDefault },
    listRepoFiles(root),
  );
}
