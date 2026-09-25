// @vitest-environment node
// The 20-string Arabic sample set (F-001 design §7.6; AC-8) and TC-F-001-14 for it: the set has
// the designed composition, every sample file carries the demo sentinel (AC-13), and the bundled
// fonts draw every code point of every sample (0 missing glyphs), read from the real woff2 files.
import {
  bundledFontFaces,
  formatCodePoint,
  missingCodePoints,
  MONO_STACK,
  SANS_STACK,
} from '@ralysa/ui/font-coverage';
import { describe, expect, it } from 'vitest';
import arabicFile from '../src/samples/arabic-samples.json';
import dataFile from '../src/samples/example-data.json';
import { ARABIC_SAMPLES, DEMO_SENTINEL, EXAMPLE_DATA } from '../src/samples/index.js';

const faces = bundledFontFaces();
const count = (category: string): number =>
  ARABIC_SAMPLES.filter((sample) => sample.category === category).length;
const has = (pattern: RegExp) => ARABIC_SAMPLES.some((sample) => pattern.test(sample.text));

describe('the Arabic sample set (§7.6)', () => {
  it('has 20 samples: 8 pure, 6 mixed, 3 with Western and 3 with Arabic-Indic digits', () => {
    expect(ARABIC_SAMPLES).toHaveLength(20);
    expect([
      count('pure'),
      count('mixed'),
      count('westernDigits'),
      count('arabicIndicDigits'),
    ]).toEqual([8, 6, 3, 3]);
    expect(new Set(ARABIC_SAMPLES.map((sample) => sample.id)).size).toBe(20);
  });

  it('covers the shaping cases the design lists', () => {
    expect(has(/[ً-ْ]/u), 'harakat').toBe(true);
    expect(has(/ل[اأإآ]/u), 'lam-alef ligatures').toBe(true);
    expect(has(/ـ/u), 'tatweel').toBe(true);
    expect(
      ARABIC_SAMPLES.some((sample) => sample.text.length > 150),
      'a long paragraph',
    ).toBe(true);
    expect(has(/https:\/\//u), 'a URL').toBe(true);
    expect(has(/\w+\(\)/u), 'a code identifier').toBe(true);
    expect(has(/@example\.com/u), 'an email-like placeholder').toBe(true);
    expect(has(/[«(]/u), 'parentheses and quotes').toBe(true);
    expect(has(/^[A-Za-z]/u) && has(/[A-Za-z]$/u), 'Latin at the start and at the end').toBe(true);
    expect(has(/[0-9]{4}-[0-9]{2}-[0-9]{2}/u), 'a date-like string').toBe(true);
    expect(has(/[0-9]+%/u), 'a percentage').toBe(true);
    expect(has(/[0-9]+\.[0-9]+\.[0-9]+/u), 'a version number').toBe(true);
    expect(has(/[٠-٩]/u), 'Arabic-Indic digits').toBe(true);
    expect(has(/[۰-۹]/u), 'Extended Arabic-Indic digits').toBe(true);
  });

  it('every non-mixed sample is Arabic script; mixed samples also carry Latin', () => {
    for (const sample of ARABIC_SAMPLES) {
      expect(sample.text, sample.id).toMatch(/\p{Script=Arabic}/u);
      if (sample.category === 'mixed') expect(sample.text, sample.id).toMatch(/[A-Za-z]/u);
    }
  });

  it('every sample file carries the demo sentinel (check-no-demo, AC-13)', () => {
    expect(DEMO_SENTINEL).toBe('__RALYSA_DEMO_ONLY__');
    expect(arabicFile[DEMO_SENTINEL]).toBe(true);
    expect(dataFile[DEMO_SENTINEL]).toBe(true);
  });
});

describe('TC-F-001-14: 0 missing glyphs in the bundled fonts', () => {
  it.each(ARABIC_SAMPLES.map((sample) => [sample.id, sample.text] as const))(
    '%s: the sans stack draws every code point',
    (_id, text) => {
      expect(missingCodePoints(text, faces, SANS_STACK).map(formatCodePoint)).toEqual([]);
    },
  );

  it('the code, path and identifier values draw in the mono stack', () => {
    for (const [id, text] of Object.entries(EXAMPLE_DATA)) {
      expect(missingCodePoints(text.replaceAll('\n', ''), faces, MONO_STACK), id).toEqual([]);
    }
  });
});
