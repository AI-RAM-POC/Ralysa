// The `lab` namespace catalog (F-001 design §7.4.3): en bundled, other locales loaded on first use.
import type { Catalog, NamespaceCatalog, SecondaryLocale } from '@ralysa/ui';
import en from '../locales/en/lab.json';

// One loader per secondary locale; the Record type makes a new locale a compile error here.
const loaders: Record<SecondaryLocale, () => Promise<Catalog>> = {
  ar: async () => (await import('../locales/ar/lab.json')).default,
};

export const labCatalog: NamespaceCatalog = {
  namespace: 'lab',
  source: en,
  load: (locale) => loaders[locale](),
};
