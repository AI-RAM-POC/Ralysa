// TC-F-001-08 (AC-4), CSS part: every physical form in §7.3.2 is an error, and each logical
// equivalent passes. Block-axis and sizing properties stay allowed (AC-4 targets left/right).
// Also §7.7: removing the outline needs a described disable.
import { describe, expect, it } from 'vitest';
import { rulesFor } from './lint.js';

const PROPERTY_RULE = 'logical-css/require-logical-properties';
const KEYWORD_RULE = 'logical-css/require-logical-keywords';
const VALUE_RULE = 'declaration-property-value-disallowed-list';

const decl = (body: string): string => `.a { ${body}; }`;

describe('inline-axis physical properties (logical-css/require-logical-properties)', () => {
  it.each([
    ['margin-left: 1rem', 'margin-inline-start: 1rem'],
    ['margin-right: 1rem', 'margin-inline-end: 1rem'],
    ['padding-left: 1rem', 'padding-inline-start: 1rem'],
    ['padding-right: 1rem', 'padding-inline-end: 1rem'],
    ['left: 0', 'inset-inline-start: 0'],
    ['right: 0', 'inset-inline-end: 0'],
    ['border-left: 1px solid var(--x)', 'border-inline-start: 1px solid var(--x)'],
    ['border-right: 1px solid var(--x)', 'border-inline-end: 1px solid var(--x)'],
    ['border-left-width: 1px', 'border-inline-start-width: 1px'],
    ['border-right-style: solid', 'border-inline-end-style: solid'],
    ['border-left-color: var(--x)', 'border-inline-start-color: var(--x)'],
    ['border-top-left-radius: 4px', 'border-start-start-radius: 4px'],
    ['border-top-right-radius: 4px', 'border-start-end-radius: 4px'],
    ['border-bottom-left-radius: 4px', 'border-end-start-radius: 4px'],
    ['border-bottom-right-radius: 4px', 'border-end-end-radius: 4px'],
    ['scroll-margin-left: 1rem', 'scroll-margin-inline-start: 1rem'],
    ['scroll-margin-right: 1rem', 'scroll-margin-inline-end: 1rem'],
    ['scroll-padding-left: 1rem', 'scroll-padding-inline-start: 1rem'],
    ['scroll-padding-right: 1rem', 'scroll-padding-inline-end: 1rem'],
  ])('%s → error; %s passes', async (physical, logical) => {
    expect(await rulesFor(decl(physical))).toEqual([PROPERTY_RULE]);
    expect(await rulesFor(decl(logical))).toEqual([]);
  });

  it.each([
    'top: 0',
    'bottom: 0',
    'width: 10rem',
    'height: 10rem',
    'min-width: 0',
    'max-height: 50vh',
    'margin-top: 1rem',
    'margin-bottom: 1rem',
    'padding-top: 1rem',
    'padding-bottom: 1rem',
    'border-top: 1px solid var(--x)',
    'border-bottom-width: 1px',
    'scroll-margin-top: 1rem',
    'overflow-x: auto',
  ])('block-axis and sizing stay allowed: %s', async (body) => {
    expect(await rulesFor(decl(body))).toEqual([]);
  });
});

describe('physical keywords (logical-css/require-logical-keywords)', () => {
  it.each([
    ['text-align: left', 'text-align: start'],
    ['text-align: right', 'text-align: end'],
    ['text-align-last: right', 'text-align-last: end'],
    ['float: left', 'float: inline-start'],
    ['float: right', 'float: inline-end'],
    ['clear: left', 'clear: inline-start'],
    ['clear: right', 'clear: inline-end'],
  ])('%s → error; %s passes', async (physical, logical) => {
    expect(await rulesFor(decl(physical))).toEqual([KEYWORD_RULE]);
    expect(await rulesFor(decl(logical))).toEqual([]);
  });

  it.each(['text-align: center', 'resize: vertical', 'caption-side: top'])(
    'non-directional keywords stay allowed: %s',
    async (body) => {
      expect(await rulesFor(decl(body))).toEqual([]);
    },
  );
});

