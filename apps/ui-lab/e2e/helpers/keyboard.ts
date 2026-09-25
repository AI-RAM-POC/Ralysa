// The keyboard walker (F-001 design §7.7, §8.4 TC-F-001-24; AC-12). It presses Tab through a page
// and records every stop: which element, its box, its landmark region and its focus ring. The
// keyboard spec then checks, from those stops:
//   - every visible focusable element is reached, once (nothing skipped, no cycle);
//   - Tab past the last element leaves the page, and Shift+Tab walks the same stops in reverse
//     (no trap);
//   - on one visual line inside a region, Tab moves left-to-right in `en` and right-to-left in
//     `ar` (reading order);
//   - each stop shows an outline ring at least 2 px wide with at least 3:1 contrast against the
//     colour behind it (WCAG 2.4.7, 1.4.11).
import type { Page } from '@playwright/test';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Ring {
  style: string;
  width: number;
  color: string;
  background: string;
  contrast: number;
}

export interface Stop {
  /** Index in the page's focusable list (indexFocusables), or -1 for an element not in it. */
  id: number;
  /** tag, role and accessible-ish name, for messages. */
  label: string;
  /** data-region of the enclosing AppShell region, or null. */
  region: string | null;
  box: Box;
  ring: Ring;
}

interface KbdApi {
  index(): string[];
  current(): Stop | null;
}

declare global {
  interface Window {
    __e2eKbd?: KbdApi;
  }
}

/**
 * Installs the in-page helpers and indexes the focusable elements: in DOM order, enabled, not
 * inert, rendered and visible, with tabIndex >= 0 (roving-tabindex items that are out of the tab
 * order have -1). Returns their labels in index order.
 */
export async function indexFocusables(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const SELECTOR =
      'a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable="true"]';

    const rgba = (color: string): [number, number, number, number] => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx === null) throw new Error('no 2d context');
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const channel = (c: number): number => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (a: string, b: string): number => {
      const la = luminance(rgba(a));
      const lb = luminance(rgba(b));
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    // The colour behind the ring: the ring is drawn outside the element (outline-offset), so it
    // sits on the nearest ancestor that paints an opaque background.
    const backgroundBehind = (element: Element): string => {
      for (let node = element.parentElement; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (rgba(color)[3] >= 0.99) return color;
      }
      return getComputedStyle(document.documentElement).backgroundColor;
    };
    const visible = (element: HTMLElement): boolean =>
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      element.getClientRects().length > 0;
    const label = (element: HTMLElement): string => {
      const role = element.getAttribute('role');
      const name =
        element.getAttribute('aria-label') ??
        ((element as HTMLInputElement).labels?.[0]?.textContent ?? element.textContent)
          .trim()
          .slice(0, 40);
      return `${element.tagName.toLowerCase()}${role === null ? '' : `[role=${role}]`} "${name}"`;
    };

    const list = [...document.querySelectorAll<HTMLElement>(SELECTOR)].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !(element as HTMLButtonElement).disabled &&
        element.closest('[inert]') === null &&
        visible(element),
    );
    const ids = new Map(list.map((element, index) => [element, index]));
    // A roving-tabindex group (Radix RadioGroup, Tabs) is one tab stop: the group element has
    // tabIndex 0 and passes focus on to its active item. The item then counts as that stop.
    const indexOf = (element: Element): number => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const id = ids.get(node as HTMLElement);
        if (id !== undefined) return id;
      }
      return -1;
    };

    window.__e2eKbd = {
      index: () => list.map(label),
      current: () => {
        // Focus left the page: Chromium moves it to <body>; Firefox moves it to the browser UI,
        // leaving activeElement on the last element but the document without focus.
        const element = document.activeElement;
        if (!document.hasFocus()) return null;
        if (!(element instanceof HTMLElement) || element === document.body) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const background = backgroundBehind(element);
        return {
          id: indexOf(element),
          label: label(element),
          region: element.closest('[data-region]')?.getAttribute('data-region') ?? null,
          box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          ring: {
            style: style.outlineStyle,
            width: parseFloat(style.outlineWidth),
            color: style.outlineColor,
            background,
            contrast: contrast(style.outlineColor, background),
          },
        };
      },
    };
    return window.__e2eKbd.index();
  });
}

