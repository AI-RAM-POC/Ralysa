// ralysa/no-raw-color (F-001 design §7.3.4; AC-3): a string or template literal in UI code that
// contains a colour value: a hex colour, or rgb(), rgba(), hsl(), hsla(), hwb(), lab(), lch(),
// oklab(), oklch() or color(). That covers style objects (`color: '#fff'`), Tailwind arbitrary
// values (`bg-[#fff]`, `text-[rgb(0_0_0)]`) and computed strings. Colours come from design tokens:
// a token-backed Tailwind class, or tokenVar() for the rare inline case. `color-mix()` over
// `var()` operands is allowed. Token definition files (packages/ui/tokens/**, the generated CSS)
// are JSON and CSS, so this rule never sees them.

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
     * @param {import('eslint').Rule.Node} node
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
    };
  },
};
