// Font coverage (F-001 design §7.2; AC-8, TC-F-001-14): which code points the bundled fonts can
// draw. It reads the real woff2 files the @font-face rules point at, so "0 missing glyphs" is
// checked against exactly what ships, not against a font's documentation.
//   - parseFontFaces(): the @font-face rules of a Fontsource CSS file (family, file, unicode-range)
//   - woff2CodePoints(): the code points a woff2 file's cmap maps to a real glyph (dependency-free:
//     WOFF2 table directory + the stream decompressed with node:zlib Brotli + cmap formats 4, 12)
//   - missingCodePoints(): what a browser would fail to draw from a font stack, the way it picks
//     a face: for each family in order, the faces whose unicode-range holds the code point
// Default-ignorable code points (bidi controls LRM/RLM/ALM, LRI/RLI/FSI/PDI, ZWJ/ZWNJ, …) are
// never drawn as glyphs, so they are skipped.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { FONT_PACKAGES, fontPackageDir } from './font-licenses.ts';

export interface FontFaceRule {
  family: string;
  /** Absolute path of the woff2 file. */
  file: string;
  /** Inclusive code-point ranges; all of Unicode when the rule has no unicode-range. */
  ranges: [number, number][];
}

const ALL_UNICODE: [number, number][] = [[0, 0x10ffff]];

function parseRanges(value: string): [number, number][] {
  return value.split(',').map((part): [number, number] => {
    const token = part.trim().replace(/^U\+/i, '');
    if (token.includes('?')) {
      return [parseInt(token.replaceAll('?', '0'), 16), parseInt(token.replaceAll('?', 'F'), 16)];
    }
    const [start = '', end = start] = token.split('-');
    return [parseInt(start, 16), parseInt(end, 16)];
  });
}

/** The @font-face rules of a CSS file with relative `url()` sources (Fontsource's layout). */
export function parseFontFaces(cssFile: string): FontFaceRule[] {
  const css = readFileSync(cssFile, 'utf8');
  const rules: FontFaceRule[] = [];
  for (const [, body = ''] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family:\s*['"]?([^;'"]+)['"]?\s*;/.exec(body)?.[1];
    const url = /src:\s*url\(\s*['"]?([^)'"]+\.woff2)['"]?\s*\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
    if (family === undefined || url === undefined) {
      throw new Error(`${cssFile}: @font-face without a family or a woff2 source`);
    }
    rules.push({
      family,
      file: join(dirname(cssFile), url),
      ranges: range === undefined ? ALL_UNICODE : parseRanges(range),
    });
  }
  return rules;
}

// --- WOFF2 (W3C WOFF File Format 2.0) -------------------------------------------------------

const WOFF2_SIGNATURE = 0x774f4632; // 'wOF2'
const CMAP_TAG_INDEX = 0; // the known-tag table: index 0 is 'cmap'
const GLYF_TAG_INDEX = 10;
const LOCA_TAG_INDEX = 11;

function readBase128(bytes: Buffer, offset: number): [value: number, next: number] {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = bytes.readUInt8(offset + i);
    if (i === 0 && byte === 0x80) throw new Error('woff2: UIntBase128 with a leading zero');
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, offset + i + 1];
  }
  throw new Error('woff2: UIntBase128 longer than 5 bytes');
}

/** The raw cmap table of a woff2 file (it is never transformed, only compressed). */
export function woff2Cmap(bytes: Buffer): Buffer {
  if (bytes.readUInt32BE(0) !== WOFF2_SIGNATURE) throw new Error('not a woff2 file');
  if (bytes.readUInt32BE(4) === 0x74746366)
    throw new Error('woff2 font collections are not supported');
  const numTables = bytes.readUInt16BE(12);
  const compressedLength = bytes.readUInt32BE(20);
  let offset = 48;
  let streamOffset = 0;
  let cmap: { start: number; length: number } | undefined;
  for (let i = 0; i < numTables; i += 1) {
    const flags = bytes.readUInt8(offset);
    offset += 1;
    const tagIndex = flags & 0x3f;
    let tag = '';
    if (tagIndex === 63) {
      tag = bytes.toString('latin1', offset, offset + 4);
      offset += 4;
    }
    const transform = flags >> 6;
    const [origLength, afterOrig] = readBase128(bytes, offset);
    offset = afterOrig;
    // glyf and loca use transform 0 for "transformed"; every other table uses 0 for "none".
    const glyfOrLoca = tagIndex === GLYF_TAG_INDEX || tagIndex === LOCA_TAG_INDEX;
    const transformed = glyfOrLoca ? transform !== 3 : transform !== 0;
    let length = origLength;
    if (transformed) {
      const [transformLength, afterTransform] = readBase128(bytes, offset);
      offset = afterTransform;
      length = transformLength;
    }
    if (tagIndex === CMAP_TAG_INDEX || tag === 'cmap') cmap = { start: streamOffset, length };
    streamOffset += length;
  }
  if (cmap === undefined) throw new Error('woff2: no cmap table');
  const stream = brotliDecompressSync(bytes.subarray(offset, offset + compressedLength));
  return stream.subarray(cmap.start, cmap.start + cmap.length);
}

