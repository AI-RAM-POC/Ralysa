// @vitest-environment jsdom
// Components II (F-001-T11; §7.5, §7.7, §7.4.2): the Radix form controls, their labels and
// descriptions, direction-aware arrow keys (the LocaleProvider → Radix DirectionProvider wiring:
// in `ar` ArrowLeft moves forward), the Select popover on color.bg.surfaceRaised with Escape
// returning focus, and the locale and theme switchers. Test mode: any missing key throws.
import './jsdom-polyfills.js';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Checkbox,
  LocaleSwitcher,
  RadioGroup,
  Select,
  Tabs,
  TextField,
  ThemeSwitcher,
} from '../src/index.js';
import { click, press, render, type Rendered } from './render.js';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  document.documentElement.removeAttribute('data-theme');
});

const byId = (id: string | null | undefined): HTMLElement | null =>
  id === null || id === undefined ? null : document.getElementById(id);

async function focus(element: Element | null | undefined): Promise<void> {
  await act(async () => {
    (element as HTMLElement | null)?.focus();
    await Promise.resolve();
  });
}

describe('TextField', () => {
  it('labels the input and describes it with the hint and the error', async () => {
    view = await render(
      <TextField label="Email" description="Work address" error="Required" required />,
    );
    const input = view.container.querySelector('input');
    const label = view.container.querySelector('label');
    expect(label?.getAttribute('for')).toBe(input?.id);
    expect(label?.textContent).toBe('Email (required)');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.required).toBe(true);
    const described = (input?.getAttribute('aria-describedby') ?? '').split(' ').map(byId);
    expect(described.map((element) => element?.textContent)).toEqual(['Work address', 'Required']);
  });

  it('is valid and undescribed when there is no hint or error; the marker is translated', async () => {
    view = await render(<TextField label="البريد" required />, { locale: 'ar' });
    const input = view.container.querySelector('input');
    expect(input?.hasAttribute('aria-invalid')).toBe(false);
    expect(input?.hasAttribute('aria-describedby')).toBe(false);
    expect(view.container.querySelector('label')?.textContent).toBe('البريد (مطلوب)');
  });
});

describe('Checkbox', () => {
  it('toggles from its label and exposes checked and mixed states', async () => {
    const onCheckedChange = vi.fn();
    view = await render(
      <div>
        <Checkbox label="Terms" description="Read them" onCheckedChange={onCheckedChange} />
        <Checkbox label="Some" checked="indeterminate" />
      </div>,
    );
    const [box, mixed] = view.container.querySelectorAll('button[role="checkbox"]');
    expect(box?.getAttribute('aria-checked')).toBe('false');
    expect(byId(box?.getAttribute('aria-describedby'))?.textContent).toBe('Read them');
    const label = view.container.querySelector(`label[for="${box?.id ?? ''}"]`);
    if (label !== null) await click(label);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(box?.getAttribute('aria-checked')).toBe('true');
    expect(mixed?.getAttribute('aria-checked')).toBe('mixed');
  });
});

const PLANS = [
  { value: 'basic', label: 'Basic' },
  { value: 'pro', label: 'Pro' },
  { value: 'team', label: 'Team' },
];

describe('RadioGroup: direction-aware arrow keys', () => {
  const group = (
    <RadioGroup label="Plan" orientation="horizontal" defaultValue="basic" options={PLANS} />
  );

  it('is a named radiogroup whose options are labelled', async () => {
    view = await render(group);
    const radiogroup = view.container.querySelector('[role="radiogroup"]');
    expect(byId(radiogroup?.getAttribute('aria-labelledby'))?.textContent).toBe('Plan');
    const radios = [...view.container.querySelectorAll('[role="radio"]')];
    expect(
      radios.map((radio) => view?.container.querySelector(`label[for="${radio.id}"]`)?.textContent),
    ).toEqual(['Basic', 'Pro', 'Team']);
  });

  it.each([
    ['en', 'ArrowRight', 'ArrowLeft'],
    ['ar', 'ArrowLeft', 'ArrowRight'],
  ] as const)('in %s, %s moves to the next option and %s back', async (locale, next, back) => {
    view = await render(group, { locale });
    const radios = [...view.container.querySelectorAll<HTMLElement>('[role="radio"]')];
    await focus(radios[0]);
    await press(radios[0] as HTMLElement, next);
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1]?.getAttribute('aria-checked')).toBe('true');
    await press(radios[1] as HTMLElement, back);
    expect(document.activeElement).toBe(radios[0]);
  });
});

