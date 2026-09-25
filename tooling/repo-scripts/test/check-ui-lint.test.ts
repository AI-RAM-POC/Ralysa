// Code review 3: every ralysa.ui workspace's lint runs Stylelint AND ESLint with the react-ui
// preset; placeholders and non-UI workspaces are not checked. Also runs on the real repository.
import { describe, expect, it } from 'vitest';
import { checkUiLint, splitScript, stylelintProblem } from '../src/check-ui-lint.ts';
import { findRepoRoot } from '../src/lib/core.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';

const REACT_UI_ESLINT =
  "import { base, reactUi, tests } from '@ralysa/eslint-config';\nexport default [...base({ tsconfigRootDir: import.meta.dirname }), ...reactUi({ workspaceDir: import.meta.dirname }), ...tests()];\n";
const STYLELINT = "import config from '@ralysa/stylelint-config';\nexport default config;\n";
const WIRED_LINT = 'eslint . && stylelint "**/*.css" --allow-empty-input';

function repo(options: {
  lint?: string;
  eslint?: string | null;
  stylelint?: string | null;
  ui?: boolean;
  kind?: string;
}) {
  const files: Record<string, string> = {};
  if (options.eslint !== null) files['eslint.config.js'] = options.eslint ?? REACT_UI_ESLINT;
  if (options.stylelint !== null) files['stylelint.config.js'] = options.stylelint ?? STYLELINT;
  const fixture = makeFixtureRepo({
    workspaces: [
      {
        dir: 'apps/web',
        pkg: validWorkspacePackage('@ralysa/web', {
          scripts: {
            lint: options.lint ?? WIRED_LINT,
            typecheck: 'tsc -p tsconfig.json',
            test: 'vitest run',
            build: 'vite build',
          },
          ralysa: {
            kind: options.kind ?? 'app',
            shipped: true,
            ui: options.ui ?? true,
            artefacts: ['dist'],
          },
        }),
        files,
      },
    ],
  });
  return checkUiLint({ root: fixture.root }).map((f) => f.rule);
}

