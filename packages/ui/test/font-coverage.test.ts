// TC-F-001-14 (AC-8): the bundled fonts draw every code point the Arabic foundation needs (0
// missing glyphs), read from the real woff2 cmaps through the real @font-face unicode-ranges.
// The §7.2 coverage list is checked here; apps/ui-lab checks its 20-string sample set with the
// same functions (@ralysa/ui/font-coverage).
import { describe, expect, it } from 'vitest';
import {
  bundledFontFaces,
  cmapCodePoints,
  formatCodePoint,
  isCovered,
  missingCodePoints,
  MONO_STACK,
  parseFontFaces,
  SANS_STACK,
  woff2CodePoints,
} from '../scripts/font-coverage.ts';
import { fontPackageDir } from '../scripts/font-licenses.ts';

const faces = bundledFontFaces();

const range = (start: number, end: number): string =>
  String.fromCodePoint(...Array.from({ length: end - start + 1 }, (_, i) => start + i));

/** §7.2 "Coverage", plus the Latin and punctuation a mixed run uses. */
const REQUIRED: [string, string][] = [
  ['Arabic letters U+0621–064A', range(0x0621, 0x064a)],
  ['harakat U+064B–0652', range(0x064b, 0x0652)],
  ['Arabic-Indic digits U+0660–0669', range(0x0660, 0x0669)],
  ['Extended Arabic-Indic digits U+06F0–06F9', range(0x06f0, 0x06f9)],
  [
    'Arabic punctuation (comma, semicolon, question mark, percent, decimal and thousands)',
    '،؛؟٪٫٬',
  ],
  ['tatweel U+0640', 'ـ'],
  ['lam-alef presentation forms U+FEF5–FEFC', range(0xfef5, 0xfefc)],
  ['Basic Latin U+0020–007E', range(0x0020, 0x007e)],
  ['typographic quotes and dashes', '‘’“”–—…'],
];

describe('bundled font coverage (TC-F-001-14)', () => {
  it('reads the three packages’ faces', () => {
    const families = new Set(faces.map((face) => face.family));
    expect([...families].sort()).toEqual([
      'Noto Sans Arabic Variable',
      'Noto Sans Mono Variable',
      'Noto Sans Variable',
    ]);
    for (const face of faces) expect(woff2CodePoints(face.file).size).toBeGreaterThan(0);
  });

  it.each(REQUIRED)('the sans stack draws %s', (_what, text) => {
    expect(missingCodePoints(text, faces, SANS_STACK).map(formatCodePoint)).toEqual([]);
  });

  it('the mono stack draws Basic Latin (code, paths, identifiers)', () => {
    expect(missingCodePoints(range(0x20, 0x7e), faces, MONO_STACK).map(formatCodePoint)).toEqual(
      [],
    );
  });

  it('Arabic comes from Noto Sans Arabic, Latin from Noto Sans (§7.2 stack order)', () => {
    expect(isCovered(0x0627, faces, ['Noto Sans Variable'])).toBe(false);
    expect(isCovered(0x0627, faces, ['Noto Sans Arabic Variable'])).toBe(true);
    expect(isCovered(0x0041, faces, ['Noto Sans Variable'])).toBe(true);
  });

  it('skips default-ignorable code points (bidi controls, joiners), which are never drawn', () => {
    const controls = '\u200E\u200F\u061C\u2066\u2067\u2068\u2069\u200C\u200D';
    expect(missingCodePoints(controls, faces, SANS_STACK)).toEqual([]);
  });

  it('positive control: reports what the fonts really lack', () => {
    // Hebrew and CJK are outside every bundled subset.
    expect(missingCodePoints('א 字 ا', faces, SANS_STACK).map(formatCodePoint)).toEqual([
      'U+05D0',
      'U+5B57',
    ]);
    // In a unicode-range but deliberately checked against the wrong family: missing.
    expect(missingCodePoints('ا', faces, MONO_STACK).map(formatCodePoint)).toEqual(['U+0627']);
  });

  it('parses unicode-range wildcards and single points', () => {
    const [face] = parseFontFaces(
      `${fontPackageDir('@fontsource-variable/noto-sans-arabic')}/wght.css`,
    );
    expect(face?.ranges.length).toBeGreaterThan(1);
  });

  it('cmapCodePoints ignores code points mapped to .notdef (format 12)', () => {
    // cmap: version 0, one subtable (3,10) at offset 12: format 12 with two groups, the first
    // mapping U+0041–0042 to glyphs 5–6, the second mapping U+0043 to glyph 0 (.notdef).
    const cmap = Buffer.alloc(12 + 16 + 24);
    cmap.writeUInt16BE(0, 0);
    cmap.writeUInt16BE(1, 2);
    cmap.writeUInt16BE(3, 4);
    cmap.writeUInt16BE(10, 6);
    cmap.writeUInt32BE(12, 8);
    cmap.writeUInt16BE(12, 12);
    cmap.writeUInt32BE(40, 16);
    cmap.writeUInt32BE(2, 24);
    [
      [0x41, 0x42, 5],
      [0x43, 0x43, 0],
    ].forEach(([start = 0, end = 0, glyph = 0], index) => {
      cmap.writeUInt32BE(start, 28 + index * 12);
      cmap.writeUInt32BE(end, 32 + index * 12);
      cmap.writeUInt32BE(glyph, 36 + index * 12);
    });
    expect([...cmapCodePoints(cmap)]).toEqual([0x41, 0x42]);
  });
});
