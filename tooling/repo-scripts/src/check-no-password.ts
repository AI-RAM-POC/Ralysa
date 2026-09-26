// check-no-password (F-002 design §3.1, §3.10, AC-3; TC-F-002-05, -06; F-002-T14): Ralysa never
// asks a user for a password, PIN, one-time code or any other user-held shared secret, and user
// clients are public clients with no client secret.
//   1. Every committed OpenAPI document (`**/openapi/*.json`, at least the control plane's): no
//      path, parameter, header or schema property name, and no enum or const value, matches the
//      TC-F-002-05 pattern. The document is generated and `check:generated` keeps it equal to the
//      routes (§3.10), so this reads the API as served.
//   2. Client code (packages/auth and the apps that sign users in): no password input
//      (`type="password"`, `type: 'password'`), no password/PIN/OTP prompt or field, no
//      `grant_type=password` and no `client_secret`. Comment lines are skipped, so a comment may
//      say that no password exists; tests are skipped, so a test may assert the refusal.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, isRecord, listRepoFiles } from './lib/repo.ts';

/** TC-F-002-05's pattern, over OpenAPI names and values. */
export const OPENAPI_PATTERN = /pass(word|wd|phrase)|\bpin\b|otp|client_secret/i;

/** The OpenAPI documents that must exist (a missing one fails, so 0 findings can't mean "none read"). */
export const REQUIRED_OPENAPI = ['services/control-plane/openapi/control-plane.v1.json'];

/** Client code: the workspaces that run on a user's device and sign users in (F-002 §5.1, §5.2). */
export const CLIENT_CODE_ROOTS = ['packages/auth', 'apps/cli', 'apps/desktop', 'apps/web'];

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|html|json|vue|svelte)$/;
const SKIPPED =
  /(?:^|\/)(?:test|tests|e2e|__tests__|fixtures|dist|node_modules|coverage)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)package\.json$|(?:^|\/)tsconfig[^/]*\.json$/;

/**
 * The text a pattern is matched against, in both forms: as written, and with camelCase, `_` and
 * `-` split into words (`userPin` → `user Pin`, `otp_code` → `otp code`), so a word pattern sees
 * the words inside an identifier (review of #34, R34-3).
 */
export function matchForms(text: string): string[] {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return words === text ? [text] : [text, words];
}

const matchesAny = (pattern: RegExp, text: string): boolean =>
  matchForms(text).some((form) => pattern.test(form));

