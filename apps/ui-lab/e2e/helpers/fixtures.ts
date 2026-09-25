// The shared test fixture. Every spec imports `test` and `expect` from here, so every page gets
// the console guard: a console error or an uncaught exception fails the test. ui-lab runs i18n in
// test mode, where a missing key throws (§5.3, §7.4.5), so this is also the runtime missing-key
// check of TC-F-001-12.
import { test as base, expect, type Page } from '@playwright/test';
import { labPath, type Locale, type Theme, type View } from './urls.js';

export interface Fixtures {
  /** Console errors and uncaught exceptions seen so far. Must be empty when the test ends. */
  pageErrors: string[];
}

export const test = base.extend<Fixtures>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
      });
      page.on('pageerror', (error) => {
        errors.push(`uncaught: ${error.message}`);
      });
      await use(errors);
      expect(errors, 'console errors or uncaught exceptions (a missing i18n key throws)').toEqual(
        [],
      );
    },
    { auto: true },
  ],
});

export { expect };

/** Opens a ui-lab view and waits until it has rendered in that locale with its fonts loaded. */
export async function openLab(
  page: Page,
  view: View,
  config: { lang: Locale; theme: Theme },
): Promise<void> {
  await page.goto(labPath(view, config));
  await expect(page.locator('html')).toHaveAttribute('lang', config.lang);
  await expect(page.locator('[data-demo-sentinel] main h1')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}
