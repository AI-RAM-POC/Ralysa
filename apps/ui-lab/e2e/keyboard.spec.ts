// TC-F-001-24 (AC-12; §7.7): the keyboard walk of the showcase, in chromium and firefox, in en and
// ar. Checks every visible focusable element is reached once, Tab leaves the page at the end and
// Shift+Tab reverses (no trap), Tab follows the visual reading order (right-to-left in ar), and
// every focus state shows a ring of at least 2 px and 3:1. Then the operation keys: Escape closes
// the Select popover and returns focus to its trigger, Enter and Space open it, typeahead picks an
// option, Space toggles the Checkbox (T11-4), and arrow keys move through the RadioGroup in the
// reading direction (Radix DirectionProvider).
import { LAB, lookup } from './helpers/catalogs.js';
import { expect, openLab, test } from './helpers/fixtures.js';
import {
  indexFocusables,
  reachedEdge,
  readingOrderProblems,
  ringProblems,
  walk,
} from './helpers/keyboard.js';
import { LOCALES } from './helpers/urls.js';

for (const lang of LOCALES) {
  test.describe(lang, () => {
    test.beforeEach(async ({ page }) => {
      await openLab(page, 'showcase', { lang, theme: 'light' });
    });

    test('Tab reaches every focusable element in reading order, with a visible ring', async ({
      page,
    }) => {
      const expected = await indexFocusables(page);
      expect(expected.length).toBeGreaterThan(10);

      const forward = await walk(page, 'Tab');
      const ids = forward.stops.map((stop) => stop.id);
      const labels = forward.stops.map((stop) => stop.label);
      // Every stop is a known focusable, none repeats (no cycle), and all were reached, in DOM order.
      expect(ids, labels.join('\n')).toEqual(expected.map((_, index) => index));
      expect(forward.end, 'Tab past the last element reaches the edge of the page').not.toBe(
        'cycled',
      );
      expect(reachedEdge(forward)).toBe(true);

      expect(readingOrderProblems(forward.stops, lang === 'ar' ? 'rtl' : 'ltr')).toEqual([]);
      expect(ringProblems(forward.stops)).toEqual([]);
    });

    test('Shift+Tab walks the same stops in reverse and reaches the top (no trap)', async ({
      page,
      browserName,
    }) => {
      // D-F001-E2E-1 (open): in Playwright's Firefox, Shift+Tab from a Radix RadioGroup item
      // lands on the group element, which hands focus straight back to the item, so focus can't
      // leave the group backwards. Chromium is fine. Not yet confirmed in a stock Firefox (manual
      // TC-F-001-25). test.fail keeps the check running: it turns red the day it passes, so the
      // annotation can't outlive the defect.
      test.fail(browserName === 'firefox', 'D-F001-E2E-1: Shift+Tab out of RadioGroup in Firefox');
      const expected = await indexFocusables(page);
      const forward = await walk(page, 'Tab');
      expect(reachedEdge(forward)).toBe(true);
      // Chromium: focus left the page and Shift+Tab re-enters at the last stop. Firefox: focus
      // stayed on the last stop, so the walk back starts there.
      const backward = await walk(page, 'Shift+Tab', { fromCurrent: forward.end === 'stayed' });
      expect(backward.stops.map((stop) => stop.id)).toEqual(
        expected.map((_, index) => index).reverse(),
      );
      expect(reachedEdge(backward), 'Shift+Tab past the first element reaches the edge').toBe(true);
    });

    test('Select: Enter opens, Escape closes and returns focus; Space opens too', async ({
      page,
    }) => {
      const trigger = page.getByRole('combobox', {
        name: lookup(LAB[lang], 'showcase.form.department'),
      });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(listbox).toBeHidden();
      await expect(trigger).toBeFocused();

      await page.keyboard.press('Space');
      await expect(listbox).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(listbox).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test('Select typeahead picks the option that starts with the typed text', async ({ page }) => {
      const trigger = page.getByRole('combobox', {
        name: lookup(LAB[lang], 'showcase.form.department'),
      });
      const labels = ['finance', 'hr', 'sales'].map((key) =>
        lookup(LAB[lang], `showcase.department.${key}`),
      );
      const target = labels[2] ?? '';
      // The shortest prefix no other option shares: every Arabic label starts with "ال".
      let prefix = target.slice(0, 1);
      while (labels.some((label) => label !== target && label.startsWith(prefix))) {
        prefix = target.slice(0, prefix.length + 1);
      }
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('listbox')).toBeVisible();
      if (/^[\x20-\x7e]+$/.test(prefix)) {
        await page.keyboard.type(prefix);
      } else {
        // Playwright's keyboard knows the US layout only: it inserts other characters as text,
        // with no keydown, and press() rejects them. An Arabic keyboard sends a keydown whose
        // `key` is the letter, so dispatch exactly that to the focused element; Radix's
        // typeahead reads event.key. (A physical Arabic layout is part of manual TC-F-001-25.)
        await page.evaluate(
          (keys) => {
            for (const key of keys) {
              document.activeElement?.dispatchEvent(
                new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
              );
            }
          },
          // One key per code point: each Arabic letter here is a single code point and key.
          Array.from(prefix),
        );
      }
      await expect(page.getByRole('option', { name: target })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('listbox')).toBeHidden();
      await expect(trigger).toContainText(target);
      await expect(trigger).toBeFocused();
    });

    test('Space toggles the Checkbox', async ({ page }) => {
      const checkbox = page.getByRole('checkbox', {
        name: lookup(LAB[lang], 'showcase.form.notify'),
      });
      await checkbox.focus();
      await expect(checkbox).not.toBeChecked();
      await page.keyboard.press('Space');
      await expect(checkbox).toBeChecked();
      await page.keyboard.press('Space');
      await expect(checkbox).not.toBeChecked();
    });

    test('RadioGroup: the arrow key toward the next item follows the reading direction', async ({
      page,
    }) => {
      const radio = (key: string) =>
        page.getByRole('radio', { name: lookup(LAB[lang], `showcase.priority.${key}`) });
      await radio('normal').focus();
      await expect(radio('normal')).toBeChecked();
      // "Next" is to the right in en and to the left in ar. Radix checks the item that arrow-key
      // focus lands on only while the key is still down (it moves focus in a task after
      // keydown), so hold the key as a person does instead of an instant press.
      const arrow = async (key: string): Promise<void> => {
        await page.keyboard.down(key);
        await page.waitForTimeout(100);
        await page.keyboard.up(key);
      };
      await arrow(lang === 'ar' ? 'ArrowLeft' : 'ArrowRight');
      await expect(radio('high')).toBeFocused();
      await expect(radio('high')).toBeChecked();
      await arrow(lang === 'ar' ? 'ArrowRight' : 'ArrowLeft');
      await expect(radio('normal')).toBeFocused();
      await expect(radio('normal')).toBeChecked();
    });

    test('Enter and Space activate a button', async ({ page }) => {
      // The submit button submits the request form, which the showcase handles in place; the
      // page must not navigate. Activation is observed through a one-off submit listener.
      const submit = page.getByRole('button', { name: lookup(LAB[lang], 'showcase.form.submit') });
      await page.evaluate(() => {
        const w = window as unknown as { __submits: number };
        w.__submits = 0;
        document.querySelector('main form')?.addEventListener('submit', () => {
          w.__submits += 1;
        });
      });
      await submit.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __submits: number }).__submits))
        .toBe(2);
    });
  });
}
