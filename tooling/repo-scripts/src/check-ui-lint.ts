// check-ui-lint (F-001 design §7.3.1; AC-3, AC-4, AC-5; code review 3): every UI workspace
// (`ralysa.ui: true`, not a placeholder) runs BOTH layers of the UI lint:
//   - ESLint with the react-ui preset (logical classes, raw colours, literal strings), and
//   - Stylelint with @ralysa/stylelint-config (logical CSS, raw colours in CSS).
// A UI workspace that forgot either would pass lint while its CSS or JSX went unchecked.
//
// PR #15 review: mentioning `stylelint` is not enough. The lint script must run
// `stylelint "**/*.css"` (quoted, so Stylelint expands the glob recursively rather than the
// shell, whose `**` is a plain `*`), chained with `&&` so its exit status fails the script,
// without a config or ignore option that would narrow it. The react-ui preset must be given
// `workspaceDir: import.meta.dirname`, so its exceptions don't depend on the working directory.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, isRecord, listWorkspaceDirs, readJson } from './lib/core.ts';

const STYLELINT_CONFIGS = ['stylelint.config.js', 'stylelint.config.mjs', 'stylelint.config.cjs'];
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts'];

/** The glob every UI workspace lints: all CSS in the workspace (the config's ignores apply). */
export const STYLELINT_GLOB = '**/*.css';

/**
 * Stylelint options that would lint a narrower set of files, or with another config than the
 * workspace's stylelint.config.js (which this check verifies uses @ralysa/stylelint-config).
 */
const NARROWING_OPTIONS = new Set([
  '--config',
  '-c',
  '--config-basedir',
  '--ignore-pattern',
  '--ip',
  '--ignore-path',
  '-i',
]);

type Separator = '&&' | '||' | ';' | '|' | '&';
interface Word {
  text: string;
  /** A `*`, `?` or `[` outside quotes: the shell, not the program, would expand the word. */
  shellGlob: boolean;
}
interface Command {
  words: Word[];
  before: Separator | undefined;
  after: Separator | undefined;
}

/**
 * Splits a package.json script into commands the way sh does, for the subset scripts use:
 * words, single and double quotes, backslash escapes, `#` comments and the operators
 * `&&`, `||`, `;`, `|` and `&`. Anything more exotic simply fails to match a stylelint command,
 * which fails the check (closed, not open).
 */
export function splitScript(script: string): Command[] {
  const commands: Command[] = [];
  let words: Word[] = [];
  let word: Word | undefined;
  let before: Separator | undefined;
  const endWord = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = (separator: Separator | undefined): void => {
    endWord();
    if (words.length > 0) commands.push({ words, before, after: separator });
    words = [];
    before = separator;
  };
  for (let i = 0; i < script.length; i += 1) {
    const c = script.charAt(i);
    if (c === "'" || c === '"') {
      const end = script.indexOf(c, i + 1);
      const text = script.slice(i + 1, end === -1 ? script.length : end);
      word = { text: (word?.text ?? '') + text, shellGlob: word?.shellGlob ?? false };
      i = end === -1 ? script.length : end;
    } else if (c === '\\') {
      word = {
        text: (word?.text ?? '') + script.charAt(i + 1),
        shellGlob: word?.shellGlob ?? false,
      };
      i += 1;
    } else if (c === '#' && word === undefined) {
      break;
    } else if (/\s/.test(c)) {
      endWord();
    } else if (c === '&' || c === '|' || c === ';') {
      const two = script.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        endCommand(two);
        i += 1;
      } else {
        endCommand(c);
      }
    } else {
      word = {
        text: (word?.text ?? '') + c,
        shellGlob: (word?.shellGlob ?? false) || '*?['.includes(c),
      };
    }
  }
  endCommand(undefined);
  return commands;
}

/** A command whose failure fails the script: only `&&` (or nothing) on either side. */
const gates = (command: Command): boolean =>
  (command.before === undefined || command.before === '&&') &&
  (command.after === undefined || command.after === '&&');

