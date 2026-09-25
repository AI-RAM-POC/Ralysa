// TC-F-001-28 (AC-13): the apps/web production preview serves no demo content at the paths and
// views a demo would live at. `vite preview` answers every path with the app, so each response
// is the shipped app; none may carry the sentinel, a sample string or a ui-lab hook.
// check-no-demo (TC-F-001-27) proves the same for the build output on disk.
import { readFileSync } from 'node:fs';
import { expect, test } from './helpers/fixtures.js';
import { WEB_URL } from './helpers/urls.js';

const SENTINEL = '__RALYSA_DEMO_ONLY__';
const samples = (file: string): string[] =>
  (
    JSON.parse(readFileSync(new URL(`../src/samples/${file}`, import.meta.url), 'utf8')) as {
      samples: { text: string }[];
    }
  ).samples.map((sample) => sample.text);
const SAMPLE_TEXTS = [...samples('arabic-samples.json'), ...samples('example-data.json')];

const PATHS = ['/ui-lab', '/demo', '/__demo', '/?view=showcase', '/?view=components'];

for (const path of PATHS) {
  test(`web ${path}: no demo content`, async ({ page }) => {
    const response = await page.goto(`${WEB_URL}${path}`);
    expect(response?.ok()).toBe(true);
    // The shipped app rendered (positive control), and nothing from ui-lab did.
    await expect(page.locator('[data-app="web"]')).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain(SENTINEL);
    await expect(
      page.locator('[data-demo-sentinel], [data-sample-id], [data-sample-panel], [data-example]'),
    ).toHaveCount(0);
    const text = await page.locator('body').innerText();
    for (const sample of SAMPLE_TEXTS) expect(text).not.toContain(sample);
  });
}
