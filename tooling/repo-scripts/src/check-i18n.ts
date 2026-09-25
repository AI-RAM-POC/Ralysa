// check-i18n (F-001 design §7.4.5; AC-6, TC-F-001-12): the catalog checks that i18next-cli
// doesn't do. For every UI workspace (`ralysa.ui: true`) that has catalogs:
//   - locale folders are exactly LOCALES, and every locale has the same namespace files
//   - identical key sets in every locale, after plural expansion: a key with en `_one`/`_other`
//     must have every CLDR category of each locale (all six for ar)
//   - key grammar (KEY_RE on the key without its plural suffix), no empty or non-string values
//   - the same {{interpolation}} names in every locale
//   - every secondary-locale key has a native-review entry in <locales>/review.json (OQ-D8), and
//     the file names no key that doesn't exist
//   - warning (not a failure): a secondary value equal to the en value that contains Latin
//     letters (probably untranslated)
//   - the workspace runs `i18next-cli extract --ci` in lint and `i18next-cli types` in
//     check:generated, and has an i18next.config.ts
// The constants mirror packages/ui/src/contracts/i18n.ts; a @ralysa/ui test asserts they match.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, isRecord, listWorkspaceDirs, readJson } from './lib/core.ts';

export const LOCALES = ['en', 'ar'] as const;
export const SOURCE_LOCALE = 'en';
export const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,4}$/;
export const NAMESPACE_RE = /^[a-z][a-zA-Z0-9]*$/;
export const REVIEW_FILE = 'review.json';
export const NEEDS_REVIEW = 'needs-native-review';
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const LOCALE_ROOTS = ['locales', 'src/locales'];

export interface I18nReport {
  findings: Finding[];
  warnings: Finding[];
  /** Secondary-locale strings still marked needs-native-review, per catalog folder. */
  needsReview: Record<string, number>;
}

/** Flattens nested catalog objects to dotted keys; non-string leaves are reported. */
export function flattenCatalog(
  value: unknown,
  onProblem: (key: string, problem: string) => void,
  prefix = '',
): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(value)) {
    onProblem(prefix || '(root)', 'must be an object of strings');
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof child === 'string') out.set(path, child);
    else if (isRecord(child)) {
      for (const [k, v] of flattenCatalog(child, onProblem, path)) out.set(k, v);
    } else onProblem(path, `must be a string or an object, not ${JSON.stringify(child)}`);
  }
  return out;
}

export function pluralCategories(locale: string): string[] {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

function interpolations(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([^,}\s]+)[^}]*\}\}/g)].map((match) => match[1] ?? '').sort();
}

interface ParsedLocale {
  /** namespace → flattened keys. */
  namespaces: Map<string, Map<string, string>>;
}

export interface CatalogInput {
  /** Reported path of the catalog folder, e.g. "packages/ui/src/locales". */
  dir: string;
  /** locale → namespace → parsed JSON. */
  locales: Record<string, Record<string, unknown>>;
  /** Parsed review.json, or undefined if the file doesn't exist. */
  review: unknown;
}

