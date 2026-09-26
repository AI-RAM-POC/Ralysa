// TC-F-001-24 (AC-12; §7.7): the keyboard walk of the showcase, in chromium and firefox, in en and
// ar. Checks every visible focusable element is reached once, Tab leaves the page at the end and
// Shift+Tab reverses (no trap), Tab follows the visual reading order (right-to-left in ar), and
// every focus state shows a ring of at least 2 px and 3:1. Then the operation keys: Escape closes
// the Select popover and returns focus to its trigger, Enter and Space open it, typeahead picks an
// option, Space toggles the Checkbox (T11-4), and arrow keys move through the RadioGroup in the
// reading direction (Radix DirectionProvider).
import type { Locator } from '@playwright/test';
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
      browserName,
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
      expect(reachedEdge(forward, browserName)).toBe(true);

      expect(readingOrderProblems(forward.stops, lang === 'ar' ? 'rtl' : 'ltr')).toEqual([]);
      expect(ringProblems(forward.stops)).toEqual([]);
    });

    test('Shift+Tab walks the same stops in reverse and reaches the top (no trap)', async ({
      page,
      browserName,
    }) => {
      const expected = await indexFocusables(page);
      const reversed = expected.map((_, index) => index).reverse();
      const forward = await walk(page, 'Tab');
      expect(reachedEdge(forward, browserName)).toBe(true);
      // Chromium: focus left the page and Shift+Tab re-enters at the last stop. Firefox: focus
      // stayed on the last stop, so the walk back starts there.
      const backward = await walk(page, 'Shift+Tab', { fromCurrent: forward.end === 'stayed' });
      const ids = backward.stops.map((stop) => stop.id);
      // Every engine, Firefox included since D-F001-E2E-1 was fixed (RadioGroup drops its group
      // element out of the tab order synchronously on Shift+Tab; radiogroup-shift-tab.spec.ts).
      expect(ids, backward.stops.map((stop) => stop.label).join('\n')).toEqual(reversed);
      expect(reachedEdge(backward, browserName)).toBe(true);
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
      // keydown), so hold the key, as a person does, until focus has moved, then release it.
      // Condition waits, not a fixed delay, so a loaded runner can't release it too early.
      const arrow = async (key: string, target: Locator): Promise<void> => {
        await page.keyboard.down(key);
        await expect(target).toBeFocused();
        await page.keyboard.up(key);
        await expect(target).toBeChecked();
      };
      await arrow(lang === 'ar' ? 'ArrowLeft' : 'ArrowRight', radio('high'));
      await arrow(lang === 'ar' ? 'ArrowRight' : 'ArrowLeft', radio('normal'));
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
