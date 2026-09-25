// TC-F-001-18 (AC-9): the showcase in the four configurations (en/LTR and ar/RTL, light and dark)
// at both viewports (1280×800 and 360×740), within maxDiffPixelRatio 0.001 and threshold 0.2
// (playwright.config.ts). Chromium only, so the baselines stay stable (§8.2); the per-engine
// check is shaping.spec.ts. Baselines live in e2e/__screenshots__/chromium/ and are written only
// by `pnpm --filter @ralysa/ui-lab e2e:update`, in CI's pinned image (§5.4). CI never writes them.
//
// OQ-D8: the Arabic baselines show machine-assisted placeholder strings that still need a native
// speaker's review (implementation-notes T14). Approving a baseline approves the rendering of
// the current strings, not their wording.
import { expect, openLab, test } from './helpers/fixtures.js';
import { LOCALES, THEMES } from './helpers/urls.js';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 360, height: 740 },
] as const;

test.skip(({ browserName }) => browserName !== 'chromium', 'visual baselines are chromium-only');

for (const viewport of VIEWPORTS) {
  for (const lang of LOCALES) {
    for (const theme of THEMES) {
      test(`showcase ${lang} ${theme} ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openLab(page, 'showcase', { lang, theme });
        await expect(page).toHaveScreenshot(`showcase-${lang}-${theme}-${viewport.name}.png`, {
          fullPage: true,
        });
      });
    }
  }
}