/** Checks one catalog folder. Pure: tests pass the parsed files in. */
export function checkCatalogs({ dir, locales, review }: CatalogInput): I18nReport {
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const add = (rule: string, path: string, message: string): void => {
    findings.push({ rule, path, message });
  };

  const present = Object.keys(locales).sort();
  const expected = [...LOCALES].sort();
  if (present.join() !== expected.join()) {
    add(
      'i18n/locales',
      dir,
      `locale folders are [${present.join(', ')}]; expected [${expected.join(', ')}]`,
    );
  }

  const parsed = new Map<string, ParsedLocale>();
  for (const locale of LOCALES) {
    const files = locales[locale] ?? {};
    const namespaces = new Map<string, Map<string, string>>();
    for (const [namespace, content] of Object.entries(files)) {
      const file = `${dir}/${locale}/${namespace}.json`;
      if (!NAMESPACE_RE.test(namespace))
        add('i18n/namespace-name', file, 'namespace file names are lowerCamel');
      namespaces.set(
        namespace,
        flattenCatalog(content, (key, problem) => {
          add('i18n/value', file, `${key} ${problem}`);
        }),
      );
    }
    parsed.set(locale, { namespaces });
  }

  const source = parsed.get(SOURCE_LOCALE);
  const allNamespaces = new Set([...parsed.values()].flatMap((p) => [...p.namespaces.keys()]));
  const secondaryKeys: string[] = [];

  for (const namespace of [...allNamespaces].sort()) {
    const en = source?.namespaces.get(namespace);
    for (const locale of LOCALES) {
      if (!parsed.get(locale)?.namespaces.has(namespace)) {
        add(
          'i18n/missing-namespace',
          `${dir}/${locale}/${namespace}.json`,
          'missing: every locale needs every namespace',
        );
      }
    }
    if (en === undefined) continue;

    // Base keys (plural suffix stripped) of the source locale, and which of them are plural.
    const enBase = new Map<string, boolean>();
    for (const key of en.keys()) {
      const base = key.replace(PLURAL_SUFFIX, '');
      enBase.set(base, (enBase.get(base) ?? false) || base !== key);
    }

    for (const locale of LOCALES) {
      const keys = parsed.get(locale)?.namespaces.get(namespace);
      if (keys === undefined) continue;
      const file = `${dir}/${locale}/${namespace}.json`;
      const categories = pluralCategories(locale);
      const expectedKeys = new Set<string>();
      for (const [base, plural] of enBase) {
        if (plural) for (const category of categories) expectedKeys.add(`${base}_${category}`);
        else expectedKeys.add(base);
      }
      for (const key of keys.keys()) {
        const base = key.replace(PLURAL_SUFFIX, '');
        if (!KEY_RE.test(base)) {
          add(
            'i18n/key-grammar',
            file,
            `"${key}" doesn't match ${String(KEY_RE)} (2–5 lowerCamel segments)`,
          );
        }
        if (!expectedKeys.has(key)) {
          add(
            'i18n/extra-key',
            file,
            `"${key}" is not in the ${SOURCE_LOCALE} catalog (or isn't a ${locale} plural form of one)`,
          );
        }
      }
      for (const key of expectedKeys) {
        if (!keys.has(key)) add('i18n/missing-key', file, `"${key}" is missing`);
      }
      for (const [key, value] of keys) {
        if (value.trim() === '') add('i18n/empty', file, `"${key}" is empty`);
        const base = key.replace(PLURAL_SUFFIX, '');
        const reference = en.get(key) ?? en.get(`${base}_other`);
        if (
          reference !== undefined &&
          interpolations(value).join() !== interpolations(reference).join()
        ) {
          add(
            'i18n/interpolation',
            file,
            `"${key}" uses {{${interpolations(value).join('}}, {{')}}} but ${SOURCE_LOCALE} uses {{${interpolations(reference).join('}}, {{')}}}`,
          );
        }
        if (locale !== SOURCE_LOCALE) {
          secondaryKeys.push(`${locale}\u0000${namespace}:${key}`);
          if (reference !== undefined && value === reference && /[A-Za-z]/.test(value)) {
            warnings.push({
              rule: 'i18n/untranslated',
              path: file,
              message: `"${key}" equals the ${SOURCE_LOCALE} value "${value}"; check that it is intentionally the same`,
            });
          }
        }
      }
    }
  }

  // Native-review register (OQ-D8).
  const reviewPath = `${dir}/${REVIEW_FILE}`;
  let needsReview = 0;
  if (secondaryKeys.length > 0 && review === undefined) {
    add(
      'i18n/review-file',
      reviewPath,
      `missing: every ${LOCALES.filter((l) => l !== SOURCE_LOCALE).join(', ')} string needs a review entry`,
    );
  } else if (review !== undefined) {
    if (!isRecord(review)) {
      add('i18n/review-file', reviewPath, 'must be an object keyed by locale');
    } else {
      const listed = new Set<string>();
      for (const [locale, entries] of Object.entries(review)) {
        if (locale.startsWith('$')) continue;
        if (!isRecord(entries)) {
          add('i18n/review-file', reviewPath, `"${locale}" must map "ns:key" to a review status`);
          continue;
        }
        for (const [key, status] of Object.entries(entries)) {
          listed.add(`${locale}\u0000${key}`);
          const reviewed =
            isRecord(status) &&
            typeof status.reviewer === 'string' &&
            status.reviewer.trim() !== '' &&
            typeof status.date === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(status.date);
          if (status === NEEDS_REVIEW) needsReview += 1;
          else if (!reviewed) {
            add(
              'i18n/review-status',
              reviewPath,
              `${locale} "${key}": use "${NEEDS_REVIEW}" or { "reviewer": "<name>", "date": "YYYY-MM-DD" }`,
            );
          }
        }
      }
      const expectedEntries = new Set(secondaryKeys);
      for (const entry of expectedEntries) {
        if (!listed.has(entry)) {
          const [locale, key] = entry.split('\u0000');
          add(
            'i18n/review-missing',
            reviewPath,
            `${locale ?? ''} "${key ?? ''}" has no review entry; add "${NEEDS_REVIEW}" until a native speaker approves it`,
          );
        }
      }
      for (const entry of listed) {
        if (!expectedEntries.has(entry)) {
          const [locale, key] = entry.split('\u0000');
          add(
            'i18n/review-stale',
            reviewPath,
            `${locale ?? ''} "${key ?? ''}" is not a key in the catalogs`,
          );
        }
      }
    }
  }
  return { findings, warnings, needsReview: needsReview > 0 ? { [dir]: needsReview } : {} };
}

