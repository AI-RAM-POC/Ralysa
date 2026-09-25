// i18n catalog contract (F-001 design §3.3). The repo check `check-i18n` (@ralysa/repo-scripts)
// enforces the same key grammar and locales on every catalog; test/i18n-contract.test.ts keeps the
// two in step.

export const LOCALES = ['en', 'ar'] as const; // en = source language
export type Locale = (typeof LOCALES)[number];
export const SOURCE_LOCALE = 'en' satisfies Locale;
export type SecondaryLocale = Exclude<Locale, typeof SOURCE_LOCALE>;

export const NAMESPACES = ['ui', 'web', 'lab'] as const; // ui = design system, web = apps/web shell, lab = apps/ui-lab
export type Namespace = (typeof NAMESPACES)[number];

/** 2–5 semantic segments, lowerCamel (plural suffixes `_one`, `_other`, … are stripped first). */
export const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,4}$/;

/** Intl.PluralRules / CLDR categories per locale. */
export const PLURAL_CATEGORIES = {
  en: ['one', 'other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
} as const satisfies Record<Locale, readonly Intl.LDMLPluralRule[]>;

// Catalog file: <package>/[src/]locales/<locale>/<namespace>.json (nested objects; keySeparator
// ".", nsSeparator ":"). Usage: t('ui:textField.error.required'); plural keys: "<key>_<category>".

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
