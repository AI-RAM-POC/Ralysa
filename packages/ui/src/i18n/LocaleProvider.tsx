// Runtime locale switch (F-001 design §5.3, §7.4.2; AC-6). LocaleProvider subscribes to the
// i18next instance's `languageChanged` event and, on every change, sets `lang` and `dir` on
// <html> and feeds Radix's DirectionProvider, so arrow keys in RadioGroup, Tabs and Select follow
// the direction. Nothing reloads: switching is a re-render.
import { DirectionProvider } from '@radix-ui/react-direction';
import type { i18n as I18n } from 'i18next';
import {
  createContext,
  type JSX,
  type ReactNode,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { isLocale, LOCALES, type Locale, SOURCE_LOCALE } from '../contracts/i18n.js';

export type Direction = 'ltr' | 'rtl';

interface LocaleContextValue {
  locale: Locale;
  dir: Direction;
  /** Loads the locale's catalogs if needed, then switches. Resolves once the UI has switched. */
  setLocale: (locale: Locale) => Promise<void>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function currentLocale(i18n: I18n): Locale {
  const language = i18n.resolvedLanguage ?? i18n.language;
  return isLocale(language) ? language : SOURCE_LOCALE;
}

/** Writes the document language and direction (WCAG 3.1.1; the page mirrors via `dir`). */
export function applyLocale(element: HTMLElement, locale: Locale, dir: Direction): void {
  element.lang = locale;
  element.dir = dir;
}

export interface LocaleProviderProps {
  i18n: I18n;
  /** Defaults to document.documentElement. */
  target?: HTMLElement;
  children?: ReactNode;
}

export function LocaleProvider({ i18n, target, children }: LocaleProviderProps): JSX.Element {
  // The i18next instance is the source of truth; `languageChanged` is its change event.
  const subscribe = useCallback(
    (onChange: () => void) => {
      i18n.on('languageChanged', onChange);
      return () => {
        i18n.off('languageChanged', onChange);
      };
    },
    [i18n],
  );
  const snapshot = (): Locale => currentLocale(i18n);
  const locale = useSyncExternalStore(subscribe, snapshot, snapshot);
  const dir: Direction = i18n.dir(locale);

  useLayoutEffect(() => {
    applyLocale(target ?? document.documentElement, locale, dir);
  }, [target, locale, dir]);
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      dir,
      setLocale: async (next) => {
        await i18n.changeLanguage(next);
      },
    }),
    [i18n, locale, dir],
  );

  return (
    <I18nextProvider i18n={i18n}>
      <DirectionProvider dir={dir}>
        <LocaleContext value={value}>{children}</LocaleContext>
      </DirectionProvider>
    </I18nextProvider>
  );
}

export interface LocaleOption {
  locale: Locale;
  /** The language's own name (endonym), as the locale picker shows it. */
  label: string;
}

export interface UseLocaleResult extends LocaleContextValue {
  options: LocaleOption[];
}

export function useLocale(): UseLocaleResult {
  const context = use(LocaleContext);
  if (context === null) throw new Error('useLocale must be used inside <LocaleProvider>');
  const { t } = useTranslation('ui');
  const options = LOCALES.map((code) => ({
    locale: code,
    label: code === 'ar' ? t('locale.name.ar') : t('locale.name.en'),
  }));
  return { ...context, options };
}