async function current(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    if (window.__e2eKbd === undefined) throw new Error('call indexFocusables first');
    return window.__e2eKbd.current();
  });
}

/**
 * How a walk ended:
 * - `left-page`: a press moved focus out of the document (Chromium: to <body>);
 * - `stayed`: a press left focus where it was. Headless Firefox under Playwright has no browser
 *   UI to move focus to, so Tab on the last element (Shift+Tab on the first) keeps it there;
 *   that is the edge of the page, not a trap;
 * - `cycled`: focus came back to an earlier stop without leaving: a focus trap;
 * - `max`: the press budget ran out.
 */
export type WalkEnd = 'left-page' | 'stayed' | 'cycled' | 'max';

export interface Walk {
  stops: Stop[];
  end: WalkEnd;
}

const stopKey = (stop: Stop): string =>
  `${String(stop.id)}|${stop.label}|${String(stop.box.left)}|${String(stop.box.top)}`;

/**
 * Presses `key` (Tab or Shift+Tab) until focus leaves the page, stays put, returns to an earlier
 * stop, or `max` presses. Call indexFocusables first. `fromCurrent` records the focused element
 * as the first stop (to walk back from where a Firefox forward walk stayed).
 */
export async function walk(
  page: Page,
  key: 'Tab' | 'Shift+Tab',
  { max = 400, fromCurrent = false }: { max?: number; fromCurrent?: boolean } = {},
): Promise<Walk> {
  const stops: Stop[] = [];
  const seen = new Set<string>();
  if (fromCurrent) {
    const start = await current(page);
    if (start !== null) {
      stops.push(start);
      seen.add(stopKey(start));
    }
  }
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    const stop = await current(page);
    if (stop === null) return { stops, end: 'left-page' };
    const k = stopKey(stop);
    const last = stops.at(-1);
    if (last !== undefined && stopKey(last) === k) return { stops, end: 'stayed' };
    if (seen.has(k)) return { stops: [...stops, stop], end: 'cycled' };
    seen.add(k);
    stops.push(stop);
  }
  return { stops, end: 'max' };
}

/**
 * A walk that reached the edge of the page. Focus leaving the document counts everywhere.
 * Focus staying on the last stop counts only in Firefox, where Playwright's headless browser
 * has no UI to move focus to; in any other engine it would hide a stuck focus.
 */
export const reachedEdge = (w: Walk, browserName: string): boolean =>
  w.end === 'left-page' || (w.end === 'stayed' && browserName === 'firefox');

const sameLine = (a: Box, b: Box): boolean => {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlap > 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top);
};

/**
 * Consecutive stops in one region and on one visual line that go against the reading direction:
 * leftwards in `ltr`, rightwards in `rtl`. Tab must follow the visual reading order (AC-12).
 */
export function readingOrderProblems(stops: readonly Stop[], dir: 'ltr' | 'rtl'): string[] {
  const problems: string[] = [];
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const next = stops[i];
    if (prev === undefined || next === undefined) continue;
    if (prev.region !== next.region || !sameLine(prev.box, next.box)) continue;
    const forward = dir === 'ltr' ? next.box.left > prev.box.left : next.box.right < prev.box.right;
    if (!forward) problems.push(`${prev.label} → ${next.label} goes against ${dir} on one line`);
  }
  return problems;
}

/** Stops whose focus ring is missing, thinner than 2 px or below 3:1 against its background. */
export function ringProblems(stops: readonly Stop[]): string[] {
  return stops
    .filter((s) => s.ring.style === 'none' || s.ring.width < 2 || s.ring.contrast < 3)
    .map(
      (s) =>
        `${s.label}: outline ${s.ring.style} ${String(s.ring.width)}px ${s.ring.color} on ${s.ring.background} = ${s.ring.contrast.toFixed(2)}:1`,
    );
}
