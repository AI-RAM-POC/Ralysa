#!/usr/bin/env node
// build-tokens (F-001 design §7.1.1): validates the DTCG token source in tokens/ against the §3.2
// contract and emits
//   dist/css/tokens.css      CSS custom properties (--ralysa-*): light on :root and
//                            [data-theme="light"], dark on [data-theme="dark"] and under
//                            prefers-color-scheme for :root:not([data-theme]); :lang() overrides;
//                            durations drop to 0ms under prefers-reduced-motion
//   dist/css/theme.css       Tailwind v4 `@theme inline`: resets the default namespaces and maps
//                            Tailwind names to the CSS variables, so default-palette classes
//                            don't exist
//   src/tokens/generated.ts  typed token names (committed; drift-checked by check:generated)
// In-house rather than Style Dictionary: one output platform, and the parsed model is reused by
// the contrast gate (test/contrast.test.ts). Runs on Node 24 type stripping.
//   node scripts/build-tokens.ts            write all three outputs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Alias,
  CATEGORY_ROOTS,
  Categories,
  LANG_EXTENSION,
  PRIMITIVE_ROOTS,
  type Theme,
  Themes,
  TokenPath,
  type TokenType,
  TokenTypeName,
  VALUE_SCHEMAS,
} from '../src/contracts/tokens.ts';

export const TOKEN_FILES = {
  core: 'core.tokens.json',
  light: 'semantic.light.tokens.json',
  dark: 'semantic.dark.tokens.json',
} as const;
export const CSS_PREFIX = '--ralysa-';

export class TokenError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid design tokens:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

export interface TokenDef {
  path: string;
  type: TokenType;
  /** Raw `$value`: a literal or an alias string. */
  value: unknown;
  description?: string;
  extensions?: Record<string, unknown>;
  file: string;
}

export interface TokenSet {
  core: TokenDef[];
  themes: Record<Theme, TokenDef[]>;
}

