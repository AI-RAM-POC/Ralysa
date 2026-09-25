// ralysa/no-unpaired-direction-variant (F-001 design §7.3.3; AC-4; code review 5): the Tailwind
// restrictions on directional utilities (translate-x, bg-left/right, origin-*left/right,
// bg-linear-to-l/r) accept a class with an `ltr:` or `rtl:` variant, because the mirrored pair is
// the documented pattern. That exemption is per class, so it must be checked per class STRING:
// every `ltr:X` needs an `rtl:` counterpart with the opposite sign or side (and vice versa), with
// the same other variants. `ltr:translate-x-2` alone, `rtl:origin-left` alone, and
// `ltr:translate-x-2 rtl:translate-x-2` are reported. Other rtl-only utilities, such as the icon
// mirror `rtl:-scale-x-100`, are not directional families and aren't checked.
//
// Class strings are read from className/class attributes (static text) and from the arguments of
// the class-merging callees (cn, clsx, cva, tv, twMerge, twJoin), taken together per call.

const CALLEES = new Set(['cn', 'clsx', 'cva', 'tv', 'twMerge', 'twJoin', 'cx']);
const CLASS_ATTRIBUTES = new Set(['className', 'class']);

/** Swaps every standalone left/right word. */
const swapSides = (/** @type {string} */ base) =>
  base.replace(/(?<![a-z])(left|right)(?![a-z])/g, (side) => (side === 'left' ? 'right' : 'left'));

/**
 * The mirror image of a directional utility, or undefined if it isn't one of the families.
 * @param {string} base a class without variants or `!`
 * @returns {string | undefined}
 */
export function mirrorUtility(base) {
  const translate = /^(-?)translate-x-(.+)$/.exec(base);
  if (translate !== null) {
    const sign = translate[1] ?? '';
    const value = translate[2] ?? '';
    if (/^(?:0|\[0\])$/.test(value)) return base; // zero mirrors onto itself
    return `${sign === '-' ? '' : '-'}translate-x-${value}`;
  }
  if (/^(?:bg|origin)-(?:(?:top|bottom)-)?(?:left|right)(?:-(?:top|bottom))?$/.test(base)) {
    return swapSides(base);
  }
  const gradient = /^bg-(linear|gradient)-to-(t|b)?(l|r)$/.exec(base);
  if (gradient !== null) {
    const kind = gradient[1] ?? '';
    const vertical = gradient[2] ?? '';
    return `bg-${kind}-to-${vertical}${gradient[3] === 'l' ? 'r' : 'l'}`;
  }
  return undefined;
}

/**
 * Splits `md:rtl:!-translate-x-2` into variants and base, ignoring `:` inside `[...]`.
 * @param {string} className
 * @returns {{ variants: string[], base: string }}
 */
function splitVariants(className) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of className) {
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
    if (char === ':' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  const base = current.replace(/^!|!$/g, '');
  return { variants: parts, base };
}

/**
 * Directional classes in a class list that lack their mirrored counterpart.
 * @param {string[]} classes
 * @returns {{ className: string, expected: string }[]}
 */
export function unpairedDirectionClasses(classes) {
  /** @type {{ className: string, dir: string, rest: string, base: string, mirror: string }[]} */
  const directional = [];
  for (const className of classes) {
    const { variants, base } = splitVariants(className);
    const dirs = variants.filter((v) => v === 'ltr' || v === 'rtl');
    const mirror = mirrorUtility(base);
    if (dirs.length !== 1 || mirror === undefined) continue;
    const dir = /** @type {string} */ (dirs[0]);
    const rest = variants.filter((v) => v !== 'ltr' && v !== 'rtl').join(':');
    directional.push({ className, dir, rest, base, mirror });
  }
  const present = new Set(directional.map((d) => `${d.dir}|${d.rest}|${d.base}`));
  const missing = [];
  for (const d of directional) {
    const other = d.dir === 'ltr' ? 'rtl' : 'ltr';
    if (!present.has(`${other}|${d.rest}|${d.mirror}`)) {
      missing.push({
        className: d.className,
        expected: [d.rest, other, d.mirror].filter((part) => part !== '').join(':'),
      });
    }
  }
  return missing;
}

/**
 * Static strings inside a node (literals, template text, array items, object keys and values).
 * @param {any} node
 * @returns {string[]}
 */
function collectStrings(node) {
  if (node === null || typeof node !== 'object') return [];
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : [];
    case 'TemplateLiteral':
      return node.quasis.map(
        (/** @type {{ value: { cooked?: string, raw: string } }} */ q) =>
          q.value.cooked ?? q.value.raw,
      );
    case 'JSXExpressionContainer':
      return collectStrings(node.expression);
    case 'ArrayExpression':
      return node.elements.flatMap(collectStrings);
    case 'ObjectExpression':
      return node.properties.flatMap((/** @type {any} */ p) =>
        p.type === 'Property' ? [...collectStrings(p.key), ...collectStrings(p.value)] : [],
      );
    case 'ConditionalExpression':
      return [...collectStrings(node.consequent), ...collectStrings(node.alternate)];
    case 'LogicalExpression':
      return [...collectStrings(node.left), ...collectStrings(node.right)];
    default:
      return [];
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export const noUnpairedDirectionVariant = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require ltr:/rtl: directional Tailwind classes to come in mirrored pairs (AC-4).',
    },
    schema: [],
    messages: {
      unpaired:
        '"{{ className }}" is only half of a mirrored pair: add "{{ expected }}" to the same class list, or use a logical utility (AC-4).',
    },
  },
  create(context) {
    /**
     * @param {import('estree').Node} node
     * @param {string[]} strings
     */
    function check(node, strings) {
      const classes = strings.flatMap((s) => s.split(/\s+/)).filter((c) => c !== '');
      for (const { className, expected } of unpairedDirectionClasses(classes)) {
        context.report({ node, messageId: 'unpaired', data: { className, expected } });
      }
    }
    return {
      /** @param {any} node a JSXAttribute */
      JSXAttribute(node) {
        if (node.name?.type !== 'JSXIdentifier' || !CLASS_ATTRIBUTES.has(node.name.name)) return;
        const value = node.value;
        if (value === null) return;
        // A callee inside the attribute is checked by CallExpression.
        const inner = value.type === 'JSXExpressionContainer' ? value.expression : value;
        if (inner?.type === 'CallExpression') return;
        check(node, collectStrings(value));
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || !CALLEES.has(node.callee.name)) return;
        check(node, node.arguments.flatMap(collectStrings));
      },
    };
  },
};
