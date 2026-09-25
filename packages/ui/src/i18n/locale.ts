// Initial locale (F-001 design §7.4.2), in order: the `?lang=` query parameter (ui-lab and tests),
// then localStorage (development convenience only), then the best match from navigator.languages,
// then en. The profile-driven locale arrives with F-021.
import { isLocale, type Locale, SOURCE_LOCALE } from '../contracts/i18n.js';

export const LOCALE_STORAGE_KEY = 'ralysa.locale';

export interface InitialLocaleSources {
  /** `location.search`. */
  search?: string;
  storage?: Pick<Storage, 'getItem'> | null;
  /** `navigator.languages`, most preferred first. */
  languages?: readonly string[];
}

export function resolveInitialLocale({
  search,
  storage,
  languages = [],
}: InitialLocaleSources = {}): Locale {
  const fromQuery = new URLSearchParams(search ?? '').get('lang');
  if (isLocale(fromQuery)) return fromQuery;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // Storage can throw (privacy mode, blocked site data): fall through.
  }
  if (isLocale(stored)) return stored;
  for (const tag of languages) {
    // "ar-QA" → "ar": match on the primary language subtag.
    const primary = tag.split('-')[0]?.toLowerCase();
    if (isLocale(primary)) return primary;
  }
  return SOURCE_LOCALE;
}

/** window.localStorage, or null where reading it throws (blocked site data, sandboxed frames). */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