export interface ResolvedToken {
  path: string;
  type: TokenType;
  value: unknown;
  /** Per-language overrides from `$extensions["solutions.ralysa.lang"]`, validated like `$value`. */
  lang: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const GROUP_KEYS = new Set(['$type', '$description', '$extensions', '$deprecated']);
const TOKEN_KEYS = new Set(['$value', '$type', '$description', '$extensions', '$deprecated']);

/** Flattens one DTCG document into tokens, inheriting `$type` from enclosing groups. */
export function flattenTokens(doc: unknown, file: string): TokenDef[] {
  const tokens: TokenDef[] = [];
  const problems: string[] = [];

  function visit(node: unknown, path: string[], inherited: string | undefined): void {
    const where = path.length === 0 ? file : `${file}: ${path.join('.')}`;
    if (!isRecord(node)) {
      problems.push(`${where}: expected a group or a token object`);
      return;
    }
    const type = typeof node.$type === 'string' ? node.$type : inherited;
    if (node.$type !== undefined && !TokenTypeName.safeParse(node.$type).success) {
      problems.push(`${where}: unsupported $type ${JSON.stringify(node.$type)}`);
      return;
    }
    if ('$value' in node) {
      for (const key of Object.keys(node)) {
        if (!TOKEN_KEYS.has(key)) problems.push(`${where}: unexpected key "${key}" in a token`);
      }
      const name = path.join('.');
      if (!TokenPath.safeParse(name).success) problems.push(`${where}: invalid token path`);
      if (type === undefined) {
        problems.push(`${where}: no $type on the token or an enclosing group`);
        return;
      }
      tokens.push({
        path: name,
        type: type as TokenType,
        value: node.$value,
        ...(typeof node.$description === 'string' ? { description: node.$description } : {}),
        ...(isRecord(node.$extensions) ? { extensions: node.$extensions } : {}),
        file,
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) {
        if (!GROUP_KEYS.has(key)) problems.push(`${where}: unexpected key "${key}" in a group`);
        continue;
      }
      if (/[{}.]/.test(key)) {
        problems.push(`${where}: name "${key}" may not contain "{", "}" or "."`);
        continue;
      }
      visit(child, [...path, key], type);
    }
  }

  visit(doc, [], undefined);
  if (problems.length > 0) throw new TokenError(problems);
  return tokens;
}

export function loadTokenSet(tokensDir: string): TokenSet {
  const read = (name: string): TokenDef[] =>
    flattenTokens(JSON.parse(readFileSync(join(tokensDir, name), 'utf8')) as unknown, name);
  return {
    core: read(TOKEN_FILES.core),
    themes: { light: read(TOKEN_FILES.light), dark: read(TOKEN_FILES.dark) },
  };
}

function aliasTarget(value: unknown): string | undefined {
  return typeof value === 'string' && Alias.safeParse(value).success
    ? value.slice(1, -1)
    : undefined;
}

/** Resolves every alias for one theme (core + that theme's semantic file) and validates values. */
export function resolveTheme(set: TokenSet, theme: Theme): Map<string, ResolvedToken> {
  const problems: string[] = [];
  const defs = new Map<string, TokenDef>();
  for (const def of [...set.core, ...set.themes[theme]]) {
    const existing = defs.get(def.path);
    if (existing !== undefined) {
      problems.push(`${def.file}: ${def.path} is already defined in ${existing.file}`);
    }
    defs.set(def.path, def);
  }

  const resolving = new Set<string>();
  function resolveValue(value: unknown, type: TokenType, where: string): unknown {
    const target = aliasTarget(value);
    if (target === undefined) {
      if (type === 'shadow') return resolveShadow(value, where);
      return value;
    }
    const def = defs.get(target);
    if (def === undefined) {
      problems.push(`${where}: alias {${target}} does not resolve`);
      return undefined;
    }
    if (def.type !== type) {
      problems.push(`${where}: alias {${target}} is a ${def.type}, expected ${type}`);
      return undefined;
    }
    if (resolving.has(target)) {
      problems.push(`${where}: alias cycle through {${target}}`);
      return undefined;
    }
    resolving.add(target);
    const resolved = resolveValue(def.value, def.type, `${def.file}: ${def.path}`);
    resolving.delete(target);
    return resolved;
  }
  function resolveShadow(value: unknown, where: string): unknown {
    const layers = Array.isArray(value) ? value : [value];
    const out = layers.map((layer: unknown) =>
      isRecord(layer) ? { ...layer, color: resolveValue(layer.color, 'color', where) } : layer,
    );
    return Array.isArray(value) ? out : out[0];
  }

  const resolved = new Map<string, ResolvedToken>();
  for (const def of defs.values()) {
    const where = `${def.file}: ${def.path}`;
    const value = resolveValue(def.value, def.type, where);
    const parsed = VALUE_SCHEMAS[def.type].safeParse(value);
    if (!parsed.success) {
      problems.push(
        `${where}: invalid ${def.type} value (${parsed.error.issues[0]?.message ?? ''})`,
      );
      continue;
    }
    const lang: Record<string, unknown> = {};
    const overrides = def.extensions?.[LANG_EXTENSION];
    if (overrides !== undefined) {
      if (!isRecord(overrides)) {
        problems.push(`${where}: $extensions["${LANG_EXTENSION}"] must map a language to a value`);
      } else {
        for (const [language, override] of Object.entries(overrides)) {
          const check = VALUE_SCHEMAS[def.type].safeParse(override);
          if (!/^[a-z]{2,3}$/.test(language) || !check.success) {
            problems.push(`${where}: invalid ${language} override in ${LANG_EXTENSION}`);
          } else {
            lang[language] = check.data;
          }
        }
      }
    }
    resolved.set(def.path, { path: def.path, type: def.type, value: parsed.data, lang });
  }
  if (problems.length > 0) throw new TokenError(problems);
  return resolved;
}

const isPrimitive = (path: string): boolean =>
  (PRIMITIVE_ROOTS as readonly string[]).includes(path.split('.')[0] ?? '');

/**
 * Cross-file rules (§3.2): semantic files hold the same keys in every theme, semantic files hold
 * no primitives, and every AC-3 category has tokens.
 */
export function validateTokenSet(set: TokenSet): Record<Theme, Map<string, ResolvedToken>> {
  const problems: string[] = [];
  const keys = Themes.map((theme) => new Set(set.themes[theme].map((def) => def.path)));
  const [first, ...others] = keys;
  others.forEach((other, index) => {
    const theme = Themes[index + 1] ?? '';
    for (const path of first ?? []) {
      if (!other.has(path)) problems.push(`${path} is in the light theme but not in ${theme}`);
    }
    for (const path of other) {
      if (!first?.has(path)) problems.push(`${path} is in ${theme} but not in the light theme`);
    }
  });
  for (const theme of Themes) {
    for (const def of set.themes[theme]) {
      if (isPrimitive(def.path))
        problems.push(`${def.file}: primitive ${def.path} belongs in core`);
    }
  }
  if (problems.length > 0) throw new TokenError(problems);

  const resolved = { light: resolveTheme(set, 'light'), dark: resolveTheme(set, 'dark') };
  for (const theme of Themes) {
    for (const category of Categories) {
      const root = CATEGORY_ROOTS[category];
      if (![...resolved[theme].keys()].some((path) => path.split('.')[0] === root)) {
        problems.push(`${theme}: no ${category} tokens (expected a "${root}" group; AC-3)`);
      }
    }
  }
  if (problems.length > 0) throw new TokenError(problems);
  return resolved;
}

const kebab = (segment: string): string => segment.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** `color.fg.onAccent` → `--ralysa-color-fg-on-accent`. */
export function cssVarName(path: string): string {
  return `${CSS_PREFIX}${path.split('.').map(kebab).join('-')}`;
}

/**
 * The Tailwind theme variable for a token, or undefined when the token has no utility namespace
 * (it is still available as a CSS variable). `bg` groups and `default` leaves are dropped so the
 * classes read naturally: `bg-canvas`, `text-fg`, `bg-accent`, `bg-accent-hover`.
 */
export function tailwindVarName(path: string): string | undefined {
  const [root, group, ...rest] = path.split('.').map(kebab);
  const tail = (parts: (string | undefined)[]): string =>
    parts.filter((p): p is string => p !== undefined && p !== 'default').join('-');
  switch (root) {
    case 'color':
      return `--color-${group === 'bg' ? tail(rest) : tail([group, ...rest])}`;
    case 'font': {
      const namespace: Record<string, string> = {
        family: 'font',
        size: 'text',
        weight: 'font-weight',
        'line-height': 'leading',
        'letter-spacing': 'tracking',
      };
      const ns = group === undefined ? undefined : namespace[group];
      return ns === undefined ? undefined : `--${ns}-${tail(rest)}`;
    }
    case 'space':
      return `--spacing-${tail([group, ...rest])}`;
    case 'size':
      if (group === 'control' || group === 'icon') return `--spacing-${group}-${tail(rest)}`;
      if (group === 'container') return `--container-${tail(rest)}`;
      return undefined;
    case 'radius':
      return `--radius-${tail([group, ...rest])}`;
    case 'elevation':
      return group === 'shadow' ? `--shadow-${tail(rest)}` : undefined;
    case 'motion':
      return group === 'easing' ? `--ease-${tail(rest)}` : undefined;
    default:
      return undefined;
  }
}

/** Tailwind namespaces the theme resets, so only token-backed utilities exist. */
export const TAILWIND_RESETS = [
  '--color-*',
  '--font-*',
  '--text-*',
  '--font-weight-*',
  '--leading-*',
  '--tracking-*',
  '--spacing-*',
  '--container-*',
  '--radius-*',
  '--shadow-*',
  '--inset-shadow-*',
  '--drop-shadow-*',
  '--ease-*',
] as const;

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
]);

