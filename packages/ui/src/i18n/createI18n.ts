// i18next runtime (F-001 design §7.4.1, §7.4.5): one instance per app, built from the namespace
// catalogs the app uses. Source-language (en) strings are bundled statically; every other locale
// is loaded by dynamic import the first time it is used. There is no HTTP backend and no cloud
// service. In test mode a missing key throws (Playwright fails on the console error, §5.3) and
// there is no fallback language, so a key missing from `ar` is not hidden by its `en` value.
import i18next, { type BackendModule, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LOCALES, type Locale, type SecondaryLocale, SOURCE_LOCALE } from '../contracts/i18n.js';

/** A catalog file's content: nested objects of strings. */
export interface Catalog {
  [key: string]: string | Catalog;
}

export interface NamespaceCatalog {
  namespace: string;
  /** The source-language (en) strings, bundled with the code. */
  source: Catalog;
  /** Loads a secondary locale's strings; called the first time that locale is used. */
  load: (locale: SecondaryLocale) => Promise<Catalog>;
}

export type I18nMode = 'production' | 'test';

export interface CreateI18nOptions {
  catalogs: readonly NamespaceCatalog[];
  locale: Locale;
  /** The app's own namespace, used for un-prefixed keys. */
  defaultNS: string;
  /** "test" throws on a missing key and disables the en fallback. Default "production". */
  mode?: I18nMode;
}

export class MissingKeyError extends Error {
  override name = 'MissingKeyError';
}

function catalogBackend(catalogs: readonly NamespaceCatalog[]): BackendModule {
  const byNamespace = new Map(catalogs.map((catalog) => [catalog.namespace, catalog]));
  return {
    type: 'backend',
    init: () => undefined,
    read(language, namespace, callback) {
      const catalog = byNamespace.get(namespace);
      if (catalog === undefined || language === SOURCE_LOCALE || !isSecondary(language)) {
        callback(null, {});
        return;
      }
      catalog.load(language).then(
        (data) => {
          callback(null, data);
        },
        (error: unknown) => {
          callback(error instanceof Error ? error : new Error(String(error)), false);
        },
      );
    },
  };
}

function isSecondary(language: string): language is SecondaryLocale {
  return language !== SOURCE_LOCALE && (LOCALES as readonly string[]).includes(language);
}

export async function createI18n({
  catalogs,
  locale,
  defaultNS,
  mode = 'production',
}: CreateI18nOptions): Promise<I18n> {
  const instance = i18next.createInstance();
  instance.use(catalogBackend(catalogs)).use(initReactI18next);
  const test = mode === 'test';
  await instance.init({
    lng: locale,
    supportedLngs: [...LOCALES],
    fallbackLng: test ? false : SOURCE_LOCALE,
    ns: catalogs.map((catalog) => catalog.namespace),
    defaultNS,
    resources: {
      [SOURCE_LOCALE]: Object.fromEntries(
        catalogs.map((catalog) => [catalog.namespace, catalog.source]),
      ),
    },
    partialBundledLanguages: true,
    keySeparator: '.',
    nsSeparator: ':',
    interpolation: { escapeValue: false }, // React escapes
    returnNull: false,
    saveMissing: test,
    ...(test
      ? {
          missingKeyHandler: (languages: readonly string[], namespace: string, key: string) => {
            throw new MissingKeyError(
              `Missing i18n key "${namespace}:${key}" for ${languages.join(', ')}`,
            );
          },
        }
      : {}),
    react: { useSuspense: false },
  });
  return instance;
}
