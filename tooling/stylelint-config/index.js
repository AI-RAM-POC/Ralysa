// @ralysa/stylelint-config: CSS guard-rails for the UI workspaces (F-001 design §7.3.1). Every rule
// is an error from the start: there is no UI CSS yet, so no warn phase is needed.
//   - raw colours (§7.3.4, AC-3): colours come from design tokens, as var(--ralysa-*) or a
//     token-backed Tailwind class. color-mix() over var() operands is allowed.
//   - logical layout (§7.3.2, AC-4): inline-axis physical properties and left/right keywords are
//     errors (stylelint-plugin-logical-css); block-axis and sizing properties are ignored because
//     they don't depend on text direction in horizontal writing modes. Shorthands and values the
//     plugin can't see (4-value margin/padding/inset/border-*, uneven border-radius,
//     background-position and transform-origin with left/right, horizontal translate) are caught
//     by declaration-property-value-disallowed-list.
//   - focus (§7.7): an outline can't be removed without a described disable (the replacement
//     ring is then visible in review).
// Token definition files are exempt: packages/ui/tokens/** is JSON, and the generated
// dist/css/tokens.css is ignored below.
// Every disable comment needs a description (`/* stylelint-disable-next-line rule -- why */`).
import logicalCss from 'stylelint-plugin-logical-css';

/** Colour functions that take literal channel values. `color-mix` is not on the list. */
export const COLOR_FUNCTIONS = [
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
];

/**
 * Physical properties the logical-css plugin knows that are block-axis or sizing, not inline
 * direction. AC-4 targets left and right only, so these stay allowed. Everything else the plugin
 * maps (margin/padding/scroll-*-left|right, left, right, border-left|right*, the four corner
 * radii) is an error.
 */
export const BLOCK_AXIS_PROPERTIES = [
  'top',
  'bottom',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin-top',
  'margin-bottom',
  'padding-top',
  'padding-bottom',
  'scroll-margin-top',
  'scroll-margin-bottom',
  'scroll-padding-top',
  'scroll-padding-bottom',
  'border-top',
  'border-top-color',
  'border-top-style',
  'border-top-width',
  'border-bottom',
  'border-bottom-color',
  'border-bottom-style',
  'border-bottom-width',
  'contain-intrinsic-width',
  'contain-intrinsic-height',
  'overflow-x',
  'overflow-y',
  'overscroll-behavior-x',
  'overscroll-behavior-y',
];

/** Keyword checks that aren't about left/right text direction (top/bottom, horizontal/vertical). */
export const NON_DIRECTIONAL_KEYWORD_PROPERTIES = [
  'box-orient',
  'caption-side',
  'offset-anchor',
  'offset-position',
  'resize',
];

// One CSS value token: a word, optionally followed by a (once-nested) parenthesised argument
// list, so `calc(var(--a) + 1px)` counts as one value.
const PARENS = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const TOKEN = String.raw`(?:[^\s()/,]+(?:${PARENS})?|${PARENS})`;

/** `a b c d` where the 2nd (right) and 4th (left) values differ. */
export const ASYMMETRIC_FOUR_VALUES = new RegExp(
  String.raw`^\s*${TOKEN}\s+(${TOKEN})\s+${TOKEN}\s+(?!\1\s*$)${TOKEN}\s*$`,
);
/**
 * Corner radii (before an optional `/`) that differ between the left and right sides. Allowed:
 * one value, all values equal, or four values `a a b b` (top corners equal, bottom corners
 * equal), which mirror onto themselves.
 */
export const UNEVEN_RADII = new RegExp(
  String.raw`^(?!\s*(${TOKEN})\s+\1\s+(${TOKEN})\s+\2\s*(?:\/|$))\s*(${TOKEN})(?:\s+\3(?=\s|\/|$))*\s+(?!\3(?=\s|\/|$))${TOKEN}`,
);
const LEFT_OR_RIGHT = /(?<![\w-])(?:left|right)(?![\w-])/i;
/** A horizontal translate() in a transform, unless it uses the direction sign. */
const TRANSFORM_TRANSLATE_X =
  /^(?![\s\S]*--ralysa-dir-sign)[\s\S]*\btranslate(?:x|3d)?\(\s*(?!0[a-z%]*\s*[,)])/i;