describe('RadioGroup: Shift+Tab leaves the group (D-F001-E2E-1, WCAG 2.1.2)', () => {
  it('takes the group element out of the tab order before the browser moves focus', async () => {
    view = await render(
      <RadioGroup label="Plan" orientation="horizontal" defaultValue="pro" options={PLANS} />,
    );
    const radiogroup = view.container.querySelector<HTMLElement>('[role="radiogroup"]');
    const checked = view.container.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"]',
    );
    expect(radiogroup?.tabIndex).toBe(0);
    await focus(checked);

    // The browser moves focus as the keydown's default action, after every listener has run but,
    // in Firefox, before microtasks run. A listener on the document (after React's, on the root
    // container) sees the tabIndex at that moment. No microtask or task runs in between.
    let atDefaultAction: number | undefined;
    const record = (): void => {
      atDefaultAction = radiogroup?.tabIndex;
    };
    document.addEventListener('keydown', record);
    try {
      act(() => {
        checked?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    } finally {
      document.removeEventListener('keydown', record);
    }
    expect(atDefaultAction).toBe(-1);

    // Once focus has left, the group is a tab stop again, so Tab can enter it.
    await act(async () => {
      checked?.blur();
      await Promise.resolve();
    });
    expect(radiogroup?.tabIndex).toBe(0);
  });

  it('keeps a caller onKeyDown and onBlur', async () => {
    const onKeyDown = vi.fn();
    const onBlur = vi.fn();
    view = await render(
      <RadioGroup
        label="Plan"
        defaultValue="basic"
        options={PLANS}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />,
    );
    const checked = view.container.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"]',
    );
    await focus(checked);
    await press(checked as HTMLElement, 'Tab', { shiftKey: true });
    await act(async () => {
      checked?.blur();
      await Promise.resolve();
    });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

describe('Tabs: direction-aware arrow keys', () => {
  const tabs = (
    <Tabs
      label="Sections"
      items={[
        { value: 'a', label: 'A', content: 'first' },
        { value: 'b', label: 'B', content: 'second' },
        { value: 'c', label: 'C', content: 'third' },
      ]}
    />
  );

  it('names the tab list and links tabs to panels', async () => {
    view = await render(tabs);
    const list = view.container.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe('Sections');
    const [first] = view.container.querySelectorAll('[role="tab"]');
    const panel = byId(first?.getAttribute('aria-controls'));
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.textContent).toBe('first');
  });

  it.each([
    ['en', 'ArrowRight', 'ltr'],
    ['ar', 'ArrowLeft', 'rtl'],
  ] as const)('in %s, %s activates the next tab (Radix dir %s)', async (locale, next, dir) => {
    view = await render(tabs, { locale });
    const tabElements = [...view.container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(
      view.container.querySelector('[role="tablist"]')?.closest('[dir]')?.getAttribute('dir'),
    ).toBe(dir);
    await focus(tabElements[0]);
    await press(tabElements[0] as HTMLElement, next);
    expect(document.activeElement).toBe(tabElements[1]);
    expect(tabElements[1]?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('Select: the raised popover', () => {
  const REGIONS = [
    { value: 'gulf', label: 'Gulf' },
    { value: 'europe', label: 'Europe' },
  ];

  it('opens from the keyboard on color.bg.surfaceRaised, follows the direction, and Escape returns focus', async () => {
    const onValueChange = vi.fn();
    view = await render(<Select label="Region" options={REGIONS} onValueChange={onValueChange} />, {
      locale: 'ar',
    });
    const trigger = view.container.querySelector<HTMLElement>('[role="combobox"]');
    expect(byId(trigger?.getAttribute('aria-labelledby'))?.textContent).toBe('Region');
    expect(trigger?.textContent).toBe('اختر خيارًا');
    await focus(trigger);
    await press(trigger as HTMLElement, 'Enter');
    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const content = listbox?.closest('.bg-surface-raised');
    expect(content?.className).toContain('shadow-md');
    expect(content?.getAttribute('dir')).toBe('rtl');
    await press(document.activeElement ?? document.body, 'Escape');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('selects an option with Enter', async () => {
    const onValueChange = vi.fn();
    view = await render(<Select label="Region" options={REGIONS} onValueChange={onValueChange} />);
    const trigger = view.container.querySelector<HTMLElement>('[role="combobox"]');
    await focus(trigger);
    await press(trigger as HTMLElement, 'ArrowDown');
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(['Gulf', 'Europe']);
    await focus(options[1]);
    await press(options[1] as HTMLElement, 'Enter');
    expect(onValueChange).toHaveBeenCalledWith('europe');
    expect(trigger?.textContent).toBe('Europe');
  });
});

describe('LocaleSwitcher and ThemeSwitcher', () => {
  it('switching the locale sets <html lang dir> and names each language in itself', async () => {
    view = await render(<LocaleSwitcher />);
    const marker = Symbol('no reload');
    (window as unknown as Record<symbol, boolean>)[marker] = true;
    const trigger = view.container.querySelector<HTMLElement>('[role="combobox"]');
    expect(trigger?.querySelector('[lang="en"]')?.textContent).toBe('English');
    await focus(trigger);
    await press(trigger as HTMLElement, 'ArrowDown');
    const arabic = document.querySelector<HTMLElement>('[role="option"] [lang="ar"]');
    expect(arabic?.textContent).toBe('العربية');
    const option = arabic?.closest<HTMLElement>('[role="option"]');
    await focus(option);
    await press(option as HTMLElement, 'Enter');
    await act(async () => {
      await view?.i18n.loadLanguages('ar');
    });
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect((window as unknown as Record<symbol, boolean>)[marker]).toBe(true);
    expect(view.container.querySelector('label')?.textContent).toBe('اللغة');
  });

  it('switching the theme sets data-theme; system removes it', async () => {
    view = await render(<ThemeSwitcher />);
    const radio = (name: string): HTMLElement | null => {
      const label = [...(view?.container.querySelectorAll('label') ?? [])].find(
        (element) => element.textContent === name,
      );
      return byId(label?.getAttribute('for'));
    };
    expect(radio('System')?.getAttribute('aria-checked')).toBe('true');
    await click(radio('Dark') as HTMLElement);
    expect(document.documentElement.dataset.theme).toBe('dark');
    await click(radio('Light') as HTMLElement);
    expect(document.documentElement.dataset.theme).toBe('light');
    await click(radio('System') as HTMLElement);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
