// ralysa/no-session-db-settings (F-002 design §4.1; SEC-F002-31): application code reaches org
// data only through withOrg(), which sets app.org_id transaction-locally. Anything that changes a
// pooled connection's identity or org for longer than one transaction is banned:
//   - SET [SESSION|LOCAL] ROLE …, SET SESSION AUTHORIZATION …, SET [SESSION|LOCAL] app.… ;
//   - set_config('role' | 'session_authorization', …) in any form;
//   - set_config('app.…', …, <anything but the literal true>).
// SQL is read from string literals AND whole template literals, including tagged templates such
// as Kysely's sql`…`: the quasis are joined with a placeholder, so an interpolation can't split a
// banned statement across nodes and escape the check (code review of PR #19).

const PLACEHOLDER = '__expr__';
const SET_STATEMENT =
  /\bSET\s+(?:(?:SESSION|LOCAL)\s+)?(?:ROLE\b|SESSION\s+AUTHORIZATION\b|app\.)/i;
const SET_CONFIG = /set_config\s*\(/gi;

/**
 * The arguments of a call whose "(" ends at `open`, split on top-level commas (quote-aware).
 * @param {string} text
 * @param {number} open index just after "("
 * @returns {string[] | undefined} undefined when the call isn't closed in this text
 */
function callArguments(text, open) {
  const args = [];
  let depth = 0;
  let quote = false;
  let start = open;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "'") quote = text[i + 1] === "'" ? ((i += 1), true) : false;
      continue;
    }
    if (c === "'") quote = true;
    else if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

/**
 * Why `sql` is banned, or undefined when it's allowed.
 * @param {string} sql
 * @returns {string | undefined}
 */
export function findSessionSetting(sql) {
  const statement = SET_STATEMENT.exec(sql);
  if (statement !== null) return statement[0].replace(/\s+/g, ' ');
  for (const match of sql.matchAll(SET_CONFIG)) {
    const args = callArguments(sql, (match.index ?? 0) + match[0].length);
    const name = args?.[0]?.toLowerCase() ?? '';
    if (/^'(role|session_authorization)'$/.test(name)) return `set_config(${name}, …)`;
    if (/^'app\.[a-z0-9_.]*'$/.test(name)) {
      // Unclosed call (the rest is in another string): refuse, it can't be shown to be local.
      if (args === undefined || args.length !== 3 || args[2]?.toLowerCase() !== 'true') {
        return `set_config(${name}, …) without is_local = true`;
      }
    }
  }
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noSessionDbSettings = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow session-level role, authorization and app.* settings; use withOrg() (SEC-F002-31).',
    },
    schema: [],
    messages: {
      banned:
        '"{{found}}" changes a pooled connection beyond one transaction (SEC-F002-31). Use withOrg(); only src/db/migrate.ts may do this.',
    },
  },
  create(context) {
    /** @param {import('estree').Node} node @param {string} text */
    const check = (node, text) => {
      const found = findSessionSetting(text);
      if (found !== undefined) context.report({ node, messageId: 'banned', data: { found } });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(PLACEHOLDER));
      },
    };
  },
};
