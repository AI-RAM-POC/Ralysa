// TC-F-001-21 (AC-10): the axe gate can fail. A fixture page with known violations (an image
// without alt text, a button without a name) must produce blocking findings through the same
// helper and the same assertion the a11y spec uses; if axe or the helper silently stopped
// reporting, the real a11y spec would pass vacuously, and this one fails.
import { describeViolations, scanAxe } from './helpers/axe.js';
import { expect, test } from './helpers/fixtures.js';

const BROKEN = `<!doctype html><html lang="en"><head><title>fixture</title></head><body>
  <main><h1>Fixture</h1>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <button type="button"></button>
  </main></body></html>`;

const CLEAN = `<!doctype html><html lang="en"><head><title>fixture</title></head><body>
  <main><h1>Fixture</h1>
    <img alt="A dot" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <button type="button">Save</button>
  </main></body></html>`;

test('a page with an unlabelled image and button fails the gate', async ({ page }, testInfo) => {
  await page.setContent(BROKEN);
  const { blocking } = await scanAxe(page, testInfo, 'selftest-broken');
  expect(blocking.map((v) => v.id).sort()).toEqual(['button-name', 'image-alt']);
  // The a11y spec's exact assertion throws on this page.
  expect(() => {
    expect(blocking, describeViolations(blocking)).toEqual([]);
  }).toThrow(/button-name|image-alt/);
});

test('the same page, fixed, passes the gate', async ({ page }, testInfo) => {
  await page.setContent(CLEAN);
  const { blocking } = await scanAxe(page, testInfo, 'selftest-clean');
  expect(blocking).toEqual([]);
});
