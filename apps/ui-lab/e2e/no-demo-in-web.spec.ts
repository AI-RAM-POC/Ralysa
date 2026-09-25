// TC-F-001-28 (AC-13): the apps/web production preview serves no demo content at the paths and
// views a demo would live at. `vite preview` answers every path with the app, so each response
// is the shipped app; none may carry the sentinel, a sample string or a ui-lab hook.
// check-no-demo (TC-F-001-27) proves the same for the build output on disk.
import type { Page } from '@playwright/test';
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

/** Every piece of demo content on the page: the sentinel, a ui-lab hook, or a sample string. */
async function demoContent(page: Page): Promise<string[]> {
  const found: string[] = [];
  if ((await page.content()).includes(SENTINEL)) found.push('sentinel');
  const hooks = await page
    .locator('[data-demo-sentinel], [data-sample-id], [data-sample-panel], [data-example]')
    .count();
  if (hooks > 0) found.push(`${String(hooks)} ui-lab hook(s)`);
  const text = await page.locator('body').innerText();
  for (const sample of SAMPLE_TEXTS) if (text.includes(sample)) found.push(`sample: ${sample}`);
  return found;
}

for (const path of PATHS) {
  test(`web ${path}: no demo content`, async ({ page }) => {
    const response = await page.goto(`${WEB_URL}${path}`);
    expect(response?.ok()).toBe(true);
    // The shipped app rendered (positive control), and nothing from ui-lab did.
    await expect(page.locator('[data-app="web"]')).toBeVisible();
    expect(await demoContent(page)).toEqual([]);
  });
}

test('negative control: the same check finds the demo content in the ui-lab preview', async ({
  page,
}) => {
  // If the detector silently stopped matching (a renamed hook, a changed sample file), the web
  // tests above would pass vacuously; here it must find all three kinds of evidence.
  await page.goto('/?view=showcase&lang=ar&theme=light');
  await expect(page.locator('[data-sample-id]').first()).toBeVisible();
  const found = await demoContent(page);
  expect(found).toContain('sentinel');
  expect(found.some((f) => f.endsWith('ui-lab hook(s)'))).toBe(true);
  expect(found.filter((f) => f.startsWith('sample: ')).length).toBeGreaterThanOrEqual(20);
});