/** One pattern per way client code could collect or send a user-held secret. */
export const CLIENT_RULES: { id: string; pattern: RegExp; why: string; words?: boolean }[] = [
  {
    id: 'password-input',
    pattern: /\btype\s*[=:]\s*\{?\s*["'`]password["'`]/i,
    why: 'a password input field',
  },
  {
    id: 'password-grant',
    pattern: /grant_type["'`]?\s*[=:,]\s*["'`]?password\b/i,
    why: 'the OAuth password grant',
  },
  {
    id: 'client-secret',
    pattern: /client[\s_-]?secret/i,
    why: 'a client secret: user clients are public clients (§3.1)',
    words: true,
  },
  {
    id: 'user-secret',
    // Letter lookarounds, not \b: `\b` doesn't separate `_` or digits from a word. Identifiers
    // are split into words first (matchForms), so `userPin` and `otpCode` are seen too.
    pattern:
      /pass[\s_-]?(?:word|wd|phrase|code)|(?<![a-z])(?:pwd|pin(?:[\s_-]?code)?|[th]?otp)(?![a-z])|one[\s_-]?time[\s_-]?(?:password|passcode|code)|(?:shared|user)[\s_-]?secret|["'`]\s*(?:enter\s+(?:your\s+|the\s+)?)?secret\s*[:?]/i,
    why: 'a password, passcode, PIN, one-time code or shared secret prompt, field or message',
    words: true,
  },
];

/**
 * True when the whole line is a comment. A block comment counts only if nothing but whitespace
 * follows its end on that line, so `/* x *\/ <input type="password" />` is code (R34-3).
 */
export function isComment(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//')) return true;
  const blocks: [string, string][] = [
    ['{/*', '*/}'],
    ['/*', '*/'],
    ['<!--', '-->'],
    // A continuation line inside a block comment, possibly closing it.
    ['*', '*/'],
  ];
  for (const [open, close] of blocks) {
    if (!trimmed.startsWith(open)) continue;
    const end = trimmed.indexOf(close, open === '*' ? 0 : open.length);
    return end === -1 || trimmed.slice(end + close.length).trim() === '';
  }
  return false;
}

/** Findings for one client source file's text. */
export function checkClientSource(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (isComment(line)) continue;
    for (const rule of CLIENT_RULES) {
      // The syntax rules (input type, grant) match the line as written; the word rules also
      // match it with identifiers split into words.
      const hit = rule.words === true ? matchesAny(rule.pattern, line) : rule.pattern.test(line);
      if (!hit) continue;
      findings.push({
        rule: `no-password/${rule.id}`,
        path: `${path}:${String(index + 1)}`,
        message: `${rule.why}. Ralysa signs users in through the IdP only and never handles a user-held secret (AC-3, F-002 design §3.1).`,
      });
      break;
    }
  }
  return findings;
}

/** Keys whose string value is prose, which may say that no password exists. */
const PROSE_KEYS = new Set(['description', 'summary', 'title']);
/** Keys whose values a client sends or is shown: every string under them is checked. */
const VALUE_KEYS = new Set(['name', 'enum', 'const', 'default', 'pattern', 'example', 'examples']);

/**
 * Every name and every sent-or-shown value of an OpenAPI document that matches the pattern, with
 * its JSON path. Names are all object keys (paths, properties, any map), in both matchForms.
 * Values are the strings anywhere under `name`, `enum`, `const`, `default`, `pattern`, `example`
 * and `examples`. `description`, `summary` and `title` are skipped only when their value is a
 * string (prose): a property NAMED `description` is an object and is walked (R34-3).
 */
export function checkOpenApiDocument(path: string, doc: unknown): Finding[] {
  const findings: Finding[] = [];
  const add = (where: string, what: string): void => {
    findings.push({
      rule: 'no-password/openapi',
      path,
      message: `${where}: ${what} matches ${String(OPENAPI_PATTERN)}; no route may take a password, PIN, OTP or client secret (AC-3, TC-F-002-05)`,
    });
  };
  const walk = (value: unknown, where: string, checkStrings: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${where}[${String(index)}]`, checkStrings);
      });
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (matchesAny(OPENAPI_PATTERN, key)) add(`${where}.${key}`, `the name "${key}"`);
        if (PROSE_KEYS.has(key) && typeof child === 'string') continue;
        walk(child, `${where}.${key}`, checkStrings || VALUE_KEYS.has(key));
      }
      return;
    }
    if (checkStrings && typeof value === 'string' && matchesAny(OPENAPI_PATTERN, value)) {
      add(where, `the value "${value}"`);
    }
  };
  walk(doc, '$', false);
  return findings;
}

export function checkNoPassword(root: string, files: string[] = listRepoFiles(root)): Finding[] {
  const findings: Finding[] = [];
  const openapi = new Set([
    ...REQUIRED_OPENAPI,
    ...files.filter((file) => /(?:^|\/)openapi\/[^/]+\.json$/.test(file)),
  ]);
  for (const file of [...openapi].sort()) {
    const full = join(root, file);
    if (!existsSync(full)) {
      findings.push({
        rule: 'no-password/openapi',
        path: file,
        message: 'the committed OpenAPI document is missing; run check:generated',
      });
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(full, 'utf8'));
    } catch (error) {
      findings.push({
        rule: 'no-password/openapi',
        path: file,
        message: `not JSON: ${String(error)}`,
      });
      continue;
    }
    findings.push(...checkOpenApiDocument(file, doc));
  }
  for (const file of files) {
    if (!CLIENT_CODE_ROOTS.some((dir) => file.startsWith(`${dir}/`))) continue;
    if (!SOURCE_FILE.test(file) || SKIPPED.test(file)) continue;
    findings.push(...checkClientSource(file, readFileSync(join(root, file), 'utf8')));
  }
  return findings;
}
