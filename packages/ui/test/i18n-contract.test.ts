// The §3.3 i18n contract stays in step with the repo check that enforces it, and typed keys make
// an unknown key a type error (T08 definition of done; checked by `typecheck`).
import * as check from '@ralysa/repo-scripts/check-i18n';
import type { i18n as I18n, TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { KEY_RE, LOCALES, PLURAL_CATEGORIES, SOURCE_LOCALE } from '../src/contracts/i18n.ts';

describe('i18n contract', () => {
  it('matches check-i18n (locales, source locale, key grammar)', () => {
    expect([...LOCALES]).toEqual([...check.LOCALES]);
    expect(SOURCE_LOCALE).toBe(check.SOURCE_LOCALE);
    expect(KEY_RE.source).toBe(check.KEY_RE.source);
  });

  it('lists the CLDR plural categories Intl reports', () => {
    for (const locale of LOCALES) {
      expect([...PLURAL_CATEGORIES[locale]].sort()).toEqual(check.pluralCategories(locale).sort());
    }
  });
});

// Never called: `tsc` checks it. `TFunction` defaults to the ui namespace (generated types).
// Each @ts-expect-error fails the typecheck if its line compiles, so an untyped `t` (or a key
// that becomes valid) breaks the build.
export function typedKeys(t: TFunction, anyNamespace: I18n['t']): string[] {
  return [
    t('locale.name.en'),
    anyNamespace('ui:locale.name.ar'),
    // @ts-expect-error: not a key in the ui catalog
    t('locale.name.fr'),
    // @ts-expect-error: not a key in the ui catalog
    anyNamespace('ui:nonexistent.key'),
  ];
}