/** The `translate` property with a non-zero first (horizontal) value, unless it uses the sign. */
const TRANSLATE_PROPERTY_X = /^(?![\s\S]*--ralysa-dir-sign)(?!\s*(?:none|0[a-z%]*)(?:\s|$))\s*\S/i;

const FOUR_VALUE_SHORTHANDS = [
  'margin',
  'padding',
  'inset',
  'scroll-margin',
  'scroll-padding',
  'border-width',
  'border-style',
  'border-color',
];

/** @type {Record<string, (string | RegExp)[]>} */
const DISALLOWED_VALUES = {
  ...Object.fromEntries(FOUR_VALUE_SHORTHANDS.map((prop) => [prop, [ASYMMETRIC_FOUR_VALUES]])),
  'border-radius': [UNEVEN_RADII],
  'background-position': [LEFT_OR_RIGHT],
  'background-position-x': [LEFT_OR_RIGHT],
  'transform-origin': [LEFT_OR_RIGHT],
  transform: [TRANSFORM_TRANSLATE_X],
  translate: [TRANSLATE_PROPERTY_X],
  outline: [/^\s*(?:none|0[a-z%]*)\s*$/i],
  'outline-style': [/^\s*none\s*$/i],
  'outline-width': [/^\s*0[a-z%]*\s*$/i],
};

/**
 * @param {unknown} property
 * @param {unknown} value
 * @returns {string}
 */
function disallowedValueMessage(property, value) {
  const prop = String(property);
  const decl = `"${prop}: ${String(value)}"`;
  if (FOUR_VALUE_SHORTHANDS.includes(prop)) {
    const side = (/** @type {string} */ edge) =>
      prop.startsWith('border-')
        ? `border-inline-${edge}-${prop.slice('border-'.length)}`
        : `${prop}-inline-${edge}`;
    return `${decl} sets left and right differently. Use ${side('start')} and ${side('end')} for the horizontal sides (AC-4).`;
  }
  if (prop === 'border-radius') {
    return `${decl} rounds left and right corners differently. Use border-start-start-radius, border-start-end-radius, border-end-start-radius and border-end-end-radius (AC-4).`;
  }
  if (prop === 'transform' || prop === 'translate') {
    return `${decl} moves horizontally in a fixed direction. Multiply the x offset by var(--ralysa-dir-sign), e.g. translate: calc(var(--ralysa-dir-sign) * 1rem) 0 (AC-4).`;
  }
  if (prop.startsWith('outline')) {
    return `${decl} removes the focus indicator. Keep the focus ring (§7.7); if a replacement ring is drawn another way, disable this line with a description.`;
  }
  return `${decl} uses a physical side. Use a logical keyword (start/end) or mirror it for [dir='rtl'] (AC-4).`;
}

/**
 * A rule message that names the value and the token alternative.
 * @param {string} label
 * @returns {(value: unknown) => string}
 */
const tokenMessage = (label) => (value) =>
  `${label} ${String(value)}: use a design token (var(--ralysa-…) or a token-backed Tailwind class) (AC-3)`;

/** @type {import('stylelint').Config} */
const config = {
  plugins: [...logicalCss],
  ignoreFiles: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/tokens/**'],
  reportDescriptionlessDisables: true,
  reportNeedlessDisables: true,
  reportInvalidScopeDisables: true,
  rules: {
    'color-no-hex': [true, { message: tokenMessage('Raw colour') }],
    'color-named': ['never', { message: tokenMessage('Named colour') }],
    'function-disallowed-list': [COLOR_FUNCTIONS, { message: tokenMessage('Colour function') }],
    'logical-css/require-logical-properties': [true, { ignore: BLOCK_AXIS_PROPERTIES }],
    'logical-css/require-logical-keywords': [true, { ignore: NON_DIRECTIONAL_KEYWORD_PROPERTIES }],
    'declaration-property-value-disallowed-list': [
      DISALLOWED_VALUES,
      { message: disallowedValueMessage },
    ],
  },
};

export default config;