/** Code points the cmap maps to a glyph other than .notdef (formats 4 and 12, all subtables). */
export function cmapCodePoints(cmap: Buffer): Set<number> {
  const points = new Set<number>();
  const numTables = cmap.readUInt16BE(2);
  const seen = new Set<number>();
  for (let i = 0; i < numTables; i += 1) {
    const subtable = cmap.readUInt32BE(4 + i * 8 + 4);
    if (seen.has(subtable)) continue;
    seen.add(subtable);
    const format = cmap.readUInt16BE(subtable);
    if (format === 4) readFormat4(cmap, subtable, points);
    else if (format === 12) readFormat12(cmap, subtable, points);
  }
  return points;
}

function readFormat4(cmap: Buffer, at: number, points: Set<number>): void {
  const segCount = cmap.readUInt16BE(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segCount * 2 + 2;
  const deltas = starts + segCount * 2;
  const rangeOffsets = deltas + segCount * 2;
  for (let s = 0; s < segCount; s += 1) {
    const end = cmap.readUInt16BE(ends + s * 2);
    const start = cmap.readUInt16BE(starts + s * 2);
    const delta = cmap.readInt16BE(deltas + s * 2);
    const rangeOffsetAt = rangeOffsets + s * 2;
    const rangeOffset = cmap.readUInt16BE(rangeOffsetAt);
    for (let c = start; c <= end && c !== 0xffff; c += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (c + delta) & 0xffff;
      } else {
        const raw = cmap.readUInt16BE(rangeOffsetAt + rangeOffset + (c - start) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) points.add(c);
    }
  }
}

function readFormat12(cmap: Buffer, at: number, points: Set<number>): void {
  const groups = cmap.readUInt32BE(at + 12);
  for (let g = 0; g < groups; g += 1) {
    const base = at + 16 + g * 12;
    const start = cmap.readUInt32BE(base);
    const end = cmap.readUInt32BE(base + 4);
    const startGlyph = cmap.readUInt32BE(base + 8);
    for (let c = start; c <= end; c += 1) {
      if (startGlyph + (c - start) !== 0) points.add(c);
    }
  }
}

const cmapCache = new Map<string, Set<number>>();

/** The code points a woff2 file can draw (cached per file). */
export function woff2CodePoints(file: string): Set<number> {
  let points = cmapCache.get(file);
  if (points === undefined) {
    points = cmapCodePoints(woff2Cmap(readFileSync(file)));
    cmapCache.set(file, points);
  }
  return points;
}

// --- Coverage -------------------------------------------------------------------------------

/** font.family.sans: Latin from Noto Sans, Arabic falls through to Noto Sans Arabic (§7.2). */
export const SANS_STACK = ['Noto Sans Variable', 'Noto Sans Arabic Variable'] as const;
/** font.family.mono. */
export const MONO_STACK = ['Noto Sans Mono Variable'] as const;

/** Every @font-face rule fonts.css brings in: each font package's wght.css. */
export function bundledFontFaces(packageDir?: string): FontFaceRule[] {
  return FONT_PACKAGES.flatMap((font) =>
    parseFontFaces(join(fontPackageDir(font.name, packageDir), 'wght.css')),
  );
}

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

/** Whether the stack draws `codePoint`: some face of some family has it in range and in cmap. */
export function isCovered(
  codePoint: number,
  faces: readonly FontFaceRule[],
  families: readonly string[],
): boolean {
  return families.some((family) =>
    faces.some(
      (face) =>
        face.family === family &&
        face.ranges.some(([start, end]) => codePoint >= start && codePoint <= end) &&
        woff2CodePoints(face.file).has(codePoint),
    ),
  );
}

/** The distinct code points of `text` the stack can't draw, skipping default-ignorables. */
export function missingCodePoints(
  text: string,
  faces: readonly FontFaceRule[],
  families: readonly string[],
): number[] {
  const missing = new Set<number>();
  for (const char of text) {
    if (DEFAULT_IGNORABLE.test(char)) continue;
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isCovered(codePoint, faces, families)) missing.add(codePoint);
  }
  return [...missing].sort((a, b) => a - b);
}

/** U+XXXX notation, for messages. */
export const formatCodePoint = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