describe('check-ui-lint', () => {
  it('passes a fully wired UI workspace', () => {
    expect(repo({})).toEqual([]);
  });

  it('fails when the lint script skips Stylelint', () => {
    expect(repo({ lint: 'eslint .' })).toEqual(['ui-lint/stylelint-not-wired']);
  });

  it('fails when the lint script skips ESLint', () => {
    expect(repo({ lint: 'stylelint "**/*.css"' })).toEqual(['ui-lint/eslint-not-wired']);
  });

  it('fails without a stylelint.config.js, or with one that ignores the shared config', () => {
    expect(repo({ stylelint: null })).toEqual(['ui-lint/stylelint-config']);
    expect(repo({ stylelint: 'export default { rules: {} };\n' })).toEqual([
      'ui-lint/stylelint-config',
    ]);
  });

  it('fails when the eslint config lacks the react-ui preset', () => {
    expect(
      repo({
        eslint:
          "import { base } from '@ralysa/eslint-config';\nexport default base({ tsconfigRootDir: '.' });\n",
      }),
    ).toEqual(['ui-lint/react-ui-preset']);
    expect(repo({ eslint: null })).toEqual(['ui-lint/react-ui-preset']);
  });

  // PR #15 review: mentioning stylelint is not enough; it must lint "**/*.css" and gate the script.
  describe('the stylelint command lints "**/*.css" (PR #15 review)', () => {
    it.each([
      ['double quotes', 'eslint . && stylelint "**/*.css" --allow-empty-input'],
      ['single quotes', "eslint . && stylelint '**/*.css' --allow-empty-input"],
      ['backslash-escaped glob', 'eslint . && stylelint \\*\\*/\\*.css --allow-empty-input'],
      ['first command', 'stylelint "**/*.css" --allow-empty-input && eslint .'],
      [
        'the real packages/ui script',
        'eslint . && stylelint "**/*.css" --allow-empty-input && i18next-cli extract --ci --dry-run --quiet',
      ],
      [
        'a harmless extra option',
        'eslint . && stylelint "**/*.css" --allow-empty-input --max-warnings 0',
      ],
    ])('passes: %s', (_what, lint) => {
      expect(stylelintProblem(lint)).toBeUndefined();
      expect(repo({ lint })).toEqual([]);
    });

    it.each([
      ['no stylelint at all', 'eslint .'],
      ['stylelint only in a comment', 'eslint . # stylelint "**/*.css"'],
      ['stylelint only as an argument', 'eslint . && echo stylelint "**/*.css"'],
      ['a prefixed name', 'eslint . && stylelint-x "**/*.css"'],
      ['failure swallowed with ||', 'eslint . && stylelint "**/*.css" || true'],
      ['run only if something failed', 'eslint . || stylelint "**/*.css"'],
      ['exit status ignored after ;', 'stylelint "**/*.css"; eslint .'],
      ['exit status lost in a pipe', 'eslint . && stylelint "**/*.css" | cat'],
      ['sent to the background', 'stylelint "**/*.css" & eslint .'],
    ])('fails as not wired: %s', (_what, lint) => {
      expect(stylelintProblem(lint)?.rule).toBe('ui-lint/stylelint-not-wired');
    });

    it.each([
      ['no files', 'eslint . && stylelint --allow-empty-input'],
      ['version only', 'eslint . && stylelint --version'],
      ['one folder', 'eslint . && stylelint "src/**/*.css" --allow-empty-input'],
      ['top-level files only', 'eslint . && stylelint "*.css" --allow-empty-input'],
      ['another extension', 'eslint . && stylelint "**/*.scss" --allow-empty-input'],
      ['unquoted: the shell expands ** as *', 'eslint . && stylelint **/*.css --allow-empty-input'],
      ['half quoted: ** still unquoted', 'eslint . && stylelint **/"*.css" --allow-empty-input'],
      ['another config', 'eslint . && stylelint "**/*.css" --config other.js'],
      ['another config, short form', 'eslint . && stylelint "**/*.css" -c other.js'],
      ['another config, = form', 'eslint . && stylelint "**/*.css" --config=other.js'],
      ['an ignore pattern', 'eslint . && stylelint "**/*.css" --ignore-pattern "src/**"'],
      ['an ignore pattern, short form', 'eslint . && stylelint "**/*.css" --ip "src/**"'],
      ['an ignore file', 'eslint . && stylelint "**/*.css" --ignore-path .gitignore'],
    ])('fails on scope: %s', (_what, lint) => {
      expect(stylelintProblem(lint)?.rule).toBe('ui-lint/stylelint-scope');
      expect(repo({ lint })).toEqual(['ui-lint/stylelint-scope']);
    });

    it('splits a script the way sh does', () => {
      const commands = splitScript(`a "b c" 'd' && e\\ f || g; h | i & j # k`);
      expect(commands.map((c) => [c.words.map((w) => w.text), c.before, c.after])).toEqual([
        [['a', 'b c', 'd'], undefined, '&&'],
        [['e f'], '&&', '||'],
        [['g'], '||', ';'],
        [['h'], ';', '|'],
        [['i'], '|', '&'],
        [['j'], '&', undefined],
      ]);
    });
  });

  it('fails when reactUi() is not given workspaceDir: import.meta.dirname (PR #15 review)', () => {
    const preset = (call: string): string =>
      `import { base, reactUi } from '@ralysa/eslint-config';\nexport default [...base({ tsconfigRootDir: import.meta.dirname }), ...${call}];\n`;
    expect(repo({ eslint: preset('reactUi()') })).toEqual(['ui-lint/react-ui-workspace-dir']);
    expect(repo({ eslint: preset('reactUi({ tailwindEntryPoint })') })).toEqual([
      'ui-lint/react-ui-workspace-dir',
    ]);
    expect(repo({ eslint: preset('reactUi({ workspaceDir: process.cwd() })') })).toEqual([
      'ui-lint/react-ui-workspace-dir',
    ]);
    expect(
      repo({
        eslint: preset('reactUi({ workspaceDir: import.meta.dirname, tailwindEntryPoint })'),
      }),
    ).toEqual([]);
    expect(
      repo({
        eslint: preset(
          'reactUi({\n    tailwindEntryPoint,\n    workspaceDir: import.meta.dirname,\n  })',
        ),
      }),
    ).toEqual([]);
  });

  it('ignores non-UI workspaces and placeholders', () => {
    expect(repo({ ui: false, lint: 'eslint .', stylelint: null })).toEqual([]);
    expect(
      repo({
        kind: 'placeholder',
        lint: 'ralysa-repo placeholder-guard',
        stylelint: null,
        eslint: null,
      }),
    ).toEqual([]);
  });

  it('passes on the real repository', () => {
    expect(checkUiLint({ root: findRepoRoot() })).toEqual([]);
  });
});
