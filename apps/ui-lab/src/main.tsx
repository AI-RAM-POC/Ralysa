import '@ralysa/ui/tokens.css';
import '@ralysa/ui/fonts.css';
import './styles.css';
import {
  browserStorage,
  createI18n,
  LocaleProvider,
  resolveInitialLocale,
  resolveInitialTheme,
  ThemeProvider,
  uiCatalog,
} from '@ralysa/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { labCatalog } from './i18n.js';
import { parseRoute } from './router.js';

async function start(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) throw new Error('#root is missing from index.html');

  const storage = browserStorage();
  const i18n = await createI18n({
    catalogs: [uiCatalog, labCatalog],
    locale: resolveInitialLocale({
      search: window.location.search,
      storage,
      languages: navigator.languages,
    }),
    defaultNS: 'lab',
    // ui-lab is a test harness and never ships: a missing key always throws (§7.4.5), so the
    // Playwright runs fail on it instead of showing an English fallback.
    mode: 'test',
  });

  createRoot(container).render(
    <StrictMode>
      <LocaleProvider i18n={i18n}>
        <ThemeProvider initial={resolveInitialTheme({ search: window.location.search, storage })}>
          <App route={parseRoute(window.location.search)} />
        </ThemeProvider>
      </LocaleProvider>
    </StrictMode>,
  );
}

void start();