function readCatalogFolder(root: string, rel: string, findings: Finding[]): CatalogInput {
  const abs = join(root, rel);
  const locales: CatalogInput['locales'] = {};
  for (const entry of readdirSync(abs).sort()) {
    const full = join(abs, entry);
    if (!statSync(full).isDirectory()) continue;
    const files: Record<string, unknown> = {};
    for (const file of readdirSync(full).sort()) {
      if (!file.endsWith('.json')) {
        findings.push({
          rule: 'i18n/stray-file',
          path: `${rel}/${entry}/${file}`,
          message: 'only <namespace>.json files belong in a locale folder',
        });
        continue;
      }
      try {
        files[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(full, file), 'utf8'));
      } catch (error) {
        findings.push({
          rule: 'i18n/json',
          path: `${rel}/${entry}/${file}`,
          message: String(error),
        });
      }
    }
    locales[entry] = files;
  }
  const reviewFile = join(abs, REVIEW_FILE);
  let review: unknown;
  if (existsSync(reviewFile)) {
    try {
      review = readJson(reviewFile);
    } catch (error) {
      findings.push({ rule: 'i18n/json', path: `${rel}/${REVIEW_FILE}`, message: String(error) });
    }
  }
  return { dir: rel, locales, review };
}

/** Every UI workspace with catalogs, or with an i18next config and no catalogs. */
export function checkI18n({ root }: { root: string }): I18nReport {
  const report: I18nReport = { findings: [], warnings: [], needsReview: {} };
  for (const dir of listWorkspaceDirs(root)) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    if (!isRecord(pkg) || !isRecord(pkg.ralysa) || pkg.ralysa.ui !== true) continue;
    if (pkg.ralysa.kind === 'placeholder') continue;

    const catalogDirs = LOCALE_ROOTS.map((r) => `${dir}/${r}`).filter((r) =>
      existsSync(join(root, r)),
    );
    const hasConfig = existsSync(join(root, dir, 'i18next.config.ts'));
    if (catalogDirs.length === 0) {
      if (hasConfig)
        report.findings.push({
          rule: 'i18n/no-catalogs',
          path: dir,
          message: 'has an i18next.config.ts but no locales/ or src/locales/ folder',
        });
      continue;
    }
    if (catalogDirs.length > 1) {
      report.findings.push({
        rule: 'i18n/catalog-folders',
        path: dir,
        message: `use one catalog folder, not ${catalogDirs.join(' and ')}`,
      });
    }
    if (!hasConfig) {
      report.findings.push({
        rule: 'i18n/config',
        path: dir,
        message: 'catalogs need an i18next.config.ts (extract --ci and types)',
      });
    }
    const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
    if (
      typeof scripts.lint !== 'string' ||
      !/i18next-cli extract\b[^&|;]*--ci/.test(scripts.lint)
    ) {
      report.findings.push({
        rule: 'i18n/extract-not-wired',
        path: `${dir}/package.json`,
        message:
          'the lint script must run `i18next-cli extract --ci --dry-run` (a key used in code but missing from a catalog fails lint)',
      });
    }
    const generated = scripts['check:generated'];
    if (typeof generated !== 'string' || !/i18next-cli types\b/.test(generated)) {
      report.findings.push({
        rule: 'i18n/types-not-wired',
        path: `${dir}/package.json`,
        message:
          'the check:generated script must run `i18next-cli types` (typed keys, drift-checked)',
      });
    }

    for (const rel of catalogDirs) {
      const input = readCatalogFolder(root, rel, report.findings);
      const result = checkCatalogs(input);
      report.findings.push(...result.findings);
      report.warnings.push(...result.warnings);
      Object.assign(report.needsReview, result.needsReview);
    }
  }
  return report;
}
