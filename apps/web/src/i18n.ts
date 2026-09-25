// The `web` namespace catalog (F-001 design §7.4.3): en bundled, other locales loaded on first use.
import type { Catalog, NamespaceCatalog, SecondaryLocale } from '@ralysa/ui';
import en from '../locales/en/web.json';

// One loader per secondary locale; the Record type makes a new locale a compile error here.
const loaders: Record<SecondaryLocale, () => Promise<Catalog>> = {
  ar: async () => (await import('../locales/ar/web.json')).default,
};

export const webCatalog: NamespaceCatalog = {
  namespace: 'web',
  source: en,
  load: (locale) => loaders[locale](),
};
