import { createI18n, type Locale, uiCatalog } from '@ralysa/ui';
import { renderToString } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { webCatalog } from '../src/i18n.js';

async function render(locale: Locale): Promise<string> {
  // Test mode: a missing key throws instead of falling back to English.
  const i18n = await createI18n({
    catalogs: [uiCatalog, webCatalog],
    locale,
    defaultNS: 'web',
    mode: 'test',
  });
  return renderToString(
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>,
  );
}

describe('@ralysa/web App', () => {
  it('renders the main landmark with the app name from the web catalog', async () => {
    expect(await render('en')).toBe('<main id="main" data-app="web"><h1>Ralysa</h1></main>');
  });

  it('renders the Arabic catalog in ar', async () => {
    expect(await render('ar')).toBe('<main id="main" data-app="web"><h1>راليسا</h1></main>');
  });
});
