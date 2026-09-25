// TC-F-001-20 (AC-10): axe on the showcase, the component gallery (every example of every
// component) and the tokens view, in en and ar, each in light and dark: 0 serious or critical
// violations. Moderate findings are attached, not failed (§8.2; T10-5).
import { describeViolations, scanAxe } from './helpers/axe.js';
import { expect, openLab, test } from './helpers/fixtures.js';
import { LOCALES, THEMES, type View } from './helpers/urls.js';

const VIEWS: readonly View[] = ['showcase', 'components', 'tokens'];

for (const view of VIEWS) {
  for (const lang of LOCALES) {
    for (const theme of THEMES) {
      test(`${view} ${lang} ${theme}: no serious or critical axe violations`, async ({
        page,
      }, testInfo) => {
        await openLab(page, view, { lang, theme });
        const { blocking } = await scanAxe(page, testInfo, `${view}-${lang}-${theme}`);
        expect(blocking, describeViolations(blocking)).toEqual([]);
      });
    }
  }
}

test('the gallery shows every component example', async ({ page }) => {
  await openLab(page, 'components', { lang: 'en', theme: 'light' });
  // A gallery that silently rendered nothing would pass axe; guard the scan's coverage. T12
  // shipped 20 components with 30 examples; more may be added, never fewer.
  expect(await page.locator('[data-component]').count()).toBeGreaterThanOrEqual(20);
  expect(await page.locator('[data-example]').count()).toBeGreaterThanOrEqual(30);
});
