// ralysa/no-raw-color (F-001 design §7.3.4; AC-3): a string or template literal in UI code that
// contains a colour value: a hex colour, or rgb(), rgba(), hsl(), hsla(), hwb(), lab(), lch(),
// oklab(), oklch() or color(). That covers style objects (`color: '#fff'`), Tailwind arbitrary
// values (`bg-[#fff]`, `text-[rgb(0_0_0)]`) and computed strings. Colours come from design tokens:
// a token-backed Tailwind class, or tokenVar() for the rare inline case. `color-mix()` over
// `var()` operands is allowed. Token definition files (packages/ui/tokens/**, the generated CSS)
// are JSON and CSS, so this rule never sees them.
// Named colours (`red`, `Crimson`) are reported only as the value of a colour-typed style key
// (`color`, `backgroundColor`, `borderColor`, `border`, `boxShadow`, `fill`, ...), since the words
// are too common elsewhere (code review 4). Tailwind arbitrary values are no-restricted-classes'.
import { NAMED_COLOR_IN_VALUE } from '../css-values.js';

/**
 * Style keys whose value is (or contains) a colour, camelCase or kebab-case, compared with the
 * dashes removed and lowercased.
 */
const COLOR_KEY =
  /^(?:.*colou?r|background|border(?:top|right|bottom|left|block|inline|blockstart|blockend|inlinestart|inlineend)?|outline|boxshadow|textshadow|fill|stroke|columnrule|textdecoration)$/;

/** @param {string} key */
export function isColorKey(key) {
  return COLOR_KEY.test(key.replaceAll('-', '').toLowerCase());
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, not part of a word, an entity (`&#123;`) or `##`. */
const HEX = /(?<![\w&#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/i;
/** A colour function call; `color-mix(` and `--x-color(` don't match. */
const FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

/** Module specifiers are not colours (`#internal` subpath imports). */
const MODULE_SOURCE_PARENTS = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'ImportExpression',
  'TSExternalModuleReference',
  'TSImportType',
]);

/**
 * @param {string} text
 * @returns {string | undefined}
 */
export function findRawColor(text) {
  return HEX.exec(text)?.[0] ?? FUNCTION.exec(text)?.[0];
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRawColor = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow raw colour values in UI code; use design tokens (AC-3).',
    },
    schema: [],
    messages: {
      rawColor:
        'Raw colour "{{value}}": use a design token instead (a token-backed Tailwind class such as bg-canvas or text-fg, or tokenVar()). Colour values live only in packages/ui/tokens (AC-3).',
    },
  },
  create(context) {
    /**
     * @param {import('estree').Node} node
     * @param {string} text
     */
    function check(node, text) {
      const value = findRawColor(text);
      if (value !== undefined) context.report({ node, messageId: 'rawColor', data: { value } });
    }
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const parent = /** @type {{ parent?: { type: string } }} */ (node).parent;
        if (parent !== undefined && MODULE_SOURCE_PARENTS.has(parent.type)) return;
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
      Property(node) {
        const key =
          node.key.type === 'Identifier'
            ? node.key.name
            : node.key.type === 'Literal' && typeof node.key.value === 'string'
              ? node.key.value
              : undefined;
        if (node.computed || key === undefined || !isColorKey(key)) return;
        const texts =
          node.value.type === 'Literal' && typeof node.value.value === 'string'
            ? [node.value.value]
            : node.value.type === 'TemplateLiteral'
              ? node.value.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw)
              : [];
        for (const text of texts) {
          const named = NAMED_COLOR_IN_VALUE.exec(text)?.[0];
          if (named !== undefined) {
            context.report({ node: node.value, messageId: 'rawColor', data: { value: named } });
            return;
          }
        }
      },
    };
  },
};
