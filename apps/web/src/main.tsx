import '@ralysa/ui/tokens.css';
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
import { webCatalog } from './i18n.js';

async function start(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) throw new Error('#root is missing from index.html');

  const storage = browserStorage();
  const i18n = await createI18n({
    catalogs: [uiCatalog, webCatalog],
    locale: resolveInitialLocale({
      search: window.location.search,
      storage,
      languages: navigator.languages,
    }),
    defaultNS: 'web',
  });

  createRoot(container).render(
    <StrictMode>
      <LocaleProvider i18n={i18n}>
        <ThemeProvider initial={resolveInitialTheme({ search: window.location.search, storage })}>
          <App />
        </ThemeProvider>
      </LocaleProvider>
    </StrictMode>,
  );
}

void start();