/** Why this script's Stylelint run doesn't cover the workspace's CSS, or undefined if it does. */
export function stylelintProblem(lint: string): { rule: string; message: string } | undefined {
  const runs = splitScript(lint).filter((c) => c.words[0]?.text === 'stylelint' && gates(c));
  if (runs.length === 0) {
    return {
      rule: 'ui-lint/stylelint-not-wired',
      message: `the lint script of a UI workspace must run \`stylelint "${STYLELINT_GLOB}" --allow-empty-input\`, chained with && so a finding fails lint`,
    };
  }
  const covers = (command: Command): boolean => {
    const args = command.words.slice(1);
    const glob = args.some((w) => w.text === STYLELINT_GLOB && !w.shellGlob);
    const narrowed = args.some((w) => NARROWING_OPTIONS.has(w.text.split('=')[0] ?? ''));
    return glob && !narrowed;
  };
  if (runs.some(covers)) return undefined;
  return {
    rule: 'ui-lint/stylelint-scope',
    message: `stylelint must lint "${STYLELINT_GLOB}" (quoted, so Stylelint expands it recursively, not the shell) with the workspace's own stylelint.config.js: no --config or ignore options`,
  };
}

function firstExisting(dir: string, names: string[]): string | undefined {
  return names.find((name) => existsSync(join(dir, name)));
}

export function checkUiLint({ root }: { root: string }): Finding[] {
  const findings: Finding[] = [];
  for (const dir of listWorkspaceDirs(root)) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    if (!isRecord(pkg) || !isRecord(pkg.ralysa) || pkg.ralysa.ui !== true) continue;
    if (pkg.ralysa.kind === 'placeholder') continue;

    const lint =
      isRecord(pkg.scripts) && typeof pkg.scripts.lint === 'string' ? pkg.scripts.lint : '';
    if (!/(?:^|&&|;)\s*eslint\b/.test(lint)) {
      findings.push({
        rule: 'ui-lint/eslint-not-wired',
        path: `${dir}/package.json`,
        message: 'the lint script of a UI workspace must run eslint',
      });
    }
    const stylelint = stylelintProblem(lint);
    if (stylelint !== undefined) findings.push({ ...stylelint, path: `${dir}/package.json` });

    const stylelintConfig = firstExisting(join(root, dir), STYLELINT_CONFIGS);
    if (
      stylelintConfig === undefined ||
      !readFileSync(join(root, dir, stylelintConfig), 'utf8').includes('@ralysa/stylelint-config')
    ) {
      findings.push({
        rule: 'ui-lint/stylelint-config',
        path: `${dir}/${stylelintConfig ?? 'stylelint.config.js'}`,
        message: 'a UI workspace needs a stylelint.config.js that uses @ralysa/stylelint-config',
      });
    }

    const eslintConfig = firstExisting(join(root, dir), ESLINT_CONFIGS);
    const eslintSource =
      eslintConfig === undefined ? '' : readFileSync(join(root, dir, eslintConfig), 'utf8');
    const eslintPath = `${dir}/${eslintConfig ?? 'eslint.config.js'}`;
    if (!/\breactUi\s*\(/.test(eslintSource)) {
      findings.push({
        rule: 'ui-lint/react-ui-preset',
        path: eslintPath,
        message: 'a UI workspace eslint.config.js must include the react-ui preset (reactUi())',
      });
    } else if (
      !/\breactUi\s*\(\s*\{[^}]*\bworkspaceDir\s*:\s*import\.meta\.dirname\b/.test(eslintSource)
    ) {
      findings.push({
        rule: 'ui-lint/react-ui-workspace-dir',
        path: eslintPath,
        message:
          'call reactUi({ workspaceDir: import.meta.dirname, … }) so its exceptions are placed from the config folder, not the working directory',
      });
    }
  }
  return findings;
}
