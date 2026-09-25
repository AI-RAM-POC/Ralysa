// @ralysa/stylelint-config: CSS guard-rails for the UI workspaces (F-001 design §7.3.1). Every rule
// is an error from the start: there is no UI CSS yet, so no warn phase is needed.
//   - raw colours (§7.3.4, AC-3): colours come from design tokens, as var(--ralysa-*) or a
//     token-backed Tailwind class. color-mix() over var() operands is allowed.
// Token definition files are exempt: packages/ui/tokens/** is JSON, and the generated
// dist/css/tokens.css is ignored below.
// Every disable comment needs a description (`/* stylelint-disable-next-line rule -- why */`).

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
 * A rule message that names the value and the token alternative.
 * @param {string} label
 * @returns {(value: unknown) => string}
 */
const tokenMessage = (label) => (value) =>
  `${label} ${String(value)}: use a design token (var(--ralysa-…) or a token-backed Tailwind class) (AC-3)`;

/** @type {import('stylelint').Config} */
const config = {
  ignoreFiles: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/tokens/**'],
  reportDescriptionlessDisables: true,
  reportNeedlessDisables: true,
  reportInvalidScopeDisables: true,
  rules: {
    'color-no-hex': [true, { message: tokenMessage('Raw colour') }],
    'color-named': ['never', { message: tokenMessage('Named colour') }],
    'function-disallowed-list': [COLOR_FUNCTIONS, { message: tokenMessage('Colour function') }],
  },
};

export default config;
