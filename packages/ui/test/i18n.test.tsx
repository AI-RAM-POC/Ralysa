// @vitest-environment jsdom
// AC-6 (unit level; TC-F-001-11 is the E2E version in apps/ui-lab): switching the locale at runtime
// sets <html lang> and <html dir> and re-renders the strings without a reload; the Radix
// direction follows. Also the §7.4.5 test-mode missing-key handler and the initial-locale order.
import { useDirection } from '@radix-ui/react-direction';
import type { i18n as I18n } from 'i18next';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createI18n,
  LOCALE_STORAGE_KEY,
  LocaleProvider,
  MissingKeyError,
  type NamespaceCatalog,
  resolveInitialLocale,
  uiCatalog,
  useLocale,
} from '../src/index.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A second namespace, like an app's own catalog. Plain JSON-shaped data, no hard-coded UI code.
const fixture: NamespaceCatalog = {
  namespace: 'fixture',
  source: { greeting: { title: 'Hello' }, only: { en: 'Only in English' } },
  load: (locale) => {
    expect(locale).toBe('ar');
    loads += 1;
    return Promise.resolve({ greeting: { title: 'مرحبا' } });
  },
};
let loads = 0;

/** The fixture namespace isn't in the generated key types (only real catalogs are). */
function tAny(i18n: I18n, key: string): string {
  return (i18n.t as unknown as (this: I18n, key: string) => string).call(i18n, key);
}

describe('resolveInitialLocale (§7.4.2 order)', () => {
  const storage = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => value });

  it('uses ?lang= first', () => {
    expect(
      resolveInitialLocale({ search: '?lang=ar', storage: storage('en'), languages: ['en'] }),
    ).toBe('ar');
  });
  it('then storage, then navigator.languages by primary subtag, then en', () => {
    expect(resolveInitialLocale({ search: '?lang=xx', storage: storage('ar') })).toBe('ar');
    expect(resolveInitialLocale({ storage: storage(null), languages: ['fr-FR', 'ar-QA'] })).toBe(
      'ar',
    );
    expect(resolveInitialLocale({ languages: ['fr-FR'] })).toBe('en');
    expect(resolveInitialLocale()).toBe('en');
  });
  it('survives storage that throws', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error(`blocked: ${LOCALE_STORAGE_KEY}`);
      },
    };
    expect(resolveInitialLocale({ storage: throwing, languages: ['ar'] })).toBe('ar');
  });
});

describe('createI18n', () => {
  it('bundles en and loads ar on first use', async () => {
    loads = 0;
    const i18n = await createI18n({
      catalogs: [uiCatalog, fixture],
      locale: 'en',
      defaultNS: 'fixture',
    });
    expect(tAny(i18n, 'fixture:greeting.title')).toBe('Hello');
    expect(loads).toBe(0);
    await i18n.changeLanguage('ar');
    expect(loads).toBe(1);
    expect(tAny(i18n, 'fixture:greeting.title')).toBe('مرحبا');
    expect(i18n.t('ui:locale.name.ar')).toBe('العربية');
    expect(i18n.dir()).toBe('rtl');
  });

  it('falls back to en in production mode', async () => {
    const i18n = await createI18n({ catalogs: [fixture], locale: 'ar', defaultNS: 'fixture' });
    expect(tAny(i18n, 'fixture:only.en')).toBe('Only in English');
  });

  it('throws on a missing key in test mode, including a key only the source language has', async () => {
    const i18n = await createI18n({
      catalogs: [fixture],
      locale: 'ar',
      defaultNS: 'fixture',
      mode: 'test',
    });
    expect(tAny(i18n, 'fixture:greeting.title')).toBe('مرحبا');
    expect(() => tAny(i18n, 'fixture:only.en')).toThrow(MissingKeyError);
    expect(() => tAny(i18n, 'fixture:no.such')).toThrow(
      /Missing i18n key "fixture:no.such" for ar/,
    );
  });
});

describe('LocaleProvider (AC-6)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    document.documentElement.lang = 'xx';
    document.documentElement.dir = '';
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  let switchTo: ReturnType<typeof useLocale>['setLocale'] = () => Promise.resolve();
  function Probe(): JSX.Element {
    // Re-renders on languageChanged like any component using the hook.
    const { i18n } = useTranslation();
    const { locale, dir, options, setLocale } = useLocale();
    switchTo = setLocale;
    const radixDir = useDirection();
    return (
      <p
        data-locale={locale}
        data-dir={dir}
        data-radix-dir={radixDir}
        data-options={options.map((o) => o.label).join('|')}
      >
        {tAny(i18n, 'fixture:greeting.title')}
      </p>
    );
  }
  const probe = (): HTMLElement => container.querySelector('p') as HTMLElement;

  it('sets lang and dir on <html>, feeds Radix, and switches without a reload', async () => {
    const i18n = await createI18n({
      catalogs: [uiCatalog, fixture],
      locale: 'en',
      defaultNS: 'fixture',
      mode: 'test',
    });
    act(() => {
      root.render(
        <LocaleProvider i18n={i18n}>
          <Probe />
        </LocaleProvider>,
      );
    });
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(probe().textContent).toBe('Hello');
    expect(probe().dataset.radixDir).toBe('ltr');
    expect(probe().dataset.options).toBe('English|العربية');

    const marker = Symbol('same page');
    (window as unknown as Record<symbol, boolean>)[marker] = true;
    const node = probe();

    await act(async () => {
      await switchTo('ar');
    });
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(probe().textContent).toBe('مرحبا');
    expect(probe().dataset.locale).toBe('ar');
    expect(probe().dataset.dir).toBe('rtl');
    expect(probe().dataset.radixDir).toBe('rtl');
    // No reload: the same window and the same DOM node.
    expect((window as unknown as Record<symbol, boolean>)[marker]).toBe(true);
    expect(probe()).toBe(node);

    await act(async () => {
      await switchTo('en');
    });
    expect(document.documentElement.dir).toBe('ltr');
    expect(probe().textContent).toBe('Hello');
  });

  it('useLocale outside the provider throws a clear error', () => {
    expect(() => {
      act(() => {
        root.render(<Probe />);
      });
    }).toThrow(/inside <LocaleProvider>/);
  });
});
