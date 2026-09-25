// ralysa/no-physical-inline-style (F-001 design §7.3.5; AC-4): React `style={{ … }}` objects may not
// use inline-axis physical properties, or left/right values for textAlign, float and clear. Every
// object literal inside the style expression is checked, including the branches of `a ? {…} : {…}`
// and `a && {…}`. The message names the logical property to use instead.

/** Physical inline-axis style keys → their logical equivalents. */
export const PHYSICAL_STYLE_KEYS = {
  marginLeft: 'marginInlineStart',
  marginRight: 'marginInlineEnd',
  paddingLeft: 'paddingInlineStart',
  paddingRight: 'paddingInlineEnd',
  left: 'insetInlineStart',
  right: 'insetInlineEnd',
  borderLeft: 'borderInlineStart',
  borderRight: 'borderInlineEnd',
  borderLeftColor: 'borderInlineStartColor',
  borderRightColor: 'borderInlineEndColor',
  borderLeftStyle: 'borderInlineStartStyle',
  borderRightStyle: 'borderInlineEndStyle',
  borderLeftWidth: 'borderInlineStartWidth',
  borderRightWidth: 'borderInlineEndWidth',
  borderTopLeftRadius: 'borderStartStartRadius',
  borderTopRightRadius: 'borderStartEndRadius',
  borderBottomLeftRadius: 'borderEndStartRadius',
  borderBottomRightRadius: 'borderEndEndRadius',
  scrollMarginLeft: 'scrollMarginInlineStart',
  scrollMarginRight: 'scrollMarginInlineEnd',
  scrollPaddingLeft: 'scrollPaddingInlineStart',
  scrollPaddingRight: 'scrollPaddingInlineEnd',
};

/** Keys whose `left`/`right` values are physical → the logical values. */
export const PHYSICAL_STYLE_VALUES = {
  textAlign: { left: 'start', right: 'end' },
  float: { left: 'inline-start', right: 'inline-end' },
  clear: { left: 'inline-start', right: 'inline-end' },
};

/**
 * The parts of a JSXAttribute node this rule reads.
 * @typedef {{
 *   name: { type: string, name?: string },
 *   value: { type: string, expression?: import('estree').Node } | null,
 * }} JsxAttribute
 */

/**
 * @param {import('estree').Property['key']} key
 * @returns {string | undefined}
 */
function keyName(key) {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

/**
 * Object literals reachable from a style expression without calling anything.
 * @param {import('estree').Node | null | undefined} node
 * @returns {import('estree').ObjectExpression[]}
 */
function styleObjects(node) {
  if (node === null || node === undefined) return [];
  switch (node.type) {
    case 'ObjectExpression':
      return [
        node,
        ...node.properties.flatMap((p) =>
          p.type === 'SpreadElement' ? styleObjects(p.argument) : [],
        ),
      ];
    case 'ConditionalExpression':
      return [...styleObjects(node.consequent), ...styleObjects(node.alternate)];
    case 'LogicalExpression':
      return [...styleObjects(node.left), ...styleObjects(node.right)];
    case 'SequenceExpression':
      return styleObjects(node.expressions.at(-1));
    default: {
      // TypeScript wrappers: `{…} as CSSProperties`, `{…} satisfies CSSProperties`, `{…}!`.
      const inner = /** @type {{ expression?: import('estree').Node }} */ (node).expression;
      return /^TS(?:As|Satisfies|NonNull|TypeAssertion)Expression$/.test(node.type)
        ? styleObjects(inner)
        : [];
    }
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export const noPhysicalInlineStyle = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow physical left/right properties and values in React style objects (AC-4).',
    },
    schema: [],
    messages: {
      property:
        'Physical style property "{{ key }}" does not mirror in right-to-left layouts. Use "{{ logical }}" (AC-4).',
      value:
        '"{{ key }}: {{ value }}" does not mirror in right-to-left layouts. Use "{{ logical }}" (AC-4).',
    },
  },
  create(context) {
    return {
      /** @param {unknown} jsxNode ESTree has no JSX types; this is a JSXAttribute. */
      JSXAttribute(jsxNode) {
        const node = /** @type {JsxAttribute} */ (jsxNode);
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'style') return;
        const value = node.value;
        if (value?.type !== 'JSXExpressionContainer') return;
        for (const object of styleObjects(value.expression)) {
          for (const property of object.properties) {
            if (property.type !== 'Property' || property.computed) continue;
            const key = keyName(property.key);
            if (key === undefined) continue;
            const logical =
              PHYSICAL_STYLE_KEYS[/** @type {keyof typeof PHYSICAL_STYLE_KEYS} */ (key)];
            if (logical !== undefined) {
              context.report({ node: property.key, messageId: 'property', data: { key, logical } });
              continue;
            }
            const values =
              PHYSICAL_STYLE_VALUES[/** @type {keyof typeof PHYSICAL_STYLE_VALUES} */ (key)];
            const raw = property.value.type === 'Literal' ? property.value.value : undefined;
            if (values !== undefined && (raw === 'left' || raw === 'right')) {
              context.report({
                node: property.value,
                messageId: 'value',
                data: { key, value: raw, logical: `${key}: '${values[raw]}'` },
              });
            }
          }
        }
      },
    };
  },
};
