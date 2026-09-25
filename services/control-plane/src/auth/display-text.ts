// Untrusted display strings (F-002 design §3.5; SEC-F002-30): `device_label`, the user agent and
// every other client-supplied display field lose C0/C1 controls, the Unicode bidi embedding,
// override and isolate characters (U+202A–U+202E, U+2066–U+2069) and zero-width characters, then
// are cut to a maximum length. Arabic text and the RLM/LRM/ALM marks (U+200F, U+200E, U+061C)
// are kept. Nothing is normalised (AC-15).

/** C0 and DEL, C1, bidi embeddings/overrides, isolates, zero-width space/joiners, word joiner, BOM. */
export function isStrippedCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    (cp >= 0x200b && cp <= 0x200d) ||
    cp === 0x2060 ||
    cp === 0xfeff
  );
}

/** Strips the forbidden code points and truncates to `max` code points; empty → undefined. */
export function sanitizeDisplayText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const kept = Array.from(value).filter((ch) => !isStrippedCodePoint(ch.codePointAt(0) ?? 0));
  const cleaned = kept.slice(0, max).join('').trim();
  return cleaned === '' ? undefined : cleaned;
}
