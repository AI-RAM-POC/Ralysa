// TC-F-001-22 (AC-11): the WCAG ratio function matches reference values, MIN_RATIO is applied per
// kind, and translucent colours, unresolved tokens and exempt tokens in pairs are rejected.
import { describe, expect, it } from 'vitest';
import {
  type ContrastColor,
  type ContrastPairInput,
  checkContrast,
  contrastRatio,
  MIN_RATIO,
  relativeLuminance,
} from '../src/check-contrast.ts';

describe('contrastRatio (WCAG 2.1)', () => {
  it.each([
    ['#000000', '#ffffff', 21],
    ['#ffffff', '#ffffff', 1],
    ['#777777', '#ffffff', 4.478],
    ['#767676', '#ffffff', 4.542],
    ['#595959', '#ffffff', 7.0],
    ['#2b55c9', '#ffffff', 6.47],
    ['#1a1d21', '#f3f4f6', 15.37],
  ])('%s on %s = %f:1', (fg, bg, expected) => {
    expect(contrastRatio(fg, bg)).toBeCloseTo(expected, 2);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#2b55c9', '#ffffff')).toBe(contrastRatio('#ffffff', '#2b55c9'));
  });

  it('uses the sRGB linearisation threshold', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    // #0a0a0a is below the 0.04045 knee (10/255 = 0.0392), so it is divided by 12.92.
    expect(relativeLuminance('#0a0a0a')).toBeCloseTo(10 / 255 / 12.92, 10);
  });

  it('rejects anything but #rrggbb', () => {
    expect(() => relativeLuminance('#fff')).toThrow(/#rrggbb/);
    expect(() => relativeLuminance('rgb(0 0 0)')).toThrow(/#rrggbb/);
  });
});

describe('checkContrast', () => {
  const colours: Record<string, Record<string, ContrastColor>> = {
    light: {
      'color.bg.canvas': { hex: '#ffffff' },
      'color.fg.grey': { hex: '#777777' }, // 4.48:1: fails text, passes largeText/nonText/focus
      'color.fg.ok': { hex: '#767676' }, // 4.54:1: passes text
      'color.fg.glass': { hex: '#000000', alpha: 0.6 },
      'color.fg.disabled': { hex: '#aaaaaa' },
    },
  };
  const resolve = (theme: string, token: string): ContrastColor | undefined =>
    colours[theme]?.[token];
  const pair = (fg: string, kind: ContrastPairInput['kind']): ContrastPairInput => ({
    fg,
    bg: 'color.bg.canvas',
    kind,
    themes: ['light'],
    usage: 'fixture',
  });

  it('applies MIN_RATIO per kind', () => {
    expect(MIN_RATIO).toEqual({ text: 4.5, largeText: 3, nonText: 3, focus: 3 });
    const { findings, results } = checkContrast({
      pairs: [
        pair('color.fg.grey', 'text'),
        pair('color.fg.grey', 'largeText'),
        pair('color.fg.grey', 'nonText'),
        pair('color.fg.grey', 'focus'),
        pair('color.fg.ok', 'text'),
      ],
      resolve,
    });
    expect(results.map((r) => r.pass)).toEqual([false, true, true, true, true]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('contrast/below-minimum');
    expect(findings[0]?.message).toMatch(/4\.48:1 is below 4\.5:1/);
  });

  it('never rounds a ratio up to pass', () => {
    // 4.478 would print as 4.5 with one decimal; it must still fail.
    const { findings } = checkContrast({ pairs: [pair('color.fg.grey', 'text')], resolve });
    expect(findings.map((f) => f.rule)).toEqual(['contrast/below-minimum']);
  });

  it('rejects translucent colours in a pair', () => {
    const { findings } = checkContrast({ pairs: [pair('color.fg.glass', 'text')], resolve });
    expect(findings.map((f) => f.rule)).toEqual(['contrast/translucent']);
  });

  it('reports a token missing from a theme', () => {
    const { findings } = checkContrast({
      pairs: [{ ...pair('color.fg.ok', 'text'), themes: ['light', 'dark'] }],
      resolve,
    });
    expect(findings.map((f) => f.rule)).toEqual(['contrast/unresolved']);
    expect(findings[0]?.message).toMatch(/\[dark\]/);
  });

  it('rejects an exempt token used in a checked pair', () => {
    const { findings } = checkContrast({
      pairs: [pair('color.fg.disabled', 'nonText')],
      exempt: [{ token: 'color.fg.disabled', reason: 'inactive components (WCAG 1.4.3)' }],
      resolve,
    });
    expect(findings.map((f) => f.rule)).toContain('contrast/exempt-token-in-pair');
  });
});
