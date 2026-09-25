// PR #15 review nit: reactUi() used to derive its workspace from process.cwd(), so running ESLint
// from the repo root (`eslint packages/x/src/…`) placed the LOADING_EXCEPTIONS globs relative to
// the root and silently dropped the exception, while `eslint .` inside packages/x kept it. The
// workspace now comes from `workspaceDir: import.meta.dirname`, like base()'s tsconfigRootDir.
// This runs the real ESLint CLI in a subprocess from both places and compares the results.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { RESTRICTED_SYNTAX } from '../boundaries.js';
import { reactUi, UI_RESTRICTED_SYNTAX } from '../react-ui.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const eslintBin = join(dirname(fileURLToPath(import.meta.resolve('eslint'))), '../bin/eslint.js');
const SYNTAX = 'no-restricted-syntax';

// A throwaway repo: pnpm-workspace.yaml at its root and one UI workspace, packages/x, whose
// eslint.config.js is written the way every real UI workspace's is. The fixture exception is
// registered by the config itself, because the subprocess has its own module state.
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ralysa-workspace-dir-')));
const workspace = join(repo, 'packages/x');
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});
writeFileSync(join(repo, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
mkdirSync(join(workspace, 'src/legacy'), { recursive: true });
const url = (file: string): string => pathToFileURL(join(pkg, file)).href;
writeFileSync(
  join(workspace, 'eslint.config.js'),
  [
    `import { LOADING_EXCEPTIONS } from '${url('boundaries.js')}';`,
    `import { base, reactUi, tests } from '${url('index.js')}';`,
    "LOADING_EXCEPTIONS.push({ files: ['packages/x/src/legacy/**'], reason: 'test fixture' });",
    'export default [',
    '  ...base({ tsconfigRootDir: import.meta.dirname }),',
    `  ...reactUi({ workspaceDir: import.meta.dirname, tailwindEntryPoint: ${JSON.stringify(join(here, 'fixtures/tailwind.css'))} }),`,
    '  ...tests(),',
    '];',
    '',
  ].join('\n'),
);
const LOADER = 'const spec = "x";\nexport const p = import(spec);\n';
writeFileSync(join(workspace, 'src/legacy/a.js'), LOADER);
writeFileSync(join(workspace, 'src/a.js'), LOADER);

function eslint(cwd: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [eslintBin, ...args], { cwd, encoding: 'utf8' });
  } catch (error) {
    // Exit 1 means lint errors; stdout still holds the report.
    const { status, stdout } = error as { status: number; stdout: string };
    if (status === 1) return stdout;
    throw error;
  }
}

const syntaxRule = (cwd: string, file: string): unknown => {
  const config = JSON.parse(eslint(cwd, ['--print-config', file])) as {
    rules: Record<string, unknown>;
  };
  return config.rules[SYNTAX];
};

const syntaxErrors = (cwd: string, files: string[]): Record<string, number> => {
  const results = JSON.parse(eslint(cwd, ['--format', 'json', ...files])) as {
    filePath: string;
    messages: { ruleId: string | null }[];
  }[];
  return Object.fromEntries(
    results.map((r) => [
      r.filePath.slice(workspace.length + 1),
      r.messages.filter((m) => m.ruleId === SYNTAX).length,
    ]),
  );
};

describe('reactUi({ workspaceDir }): the same result from any working directory', () => {
  it('requires workspaceDir (or an explicit workspace)', () => {
    expect(() => reactUi()).toThrow(/workspaceDir: import\.meta\.dirname/);
    expect(() => reactUi({ workspace: 'packages/x' })).not.toThrow();
  });

  it('--print-config: identical from the repo root and from the workspace', () => {
    for (const file of ['src/legacy/a.js', 'src/a.js']) {
      const fromRoot = syntaxRule(repo, `packages/x/${file}`);
      const fromWorkspace = syntaxRule(workspace, file);
      expect(fromRoot).toEqual(fromWorkspace);
    }
    // And the exception is really applied: only the UI selector remains in the excepted file.
    expect(syntaxRule(repo, 'packages/x/src/legacy/a.js')).toEqual([2, ...UI_RESTRICTED_SYNTAX]);
    expect(syntaxRule(repo, 'packages/x/src/a.js')).toEqual([
      2,
      ...RESTRICTED_SYNTAX,
      ...UI_RESTRICTED_SYNTAX,
    ]);
  });

  it('lint results: the excepted file passes and the other fails, from both places', () => {
    const expected = { 'src/a.js': 1, 'src/legacy/a.js': 0 };
    expect(syntaxErrors(repo, ['packages/x/src/a.js', 'packages/x/src/legacy/a.js'])).toEqual(
      expected,
    );
    expect(syntaxErrors(workspace, ['src/a.js', 'src/legacy/a.js'])).toEqual(expected);
  });
});
