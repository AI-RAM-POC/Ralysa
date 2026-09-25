// @vitest-environment jsdom
// Icon registry (§3.4; AC-7, unit level; TC-F-001-13 is the E2E geometry check): directional
// icons carry the RTL mirror class, non-directional icons never do; decorative icons are hidden
// from assistive technology, labelled ones are images with a name.
import { afterEach, describe, expect, it } from 'vitest';
import { Icon, ICON_NAMES, ICONS } from '../src/index.js';
import { render, type Rendered } from './render.js';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('icon registry', () => {
  it('marks the §3.4 directional icons, and only those, as directional', () => {
    const directional = ICON_NAMES.filter((name) => ICONS[name].directional);
    expect(directional).toEqual(
      expect.arrayContaining(['back', 'forward', 'chevronStart', 'chevronEnd', 'send']),
    );
    for (const name of ['search', 'check', 'close'] as const) {
      expect(ICONS[name].directional, name).toBe(false);
    }
    expect(new Set(directional)).toEqual(
      new Set(['back', 'forward', 'chevronStart', 'chevronEnd', 'send', 'undo', 'redo']),
    );
  });

  it.each(ICON_NAMES)('<Icon name="%s"> mirrors in RTL only if directional', async (name) => {
    view = await render(<Icon name={name} />, { locale: 'ar' });
    const svg = view.container.querySelector('svg');
    expect(svg?.getAttribute('data-icon')).toBe(name);
    expect(svg?.getAttribute('data-icon-directional')).toBe(String(ICONS[name].directional));
    expect(svg?.classList.contains('rtl:-scale-x-100')).toBe(ICONS[name].directional);
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
  });

  it('a labelled icon is an image with an accessible name', async () => {
    view = await render(<Icon name="info" label="Details" size="lg" />);
    const svg = view.container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Details');
    expect(svg?.hasAttribute('aria-hidden')).toBe(false);
    expect(svg?.classList.contains('size-icon-lg')).toBe(true);
  });
});