interface Dim {
  value: number;
  unit: string;
}
const dim = ({ value, unit }: Dim): string => `${String(value)}${unit}`;

function colorCss(value: { hex: string; alpha?: number }): string {
  if (value.alpha === undefined || value.alpha === 1) return value.hex;
  const alpha = Math.round(value.alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${value.hex}${alpha}`;
}

/** Formats a resolved, validated value as CSS. */
export function cssValue(type: TokenType, value: unknown): string {
  switch (type) {
    case 'color':
      return colorCss(value as { hex: string; alpha?: number });
    case 'dimension':
    case 'duration':
      return dim(value as Dim);
    case 'cubicBezier':
      return `cubic-bezier(${(value as number[]).join(', ')})`;
    case 'fontFamily':
      return (Array.isArray(value) ? (value as string[]) : [value as string])
        .map((family) => (GENERIC_FAMILIES.has(family) ? family : `"${family}"`))
        .join(', ');
    case 'fontWeight':
    case 'number':
      return String(value);
    case 'shadow': {
      interface Layer {
        color: { hex: string; alpha?: number };
        offsetX: Dim;
        offsetY: Dim;
        blur: Dim;
        spread: Dim;
        inset?: boolean;
      }
      const layers = (Array.isArray(value) ? value : [value]) as Layer[];
      return layers
        .map((l) =>
          [
            l.inset === true ? 'inset' : '',
            dim(l.offsetX),
            dim(l.offsetY),
            dim(l.blur),
            dim(l.spread),
            colorCss(l.color),
          ]
            .filter((part) => part !== '')
            .join(' '),
        )
        .join(', ');
    }
  }
}

const emitted = (tokens: Map<string, ResolvedToken>): ResolvedToken[] =>
  [...tokens.values()]
    .filter((t) => !isPrimitive(t.path))
    .sort((a, b) => a.path.localeCompare(b.path));

function checkUnique(names: [string, string | undefined][], what: string): void {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const [path, name] of names) {
    if (name === undefined) continue;
    const other = seen.get(name);
    if (other !== undefined) problems.push(`${path} and ${other} both map to the ${what} ${name}`);
    seen.set(name, path);
  }
  if (problems.length > 0) throw new TokenError(problems);
}

const HEADER =
  'Generated by @ralysa/ui scripts/build-tokens.ts from tokens/*.tokens.json. Do not edit.';

export function renderTokensCss(resolved: Record<Theme, Map<string, ResolvedToken>>): string {
  const light = emitted(resolved.light);
  const dark = emitted(resolved.dark);
  checkUnique(
    light.map((t) => [t.path, cssVarName(t.path)]),
    'CSS variable',
  );
  const themed = new Set(
    dark
      .filter(
        (t) => cssValue(t.type, t.value) !== cssValue(t.type, resolved.light.get(t.path)?.value),
      )
      .map((t) => t.path),
  );
  const decl = (t: ResolvedToken, indent: string): string =>
    `${indent}${cssVarName(t.path)}: ${cssValue(t.type, t.value)};`;
  const darkDecls = (indent: string): string[] =>
    dark.filter((t) => themed.has(t.path)).map((t) => decl(t, indent));

  const lines = [
    `/* ${HEADER} */`,
    '',
    ':root,',
    "[data-theme='light'] {",
    '  color-scheme: light;',
    ...light.map((t) => decl(t, '  ')),
    '}',
    '',
    "[data-theme='dark'] {",
    '  color-scheme: dark;',
    ...darkDecls('  '),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme]) {',
    '    color-scheme: dark;',
    ...darkDecls('    '),
    '  }',
    '}',
  ];

  const languages = [...new Set(light.flatMap((t) => Object.keys(t.lang)))].sort();
  for (const language of languages) {
    lines.push('', `:lang(${language}) {`);
    for (const t of light) {
      if (language in t.lang) {
        lines.push(`  ${cssVarName(t.path)}: ${cssValue(t.type, t.lang[language])};`);
      }
    }
    lines.push('}');
  }

  const durations = light.filter((t) => t.type === 'duration');
  if (durations.length > 0) {
    lines.push('', '@media (prefers-reduced-motion: reduce) {', '  :root {');
    for (const t of durations) lines.push(`    ${cssVarName(t.path)}: 0ms;`);
    lines.push('  }', '}');
  }
  return `${lines.join('\n')}\n`;
}

export function renderThemeCss(resolved: Record<Theme, Map<string, ResolvedToken>>): string {
  const tokens = emitted(resolved.light);
  const mapped = tokens.map((t): [string, string | undefined] => [t.path, tailwindVarName(t.path)]);
  checkUnique(mapped, 'Tailwind variable');
  return [
    `/* ${HEADER} */`,
    '/* Tailwind v4 theme: default namespaces are reset, so only token-backed utilities exist. */',
    '@theme inline {',
    ...TAILWIND_RESETS.map((ns) => `  ${ns}: initial;`),
    '',
    ...mapped
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([path, name]) => `  ${name}: var(${cssVarName(path)});`),
    '}',
    '',
  ].join('\n');
}

export function renderGeneratedTs(resolved: Record<Theme, Map<string, ResolvedToken>>): string {
  const tokens = emitted(resolved.light);
  return [
    `// ${HEADER}`,
    '// Regenerate with `pnpm --filter @ralysa/ui build` (check:generated fails on drift).',
    '',
    '/** Every semantic and core token, mapped to its CSS custom property. */',
    'export const TOKEN_CSS_VARS = {',
    ...tokens.map((t) => `  '${t.path}': '${cssVarName(t.path)}',`),
    '} as const;',
    '',
    'export type TokenName = keyof typeof TOKEN_CSS_VARS;',
    '',
    `export const TOKEN_THEMES = [${Themes.map((t) => `'${t}'`).join(', ')}] as const;`,
    '',
  ].join('\n');
}

export type BuildOutputs = Record<
  'dist/css/tokens.css' | 'dist/css/theme.css' | 'src/tokens/generated.ts',
  string
>;

export function buildTokens(packageDir: string): BuildOutputs {
  const resolved = validateTokenSet(loadTokenSet(join(packageDir, 'tokens')));
  return {
    'dist/css/tokens.css': renderTokensCss(resolved),
    'dist/css/theme.css': renderThemeCss(resolved),
    'src/tokens/generated.ts': renderGeneratedTs(resolved),
  };
}

function main(): number {
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const outputs = buildTokens(packageDir);
    for (const [file, content] of Object.entries(outputs)) {
      const target = join(packageDir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      console.log(`build-tokens: wrote ${file}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof TokenError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
