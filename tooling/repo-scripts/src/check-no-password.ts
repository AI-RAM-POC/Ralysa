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

/** One pattern per way client code could collect or send a user-held secret. */
export const CLIENT_RULES: { id: string; pattern: RegExp; why: string }[] = [
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
    pattern: /client[_-]?secret/i,
    why: 'a client secret: user clients are public clients (§3.1)',
  },
  {
    id: 'user-secret',
    pattern:
      /pass(?:word|wd|phrase)|\bpin(?:[_-]?code)?\b|\b(?:t|h)?otp\b|one[\s_-]?time[\s_-]?(?:password|passcode|code)/i,
    why: 'a password, PIN or one-time code prompt, field or message',
  },
];

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('<!--') ||
    trimmed.startsWith('{/*')
  );
}

/** Findings for one client source file's text. */
export function checkClientSource(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (isComment(line)) continue;
    for (const rule of CLIENT_RULES) {
      if (!rule.pattern.test(line)) continue;
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

/** Every name and string value of an OpenAPI document that matches the pattern, with its JSON path. */
export function checkOpenApiDocument(path: string, doc: unknown): Finding[] {
  const findings: Finding[] = [];
  const add = (where: string, what: string): void => {
    findings.push({
      rule: 'no-password/openapi',
      path,
      message: `${where}: ${what} matches ${String(OPENAPI_PATTERN)}; no route may take a password, PIN, OTP or client secret (AC-3, TC-F-002-05)`,
    });
  };
  const walk = (value: unknown, where: string, parentKey: string | undefined): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${where}[${String(index)}]`, parentKey);
      });
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        // Keys of `paths` and `properties` (and of any other map) are names a client would send.
        // `description` and `summary` are prose, which may say that no password exists.
        if (OPENAPI_PATTERN.test(key)) add(`${where}.${key}`, `the name "${key}"`);
        if (key === 'description' || key === 'summary' || key === 'title') continue;
        walk(child, `${where}.${key}`, key);
      }
      return;
    }
    if (typeof value !== 'string') return;
    // Parameter and header names, and enum or const values such as a grant type.
    if (
      (parentKey === 'name' || parentKey === 'enum' || parentKey === 'const') &&
      OPENAPI_PATTERN.test(value)
    ) {
      add(where, `the value "${value}"`);
    }
  };
  walk(doc, '$', undefined);
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
