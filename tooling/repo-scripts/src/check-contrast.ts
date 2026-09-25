// check-contrast (F-001 design §7.1.4; AC-11, TC-F-001-22/23): WCAG 2.1 contrast gate for design
// token pairs. It computes ratios with its own implementation (no dependency) and fails on any pair
// below its minimum, on any translucent colour in a pair, and on a pair that names an exempt token.
// It runs as part of @ralysa/ui's `test`, which passes in its parsed token model (so the gate sees
// exactly what the generator emits). This module imports nothing, so a browser-library workspace
// can import it from source without Node types.

/** WCAG 2.1 SC 1.4.3 (text, large text) and SC 1.4.11 (UI components, focus indicators). */
export const MIN_RATIO = { text: 4.5, largeText: 3, nonText: 3, focus: 3 } as const;
export type ContrastKind = keyof typeof MIN_RATIO;

export interface ContrastColor {
  hex: string;
  alpha?: number;
}

export interface ContrastPairInput {
  fg: string;
  bg: string;
  kind: ContrastKind;
  themes: readonly string[];
  usage: string;
}

export interface ContrastExemptionInput {
  token: string;
  reason: string;
}

export interface ContrastResult {
  theme: string;
  fg: string;
  bg: string;
  kind: ContrastKind;
  ratio: number;
  min: number;
  pass: boolean;
}

export interface ContrastFinding {
  rule: string;
  path: string;
  message: string;
}

export interface CheckContrastOptions {
  pairs: readonly ContrastPairInput[];
  exempt?: readonly ContrastExemptionInput[];
  /** Returns the resolved colour of a token in a theme, or undefined if it doesn't exist. */
  resolve: (theme: string, token: string) => ContrastColor | undefined;
  /** Reported as the finding path, e.g. "packages/ui/tokens/contrast-pairs.json". */
  file?: string;
}

const HEX = /^#([0-9a-f]{6})$/i;

/** sRGB channel (0–255) → linear value (WCAG 2.1 relative-luminance definition). */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const match = HEX.exec(hex);
  if (match?.[1] === undefined) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(match[1], 16);
  return 0.2126 * linear(n >> 16) + 0.7152 * linear((n >> 8) & 0xff) + 0.0722 * linear(n & 0xff);
}

/** (L1 + 0.05) / (L2 + 0.05) with L1 the lighter colour; symmetric in its arguments. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** Checks every pair in every theme it lists. A ratio is never rounded up before comparing. */
export function checkContrast({
  pairs,
  exempt = [],
  resolve,
  file = 'contrast-pairs.json',
}: CheckContrastOptions): {
  results: ContrastResult[];
  findings: ContrastFinding[];
} {
  const results: ContrastResult[] = [];
  const findings: ContrastFinding[] = [];
  const exemptTokens = new Set(exempt.map((entry) => entry.token));

  for (const pair of pairs) {
    const label = `${pair.fg} on ${pair.bg} (${pair.kind})`;
    for (const token of [pair.fg, pair.bg]) {
      if (exemptTokens.has(token)) {
        findings.push({
          rule: 'contrast/exempt-token-in-pair',
          path: file,
          message: `${label}: ${token} is listed as exempt, so it must not be used in a checked pair`,
        });
      }
    }
    for (const theme of pair.themes) {
      const fg = resolve(theme, pair.fg);
      const bg = resolve(theme, pair.bg);
      if (fg === undefined || bg === undefined) {
        findings.push({
          rule: 'contrast/unresolved',
          path: file,
          message: `${label} [${theme}]: ${fg === undefined ? pair.fg : pair.bg} is not a colour token in this theme`,
        });
        continue;
      }
      const translucent = [fg, bg].filter((c) => c.alpha !== undefined && c.alpha < 1);
      if (translucent.length > 0) {
        findings.push({
          rule: 'contrast/translucent',
          path: file,
          message: `${label} [${theme}]: translucent colours can't be checked statically; use an opaque token`,
        });
        continue;
      }
      const ratio = contrastRatio(fg.hex, bg.hex);
      const min = MIN_RATIO[pair.kind];
      const pass = ratio >= min;
      results.push({ theme, fg: pair.fg, bg: pair.bg, kind: pair.kind, ratio, min, pass });
      if (!pass) {
        findings.push({
          rule: 'contrast/below-minimum',
          path: file,
          message: `${label} [${theme}]: ${ratio.toFixed(2)}:1 is below ${String(min)}:1 (${pair.usage})`,
        });
      }
    }
  }
  return { results, findings };
}

/** A fixed-width table of results, for test and CI logs. */
export function formatContrastTable(results: readonly ContrastResult[]): string {
  const rows = results.map(
    (r) =>
      `${r.pass ? 'pass' : 'FAIL'}  ${r.theme.padEnd(5)}  ${r.kind.padEnd(9)}  ${r.ratio.toFixed(2).padStart(5)} >= ${r.min.toFixed(1)}  ${r.fg} on ${r.bg}`,
  );
  return rows.join('\n');
}