describe('shorthands and values (declaration-property-value-disallowed-list)', () => {
  it.each([
    ['margin: 1px 2px 3px 4px', 'margin: 1px 2px 3px 2px'],
    ['padding: 0 1rem 0 2rem', 'padding: 0 1rem'],
    ['inset: 0 auto 0 0', 'inset: 0 auto'],
    ['scroll-margin: 0 1rem 0 0', 'scroll-margin: 0 1rem'],
    ['scroll-padding: 0 0 0 1rem', 'scroll-padding-inline: 0 1rem'],
    ['border-width: 1px 2px 1px 0', 'border-width: 1px 2px'],
    ['border-style: solid none solid solid', 'border-style: solid none'],
    [
      'border-color: var(--a) var(--b) var(--a) var(--c)',
      'border-color: var(--a) var(--b) var(--a) var(--b)',
    ],
    ['margin: 0 calc(var(--a) + 1px) 0 0', 'margin: 0 calc(var(--a) + 1px) 0 calc(var(--a) + 1px)'],
    ['border-radius: 4px 0', 'border-radius: 4px'],
    ['border-radius: 4px 0 0 4px', 'border-radius: 4px 4px 0 0'],
    ['border-radius: 4px 4px 4px 0 / 2px', 'border-radius: 4px / 2px'],
    ['background-position: left top', 'background-position: center top'],
    ['background-position: right 1rem bottom 1rem', 'background-position: 50% 100%'],
    ['background-position-x: right', 'background-position-y: bottom'],
    ['transform-origin: left center', 'transform-origin: center top'],
    ['transform: translateX(4px)', 'transform: translateY(4px)'],
    ['transform: translate(-50%, 0)', 'transform: translate(0, -50%)'],
    ['transform: translate3d(1rem, 0, 0)', 'transform: rotate(45deg) scale(-1, 1)'],
    [
      'transform: translateX(4px) rotate(3deg)',
      'transform: translateX(calc(var(--ralysa-dir-sign) * 4px))',
    ],
    ['translate: 1rem 0', 'translate: 0 1rem'],
    ['translate: -50%', 'translate: calc(var(--ralysa-dir-sign) * 1rem) 0'],
  ])('%s → error; %s passes', async (physical, logical) => {
    expect(await rulesFor(decl(physical))).toEqual([VALUE_RULE]);
    expect(await rulesFor(decl(logical))).toEqual([]);
  });

  it('translate: none passes', async () => {
    expect(await rulesFor(decl('translate: none'))).toEqual([]);
  });

  it('names the logical longhands in the message', async () => {
    const { lintCss } = await import('./lint.js');
    const [warning] = await lintCss(decl('border-width: 1px 2px 1px 0'));
    expect(warning?.text).toMatch(/border-inline-start-width and border-inline-end-width/);
  });
});

describe('focus visibility (§7.7)', () => {
  it.each(['outline: none', 'outline: 0', 'outline-style: none', 'outline-width: 0'])(
    '%s → error',
    async (body) => {
      expect(await rulesFor(`.a:focus-visible { ${body}; }`)).toEqual([VALUE_RULE]);
    },
  );

  it('a visible ring passes', async () => {
    expect(
      await rulesFor(
        '.a:focus-visible { outline: var(--ralysa-size-focus-ring-width) solid var(--ralysa-color-focus-ring); outline-offset: 2px; }',
      ),
    ).toEqual([]);
  });

  it('a described disable is the escape hatch', async () => {
    expect(
      await rulesFor(
        '.a:focus-visible {\n  /* stylelint-disable-next-line declaration-property-value-disallowed-list -- ring drawn with box-shadow below */\n  outline: none;\n  box-shadow: 0 0 0 2px var(--ralysa-color-focus-ring);\n}',
      ),
    ).toEqual([]);
  });
});

describe('Tailwind v4 CSS', () => {
  it('parses the ui Tailwind entry point syntax', async () => {
    const css =
      "@import 'tailwindcss';\n@theme inline {\n  --color-*: initial;\n  --color-canvas: var(--ralysa-color-bg-canvas);\n}\n@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));\n";
    expect(await rulesFor(css)).toEqual([]);
  });
});
