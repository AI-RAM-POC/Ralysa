// Code review 3: every ralysa.ui workspace's lint runs Stylelint AND ESLint with the react-ui
// preset; placeholders and non-UI workspaces are not checked. Also runs on the real repository.
import { describe, expect, it } from 'vitest';
import { checkUiLint } from '../src/check-ui-lint.ts';
import { findRepoRoot } from '../src/lib/core.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';

const REACT_UI_ESLINT =
  "import { base, reactUi, tests } from '@ralysa/eslint-config';\nexport default [...base({ tsconfigRootDir: import.meta.dirname }), ...reactUi(), ...tests()];\n";
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
