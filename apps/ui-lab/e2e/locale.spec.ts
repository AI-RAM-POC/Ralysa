// TC-F-001-11 (AC-6; flow §5.3): switching the locale with the LocaleSwitcher changes html[lang]
// and html[dir] and the visible strings, with no reload: a marker set on `window` survives, and
// the history and navigation entry counts don't change. The console guard in fixtures.ts fails
// the test on a runtime missing key (TC-F-001-12, E2E half).
import { LAB, lookup, UI } from './helpers/catalogs.js';
import { expect, openLab, test } from './helpers/fixtures.js';

test('en → ar → en with the LocaleSwitcher, without a reload', async ({ page }) => {
  await openLab(page, 'showcase', { lang: 'en', theme: 'light' });
  const html = page.locator('html');
  const heading = page.locator('main h1').first();
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(heading).toHaveText(lookup(LAB.en, 'showcase.heading'));

  const before = await page.evaluate(() => {
    (window as unknown as { __e2eMarker: string }).__e2eMarker = 'still here';
    return {
      history: history.length,
      navigations: performance.getEntriesByType('navigation').length,
    };
  });

  const switcher = page.getByRole('combobox', { name: lookup(UI.en, 'localeSwitcher.label') });
  await switcher.click();
  await page.getByRole('option', { name: lookup(UI.en, 'locale.name.ar') }).click();

  await expect(html).toHaveAttribute('lang', 'ar');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(heading).toHaveText(lookup(LAB.ar, 'showcase.heading'));
  // Focus stays on the switcher (§5.3), now labelled in Arabic.
  const arSwitcher = page.getByRole('combobox', { name: lookup(UI.ar, 'localeSwitcher.label') });
  await expect(arSwitcher).toBeFocused();

  const after = await page.evaluate(() => ({
    marker: (window as unknown as { __e2eMarker?: string }).__e2eMarker,
    history: history.length,
    navigations: performance.getEntriesByType('navigation').length,
  }));
  expect(after).toEqual({ marker: 'still here', ...before });

  await arSwitcher.click();
  await page.getByRole('option', { name: lookup(UI.ar, 'locale.name.en') }).click();
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(heading).toHaveText(lookup(LAB.en, 'showcase.heading'));
  expect(
    await page.evaluate(() => (window as unknown as { __e2eMarker?: string }).__e2eMarker),
  ).toBe('still here');
});

test('the ar start-up locale renders Arabic strings in an rtl document', async ({ page }) => {
  await openLab(page, 'showcase', { lang: 'ar', theme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('main h1').first()).toHaveText(lookup(LAB.ar, 'showcase.heading'));
  await expect(page).toHaveTitle(lookup(LAB.ar, 'app.title'));
});
