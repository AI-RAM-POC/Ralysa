// Where the two `vite preview` servers listen (playwright.config.ts starts them).
export const UI_LAB_URL = 'http://127.0.0.1:4173';
export const WEB_URL = 'http://127.0.0.1:4174';

export type Locale = 'en' | 'ar';
export type Theme = 'light' | 'dark';
export type View = 'showcase' | 'components' | 'tokens';

export const LOCALES: readonly Locale[] = ['en', 'ar'];
export const THEMES: readonly Theme[] = ['light', 'dark'];

/** A ui-lab URL path for one view in one configuration (router.ts reads these parameters). */
export function labPath(view: View, { lang, theme }: { lang: Locale; theme: Theme }): string {
  return `/?${new URLSearchParams({ view, lang, theme }).toString()}`;
}
