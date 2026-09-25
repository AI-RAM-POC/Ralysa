// TC-F-001-13 (AC-7): mirroring in ar and none in en.
//   - Layout: in ar the nav (inline-start) sits to the right of main; in en to the left. The
//     aside (inline-end) does the opposite.
//   - Directional icons mirror in ar only; non-directional icons never do. Tailwind v4's
//     `rtl:-scale-x-100` sets the CSS `scale` property, so the computed style is `scale: -1 1`
//     with `transform: none`. The design's `transform: matrix(-1, 0, 0, 1, 0, 0)` is the same
//     visual result through a different property (T09-9); the spec reads `scale`, and also
//     checks that each icon's rendered box doesn't move (a mirror, not a shift).
//   - code, pre and [data-ltr] islands stay `direction: ltr` inside the rtl page.
import type { Page } from '@playwright/test';
import { expect, openLab, test } from './helpers/fixtures.js';
import type { Locale } from './helpers/urls.js';

async function regionBoxes(page: Page) {
  const box = async (region: string) => {
    const b = await page.locator(`[data-region="${region}"]`).first().boundingBox();
    if (b === null) throw new Error(`${region} is not rendered`);
    return b;
  };
  return { nav: await box('nav'), main: await box('main'), aside: await box('aside') };
}

async function iconScales(page: Page, strip: string) {
  return page.locator(`[data-icon-strip="${strip}"] svg`).evaluateAll((icons) =>
    icons.map((icon) => {
      const style = getComputedStyle(icon);
      return { scale: style.scale, transform: style.transform };
    }),
  );
}

for (const lang of ['en', 'ar'] as const satisfies readonly Locale[]) {
  test.describe(lang, () => {
    test.beforeEach(async ({ page }) => {
      await openLab(page, 'showcase', { lang, theme: 'light' });
    });

    test('regions follow the inline direction', async ({ page }) => {
      const { nav, main, aside } = await regionBoxes(page);
      if (lang === 'ar') {
        expect(nav.x).toBeGreaterThan(main.x);
        expect(aside.x).toBeLessThan(main.x);
      } else {
        expect(nav.x).toBeLessThan(main.x);
        expect(aside.x).toBeGreaterThan(main.x);
      }
    });

    test('directional icons mirror only in ar; non-directional never', async ({ page }) => {
      const directional = await iconScales(page, 'directional');
      const other = await iconScales(page, 'non-directional');
      expect(directional.length).toBeGreaterThan(0);
      expect(other.length).toBeGreaterThan(0);
      for (const icon of directional) {
        expect(icon).toEqual({ scale: lang === 'ar' ? '-1 1' : 'none', transform: 'none' });
      }
      for (const icon of other) expect(icon).toEqual({ scale: 'none', transform: 'none' });
    });

    test('code, pre and LTR islands keep direction: ltr', async ({ page }) => {
      const directions = await page
        .locator('main code, main pre, main [data-ltr]')
        .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).direction));
      expect(directions.length).toBeGreaterThanOrEqual(3);
      expect(new Set(directions)).toEqual(new Set(['ltr']));
      expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(
        lang === 'ar' ? 'rtl' : 'ltr',
      );
    });
  });
}
