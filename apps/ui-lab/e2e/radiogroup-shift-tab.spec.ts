// D-F001-E2E-1 (TC-F-001-24; AC-12, WCAG 2.1.2): Shift+Tab from a RadioGroup item leaves the
// group, in chromium, firefox AND webkit, in en and ar. Before the fix, Firefox moved focus to
// the Radix group element, which handed it straight back to the checked item (a keyboard trap).
//
// This is the one keyboard check that runs in webkit too. The design keeps the full keyboard walk
// out of webkit because its Tab-to-links default differs from Safari's user setting (§8.2); that
// doesn't matter here, because this only checks that focus leaves the group backwards and that Tab
// comes back into it, whatever element sits before it.
import { expect, openLab, test } from './helpers/fixtures.js';
import { LOCALES } from './helpers/urls.js';

for (const lang of LOCALES) {
  test(`${lang}: Shift+Tab from every RadioGroup leaves the group, and Tab returns to it`, async ({
    page,
  }) => {
    await openLab(page, 'showcase', { lang, theme: 'light' });
    const groups = page.getByRole('radiogroup');
    const count = await groups.count();
    // The showcase's priority group and the theme switcher, at least.
    expect(count).toBeGreaterThanOrEqual(2);

    for (let index = 0; index < count; index += 1) {
      const group = groups.nth(index);
      const name = (await group.getAttribute('aria-labelledby')) ?? `radiogroup ${String(index)}`;
      const checked = group.getByRole('radio', { checked: true });
      await checked.focus();
      await expect(checked, name).toBeFocused();

      await page.keyboard.press('Shift+Tab');
      // Focus is outside the group: not on an item and not on the group element itself.
      await expect
        .poll(
          () =>
            group.evaluate((element) => {
              const active = document.activeElement;
              return active !== null && active !== document.body && !element.contains(active);
            }),
          { message: `${name}: Shift+Tab left the group` },
        )
        .toBe(true);

      // The group is a tab stop again: its tabIndex was only dropped while tabbing back out.
      await expect(
        group,
        `${name}: the group's tabindex is restored after blur`,
      ).not.toHaveAttribute('tabindex', '-1');
      await page.keyboard.press('Tab');
      await expect(checked, `${name}: Tab re-enters on the checked item`).toBeFocused();
    }
  });
}
