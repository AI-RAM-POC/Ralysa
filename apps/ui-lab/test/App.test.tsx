// The ui-lab views (F-001 design §7.6), rendered in en and ar with i18n in test mode, so a missing
// `lab` or `ui` key throws: the sentinel on the root, the AppShell regions, the form, the icon
// strips, the 20 samples marked lang="ar" dir="rtl", the LTR islands, the four states, every
// component example, and the token swatches. Plus the router and the example-label catalog.
import './jsdom-polyfills.js';
import {
  createI18n,
  type Locale,
  LocaleProvider,
  ThemeProvider,
  TOKEN_CSS_VARS,
  uiCatalog,
} from '@ralysa/ui';
import { ALL_EXAMPLES, EXAMPLE_LABELS } from '@ralysa/ui/examples';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import ar from '../locales/ar/lab.json';
import en from '../locales/en/lab.json';
import { App } from '../src/App.js';
import { labCatalog } from '../src/i18n.js';
import { DATA_LABELS } from '../src/labels.js';
import { hrefFor, parseRoute, type Route } from '../src/router.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function renderApp(route: Route, locale: Locale): Promise<HTMLElement> {
  const i18n = await createI18n({
    catalogs: [uiCatalog, labCatalog],
    locale,
    defaultNS: 'lab',
    mode: 'test',
  });
  await i18n.loadLanguages(locale);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LocaleProvider i18n={i18n}>
        <ThemeProvider>
          <App route={route} />
        </ThemeProvider>
      </LocaleProvider>,
    );
    await Promise.resolve();
  });
  cleanup = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  return container;
}

describe.each(['en', 'ar'] as const)('ui-lab in %s', (locale) => {
  it('showcase: sentinel, regions, form, icons, samples, LTR islands and states', async () => {
    const page = await renderApp({ view: 'showcase' }, locale);
    expect(page.querySelector('[data-demo-sentinel]')?.getAttribute('data-demo-sentinel')).toBe(
      '__RALYSA_DEMO_ONLY__',
    );
    expect(
      [...page.querySelectorAll('[data-region]')].map((r) => r.getAttribute('data-region')),
    ).toEqual(['header', 'nav', 'main', 'aside']);
    expect(document.documentElement.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');
    expect(
      page.querySelectorAll(
        'form input, form [role="combobox"], form [role="radio"], form [role="checkbox"]',
      ).length,
    ).toBeGreaterThanOrEqual(7);
    expect(
      page.querySelectorAll('[data-icon-strip="directional"] [data-icon-directional="true"]')
        .length,
    ).toBeGreaterThan(0);
    expect(
      page.querySelectorAll('[data-icon-strip="non-directional"] [data-icon-directional="true"]'),
    ).toHaveLength(0);
    const samples = [...page.querySelectorAll('[data-sample-id] p')];
    expect(samples).toHaveLength(20);
    for (const sample of samples) {
      expect(sample.getAttribute('lang')).toBe('ar');
      expect(sample.getAttribute('dir')).toBe('rtl');
    }
    // Every code, pre and Ltr island is LTR (the <code> inside a <pre> inherits the pre's dir).
    const islands = [...page.querySelectorAll('main code, main pre, main [data-ltr]')];
    expect(islands.length).toBeGreaterThanOrEqual(3);
    for (const island of islands) {
      expect(island.closest('[dir]')?.getAttribute('dir')).toBe('ltr');
    }
    expect(page.querySelectorAll('[data-state-pattern]')).toHaveLength(4);
  });

  it('components: every example of every component', async () => {
    const page = await renderApp({ view: 'components' }, locale);
    const total = ALL_EXAMPLES.reduce((sum, group) => sum + group.examples.length, 0);
    expect(page.querySelectorAll('[data-example]')).toHaveLength(total);
    expect(page.querySelectorAll('[data-component]')).toHaveLength(ALL_EXAMPLES.length);
  });

  it('components: one component, or a status for an unknown name', async () => {
    let page = await renderApp({ view: 'components', component: 'Button' }, locale);
    expect(
      [...page.querySelectorAll('[data-component]')].map((s) => s.getAttribute('data-component')),
    ).toEqual(['Button']);
    cleanup?.();
    page = await renderApp({ view: 'components', component: 'Nope' }, locale);
    expect(page.querySelector('[role="status"] bdi')?.textContent).toBe('Nope');
  });

  it('tokens: a swatch for every semantic colour token', async () => {
    const page = await renderApp({ view: 'tokens' }, locale);
    const colours = Object.keys(TOKEN_CSS_VARS).filter((name) => name.startsWith('color.'));
    expect(
      [...page.querySelectorAll('[data-token]')].map((t) => t.getAttribute('data-token')),
    ).toEqual(colours);
    expect(colours).toContain('color.bg.surfaceRaised');
  });
});

describe('router', () => {
  it('parses the view and component, defaulting to the showcase', () => {
    expect(parseRoute('')).toEqual({ view: 'showcase' });
    expect(parseRoute('?view=nope')).toEqual({ view: 'showcase' });
    expect(parseRoute('?view=tokens&c=Button')).toEqual({ view: 'tokens' });
    expect(parseRoute('?view=components&c=Button&lang=ar')).toEqual({
      view: 'components',
      component: 'Button',
    });
  });

  it('keeps the locale and theme in every link', () => {
    expect(
      hrefFor({ view: 'components', component: 'Tabs' }, { locale: 'ar', theme: 'dark' }),
    ).toBe('?view=components&c=Tabs&lang=ar&theme=dark');
  });
});

describe('example labels', () => {
  const flat = (catalog: Record<string, unknown>): string[] =>
    Object.keys((catalog as { examples: Record<string, string> }).examples);

  it('the lab catalogs have exactly the translatable EXAMPLE_LABELS, in en and ar', () => {
    const translatable = EXAMPLE_LABELS.filter((label) => !DATA_LABELS.includes(label)).sort();
    expect(flat(en).sort()).toEqual(translatable);
    expect(flat(ar).sort()).toEqual(translatable);
  });
});
