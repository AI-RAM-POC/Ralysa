// ralysa/no-literal-attribute-text (F-001 design §7.4.4; AC-5): a string literal in a user-visible
// JSX attribute (aria-label, aria-description, title, alt, placeholder, label, ...) on ANY element
// must come from an i18n key. It complements i18next/no-literal-string, which reports JSX text but
// treats most attributes of native DOM elements as safe, so `<div aria-description="…">` or
// `<option label="…">` would pass it. Also `value` on `<input type="submit|reset|button">`, which
// is the button's visible label. Strings without a letter (punctuation, digits) are allowed.

const HAS_LETTER = /\p{L}/u;
/** `<input type=…>` values whose `value` attribute is shown as the button text. */
const BUTTON_INPUT_TYPES = new Set(['submit', 'reset', 'button']);

/**
 * The parts of JSX nodes this rule reads (ESTree has no JSX types).
 * @typedef {{ type: string, name?: string | JsxNode, namespace?: JsxNode, value?: unknown,
 *   expression?: JsxNode, quasis?: { value: { cooked?: string | null, raw: string } }[],
 *   expressions?: unknown[], consequent?: JsxNode, alternate?: JsxNode, left?: JsxNode,
 *   right?: JsxNode, operator?: string, parent?: JsxNode, attributes?: JsxNode[] }} JsxNode
 */

/**
 * String literals a value can evaluate to without calling anything.
 * @param {JsxNode | null | undefined} node
 * @returns {{ node: JsxNode, text: string }[]}
 */
function literalStrings(node) {
  if (node === null || node === undefined) return [];
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [{ node, text: node.value }] : [];
    case 'TemplateLiteral':
      return (node.quasis ?? []).map((quasi) => ({
        node,
        text: quasi.value.cooked ?? quasi.value.raw,
      }));
    case 'JSXExpressionContainer':
      return literalStrings(node.expression);
    case 'ConditionalExpression':
      return [...literalStrings(node.consequent), ...literalStrings(node.alternate)];
    case 'LogicalExpression':
      return [...literalStrings(node.left), ...literalStrings(node.right)];
    case 'BinaryExpression': {
      // 'Close ' + 'dialog', 'Close ' + name (code review 8): one report for the whole sum.
      if (node.operator !== '+') return [];
      const parts = [...literalStrings(node.left), ...literalStrings(node.right)];
      return parts.length === 0 ? [] : [{ node, text: parts.map((part) => part.text).join('') }];
    }
    default:
      return [];
  }
}

/**
 * The static string value of a JSX attribute (`type="reset"` or `type={'reset'}`), if any.
 * @param {JsxNode | undefined} attribute
 * @returns {string | undefined}
 */
function staticValue(attribute) {
  const value = /** @type {JsxNode | null | undefined} */ (attribute?.value);
  if (value === null || value === undefined) return undefined;
  const inner = value.type === 'JSXExpressionContainer' ? value.expression : value;
  if (inner?.type === 'Literal' && typeof inner.value === 'string') return inner.value;
  if (inner?.type === 'TemplateLiteral' && (inner.expressions ?? []).length === 0) {
    return inner.quasis?.[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * True when `node` (a JSXAttribute named "value") sits on an `<input>` whose type makes the value
 * the visible button label.
 * @param {JsxNode} node
 * @returns {boolean}
 */
function isButtonInputValue(node) {
  const element = node.parent;
  const elementName = /** @type {JsxNode | undefined} */ (element?.name);
  if (element?.type !== 'JSXOpeningElement' || elementName?.type !== 'JSXIdentifier') return false;
  if (elementName.name !== 'input') return false;
  const typeAttribute = (element.attributes ?? []).find(
    (attribute) =>
      attribute.type === 'JSXAttribute' && /** @type {JsxNode} */ (attribute.name).name === 'type',
  );
  const type = staticValue(typeAttribute)?.trim().toLowerCase();
  return type !== undefined && BUTTON_INPUT_TYPES.has(type);
}

/** @type {import('eslint').Rule.RuleModule} */
export const noLiteralAttributeText = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow literal text in user-visible JSX attributes; use an i18n key (AC-5).',
    },
    schema: [
      {
        type: 'object',
        properties: { attributes: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      literal:
        'User-visible attribute "{{ name }}" has literal text "{{ text }}": use an i18n key, e.g. {{ name }}={t("ns:area.element")} (AC-5).',
    },
  },
  create(context) {
    const options = /** @type {{ attributes?: string[] } | undefined} */ (context.options[0]);
    const attributes = new Set(options?.attributes ?? []);
    return {
      /** @param {unknown} raw a JSXAttribute */
      JSXAttribute(raw) {
        const node = /** @type {JsxNode} */ (raw);
        const nameNode = /** @type {JsxNode} */ (node.name);
        if (nameNode.type !== 'JSXIdentifier' || typeof nameNode.name !== 'string') return;
        const name = nameNode.name;
        if (!attributes.has(name) && !(name === 'value' && isButtonInputValue(node))) return;
        for (const { node: literal, text } of literalStrings(/** @type {JsxNode} */ (node.value))) {
          if (!HAS_LETTER.test(text)) continue;
          context.report({
            node: /** @type {import('estree').Node} */ (/** @type {unknown} */ (literal)),
            messageId: 'literal',
            data: { name, text: text.trim() },
          });
        }
      },
    };
  },
};
