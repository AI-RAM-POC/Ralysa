// TC-F-001-15 (AC-8): Arabic shaping per engine. Each of the 20 samples (apps/ui-lab/src/samples,
// `data-sample-id`) is snapshotted on its own in chromium, firefox and webkit, each engine with
// its own baselines (e2e/__screenshots__/<engine>/), so a change in joining, ligatures, harakat,
// bidi order or digit shapes fails in the engine it happens in. Before any snapshot the bundled
// Arabic face must be loaded: document.fonts.check() is true for Noto Sans Arabic.
//
// OQ-D8: the baselines must be approved by a native speaker (TC-F-001-15); until then they are
// recorded as needs-native-review (implementation-notes T14, status.md).
import { readFileSync } from 'node:fs';
import { expect, openLab, test } from './helpers/fixtures.js';

const SAMPLE_IDS = (
  JSON.parse(
    readFileSync(new URL('../src/samples/arabic-samples.json', import.meta.url), 'utf8'),
  ) as { samples: { id: string }[] }
).samples.map((sample) => sample.id);

const ARABIC_FACE = '"Noto Sans Arabic Variable"';

test.describe('Arabic shaping', () => {
  test.beforeEach(async ({ page }) => {
    await openLab(page, 'showcase', { lang: 'ar', theme: 'light' });
  });

  test('the bundled Arabic face is loaded', async ({ page }) => {
    const { check, faces } = await page.evaluate((face) => {
      const family = face.replace(/"/g, '');
      return {
        check: document.fonts.check(`16px ${face}`, 'بسم'),
        // check() is also true when no face matches the family at all; require a real one.
        faces: [...document.fonts]
          .filter((f) => f.family.replace(/"/g, '') === family && f.status === 'loaded')
          .map((f) => f.unicodeRange),
      };
    }, ARABIC_FACE);
    expect(check).toBe(true);
    expect(faces.length, 'a loaded Noto Sans Arabic face').toBeGreaterThan(0);
    // The loaded face covers the Arabic block (U+0600–06FF), not only a Latin subset.
    expect(faces.some((range) => /U\+6[0-9A-F]{2}|U\+0?600/i.test(range))).toBe(true);
    expect(SAMPLE_IDS).toHaveLength(20);
  });

  for (const id of SAMPLE_IDS) {
    test(`sample ${id}`, async ({ page }) => {
      const sample = page.locator(`[data-sample-id="${id}"] p[lang="ar"]`);
      await expect(sample).toBeVisible();
      await expect(sample).toHaveScreenshot(`shaping-${id}.png`);
    });
  }
});
