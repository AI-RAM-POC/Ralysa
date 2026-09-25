// Test helper (jsdom): renders into a fresh container inside LocaleProvider, with a real i18n
// instance in test mode, so a missing key throws instead of falling back (§7.4.5).
import type { i18n as I18n } from 'i18next';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createI18n,
  type Locale,
  LocaleProvider,
  type NamespaceCatalog,
  ThemeProvider,
  uiCatalog,
} from '../src/index.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  i18n: I18n;
  root: Root;
  rerender: (node: ReactNode) => Promise<void>;
  unmount: () => void;
}

export async function makeI18n(
  locale: Locale = 'en',
  extra: readonly NamespaceCatalog[] = [],
): Promise<I18n> {
  return createI18n({ catalogs: [uiCatalog, ...extra], locale, defaultNS: 'ui', mode: 'test' });
}

export async function render(
  node: ReactNode,
  { locale = 'en', i18n }: { locale?: Locale; i18n?: I18n } = {},
): Promise<Rendered> {
  const instance = i18n ?? (await makeI18n(locale));
  if (instance.language !== locale && i18n === undefined) await instance.changeLanguage(locale);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const wrap = (child: ReactNode): ReactNode => (
    <LocaleProvider i18n={instance}>
      <ThemeProvider>{child}</ThemeProvider>
    </LocaleProvider>
  );
  await act(async () => {
    root.render(wrap(node));
    await Promise.resolve();
  });
  return {
    container,
    i18n: instance,
    root,
    rerender: async (next) => {
      await act(async () => {
        root.render(wrap(next));
        await Promise.resolve();
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * A key press the way a browser delivers it, inside act(): keydown, then one macrotask (Radix's
 * roving focus in RadioGroup and Tabs moves focus in a setTimeout, and a radio is checked on that
 * focus only while the arrow key is still down), then keyup.
 */
export async function press(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    target.dispatchEvent(
      new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...init }),
    );
    await Promise.resolve();
  });
}

/** Clicks an element inside act(). */
export async function click(target: Element): Promise<void> {
  await act(async () => {
    (target as HTMLElement).click();
    await Promise.resolve();
  });
}
