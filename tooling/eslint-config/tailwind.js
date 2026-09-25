// Tailwind class rules for the UI lint layer (F-001 design §7.3.3, §7.3.4; AC-3, AC-4), used by
// reactUi() with eslint-plugin-better-tailwindcss. Class strings are checked in className/class
// attributes and in the cn, clsx, cva and tv callees (the plugin's default selectors cover them).
import { fileURLToPath } from 'node:url';

/** Fallback entry point: an empty theme, so every token-backed class is unknown (see the file). */
export const NO_THEME_ENTRY_POINT = fileURLToPath(
  new URL('./tailwind/no-theme.css', import.meta.url),
);

// Every pattern is matched against the whole class, variants included (`md:hover:ml-2`).
const VARIANTS = '^(?:.*:)?!?';
/** A class with an `ltr:` or `rtl:` variant is the documented mirroring pattern, so it passes. */
const NOT_MIRRORED = '(?!(?:.*:)?(?:ltr|rtl):)';

/**
 * `enforce-logical-properties` also offers block-axis and sizing mappings (mt→mbs, h→block, ...).
 * They don't depend on text direction in horizontal writing modes, and AC-4 targets left and
 * right only, so they are ignored.
 */
export const LOGICAL_IGNORE = [
  `${VARIANTS}-?(?:pt|pb|mt|mb|scroll-mt|scroll-mb|scroll-pt|scroll-pb|top|bottom|border-t|border-b|h|w|min-h|min-w|max-h|max-w|size)(?:-|$)`,
];

/**
 * Directional utilities the logical mapping doesn't cover, and arbitrary colour values (AC-3).
 * @type {{ pattern: string, message: string }[]}
 */
export const RESTRICTED_CLASSES = [
  {
    pattern: `^${NOT_MIRRORED}(?:.*:)?!?-?translate-x-.+$`,
    message:
      '"$0" moves in a fixed horizontal direction. Pair it so it mirrors: ltr:translate-x-N rtl:-translate-x-N (AC-4).',
  },
  {
    pattern: `^${NOT_MIRRORED}(?:.*:)?!?bg-(?:(?:top|bottom)-)?(?:left|right)(?:-(?:top|bottom))?$`,
    message:
      '"$0" positions the background on a physical side. Mirror it with an ltr:/rtl: pair (ltr:bg-left rtl:bg-right) (AC-4).',
  },
  {
    pattern: `^${NOT_MIRRORED}(?:.*:)?!?origin-(?:(?:top|bottom)-)?(?:left|right)(?:-(?:top|bottom))?$`,
    message:
      '"$0" sets a physical transform origin. Mirror it with an ltr:/rtl: pair (ltr:origin-left rtl:origin-right) (AC-4).',
  },
  {
    pattern: `^${NOT_MIRRORED}(?:.*:)?!?bg-(?:linear|gradient)-to-(?:l|r|tl|tr|bl|br)$`,
    message:
      '"$0" runs the gradient in a physical direction. Use bg-linear-to-t/b, or mirror it with an ltr:/rtl: pair (AC-4).',
  },
  {
    pattern: `${VARIANTS}\\[(?:(?:scroll-)?(?:margin|padding)-(?:left|right)|left|right|border-(?:left|right)[\\w-]*|border-(?:top|bottom)-(?:left|right)-radius)\\s*:.*\\]$`,
    message:
      '"$0" sets a physical property. Use the logical property ([margin-inline-start:…]) or the logical utility (ms-*, inset-s-*, border-s) (AC-4).',
  },
  {
    pattern: `${VARIANTS}\\[(?:text-align|float|clear)\\s*:\\s*(?:left|right)\\]$`,
    message: '"$0" uses a physical keyword. Use text-start/text-end, float-start/float-end (AC-4).',
  },
  {
    pattern: `${VARIANTS}[\\w-]*\\[[^\\]]*(?:#[0-9a-fA-F]{3,8}(?![\\w-])|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\().*$`,
    message:
      '"$0" hard-codes a colour. Use a token-backed class such as bg-canvas, text-fg or border-border-control (AC-3).',
  },
];
