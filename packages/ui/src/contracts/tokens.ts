// Design-token contract (F-001 design §3.2): the subset of the DTCG Format 2025.10 that the token
// generator accepts, and the contrast-pair list. Build-time only: scripts/build-tokens.ts and the
// tests import it, and nothing in the package's public entry point does. Imports stay
// extension-free of other src/ modules so Node can run this file directly (type stripping).
import { z } from 'zod';

// Segments after the first may contain `_`, so the spacing scale can say `space.0_5` (§7.1.2).
const SEGMENTS = String.raw`[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+`;
export const TokenPath = z.string().regex(new RegExp(`^${SEGMENTS}$`));
export const Alias = z.string().regex(new RegExp(`^\\{${SEGMENTS}\\}$`));

const Unit = z.number().min(0).max(1);
export const Srgb = z
  .object({
    colorSpace: z.literal('srgb'),
    components: z.tuple([Unit, Unit, Unit]),
    alpha: Unit.optional(),
    hex: z.string().regex(/^#[0-9a-f]{6}$/),
  })
  .strict()
  .refine(
    ({ components, hex }) =>
      components.every(
        (c, i) => Math.abs(c * 255 - Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)) < 0.5,
      ),
    { message: 'hex does not match components' },
  );

// zod 4's z.number() already rejects Infinity and NaN.
export const Dimension = z.object({ value: z.number(), unit: z.enum(['px', 'rem']) }).strict();
export const Duration = z.object({ value: z.number().min(0), unit: z.enum(['ms', 's']) }).strict();
export const CubicBezier = z.tuple([Unit, z.number(), Unit, z.number()]);
export const FontFamily = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
export const FontWeight = z.number().int().min(1).max(1000);
export const NumberValue = z.number();
const ShadowLayer = z
  .object({
    color: z.union([Srgb, Alias]),
    offsetX: Dimension,
    offsetY: Dimension,
    blur: Dimension,
    spread: Dimension,
    inset: z.boolean().optional(),
  })
  .strict();
export const Shadow = z.union([ShadowLayer, z.array(ShadowLayer).min(1)]);

export const VALUE_SCHEMAS = {
  color: Srgb,
  dimension: Dimension,
  duration: Duration,
  cubicBezier: CubicBezier,
  fontFamily: FontFamily,
  fontWeight: FontWeight,
  number: NumberValue,
  shadow: Shadow,
} as const;
export type TokenType = keyof typeof VALUE_SCHEMAS;
export const TokenTypeName = z.enum(Object.keys(VALUE_SCHEMAS) as [TokenType, ...TokenType[]]);

/** `$extensions` key for per-language overrides, e.g. `{ "ar": 1.7 }` → a `:lang(ar)` rule. */
export const LANG_EXTENSION = 'solutions.ralysa.lang';

export const Categories = [
  'color',
  'typography',
  'spacing',
  'sizing',
  'radius',
  'elevation',
  'motion',
] as const; // AC-3
export type Category = (typeof Categories)[number];
/** The top-level token group that holds each category. `palette` holds primitives only. */
export const CATEGORY_ROOTS: Record<Category, string> = {
  color: 'color',
  typography: 'font',
  spacing: 'space',
  sizing: 'size',
  radius: 'radius',
  elevation: 'elevation',
  motion: 'motion',
};
export const PRIMITIVE_ROOTS = ['palette'] as const;

export const Themes = ['light', 'dark'] as const;
export type Theme = (typeof Themes)[number];

export const ContrastKind = z.enum(['text', 'largeText', 'nonText', 'focus']);
export const ContrastPair = z
  .object({
    fg: TokenPath, // e.g. "color.fg.muted"
    bg: TokenPath, // e.g. "color.bg.subtle"
    kind: ContrastKind,
    themes: z.array(z.enum(Themes)).min(1).default(['light', 'dark']),
    usage: z.string().min(1), // where the pair is used; reviewers check it
  })
  .strict();
export type ContrastPair = z.infer<typeof ContrastPair>;

export const ContrastExemption = z
  .object({ token: TokenPath, reason: z.string().min(20) })
  .strict();

export const ContrastPairsFile = z
  .object({
    $description: z.string().optional(),
    pairs: z.array(ContrastPair).min(1),
    exempt: z.array(ContrastExemption).default([]),
  })
  .strict();
export type ContrastPairsFile = z.infer<typeof ContrastPairsFile>;
