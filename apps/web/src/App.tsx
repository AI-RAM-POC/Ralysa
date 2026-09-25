// @ralysa/web: application shell. Screens use @ralysa/ui components, i18n keys for every
// user-visible string, and logical CSS properties only (F-001 design §7).
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';

export function App(): JSX.Element {
  const { t } = useTranslation('web');
  return (
    <main id="main" data-app="web">
      <h1>{t('app.name')}</h1>
    </main>
  );
}
