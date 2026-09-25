// Harness self-tests (T13): each check the specs rely on is shown to fail on a fixture that
// breaks it, so a harness bug can't turn a real failure into a pass.
//   - the keyboard walker detects a focus trap, a Tab order against the reading direction and a
//     missing or low-contrast focus ring (TC-F-001-24's checks);
//   - the console guard fails a test on an uncaught error (the runtime missing-key check).
// The Node check (AR-4 b) is unit-tested in tooling/repo-scripts/test/node-engine.test.ts.
import { expect, test } from './helpers/fixtures.js';
import { indexFocusables, readingOrderProblems, ringProblems, walk } from './helpers/keyboard.js';

const page_ = (body: string): string =>
  `<!doctype html><html lang="en"><head><title>fixture</title><style>
    body { background: #fff; color: #000; }
    button { font: inherit; margin: 8px; }
    .ring:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
  </style></head><body>${body}</body></html>`;

test('walker: a focus trap never leaves the page', async ({ page }) => {
  await page.setContent(
    page_(`<button class="ring">a</button><button class="ring" id="b">b</button>
      <script>
        document.getElementById('b').addEventListener('keydown', (e) => {
          if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.querySelector('button').focus(); }
        });
      </script>`),
  );
  await indexFocusables(page);
  const result = await walk(page, 'Tab', { max: 10 });
  expect(result.end).toBe('cycled');
});

test('walker: a clean page is walked once and left', async ({ page }) => {
  await page.setContent(page_('<button class="ring">a</button><button class="ring">b</button>'));
  const expected = await indexFocusables(page);
  const result = await walk(page, 'Tab');
  expect(result.end).toBe('left-page');
  expect(result.stops.map((s) => s.id)).toEqual(expected.map((_, i) => i));
  expect(ringProblems(result.stops)).toEqual([]);
  expect(readingOrderProblems(result.stops, 'ltr')).toEqual([]);
});

test('walker: Tab order against the reading direction is reported', async ({ page }) => {
  // DOM order a, b; row-reverse puts b on the left, so in ltr Tab moves leftwards.
  await page.setContent(
    page_(`<div data-region="main" style="display:flex;flex-direction:row-reverse;justify-content:flex-end">
      <button class="ring">a</button><button class="ring">b</button></div>`),
  );
  await indexFocusables(page);
  const { stops } = await walk(page, 'Tab');
  expect(readingOrderProblems(stops, 'ltr')).toHaveLength(1);
  expect(readingOrderProblems(stops, 'rtl')).toEqual([]);
});

test('walker: a missing ring and a low-contrast ring are reported', async ({ page }) => {
  await page.setContent(
    page_(`<button style="outline:none">none</button>
      <button style="outline:2px solid #eee;outline-offset:2px">faint</button>
      <button class="ring">good</button>`),
  );
  await indexFocusables(page);
  const { stops } = await walk(page, 'Tab');
  const problems = ringProblems(stops);
  expect(problems).toHaveLength(2);
  expect(problems[0]).toContain('"none"');
  expect(problems[1]).toContain('"faint"');
});

test('console guard: an uncaught page error fails the test', async ({ page }) => {
  test.fail(true, 'the auto fixture must fail this test');
  await page.setContent(page_('<script>throw new Error("missing key: lab:nope")</script>'));
});
