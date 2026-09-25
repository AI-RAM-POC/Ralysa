// PR #15 review nit: reactUi() used to derive its workspace from process.cwd(), so running ESLint
// from the repo root (`eslint packages/x/src/…`) placed the LOADING_EXCEPTIONS globs relative to
// the root and silently dropped the exception, while `eslint .` inside packages/x kept it. The
// workspace now comes from `workspaceDir: import.meta.dirname`, like base()'s tsconfigRootDir.
// This runs real ESLint in a subprocess from both places and compares the results.
//
// One subprocess per working directory (not one per CLI call): each one loads the whole preset
// stack once, then asks for the resolved config of both files and lints them, through the same
// ESLint class the CLI uses, with the default cwd (process.cwd()), as the CLI does. The two run
// concurrently. Eight separate `eslint` CLI runs took ~9 s locally and over 70 s on a loaded CI
// runner, past the 30 s test timeout (PR #17).
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESTRICTED_SYNTAX } from '../boundaries.js';
import { reactUi, UI_RESTRICTED_SYNTAX } from '../react-ui.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
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

// The driver, written into the throwaway repo. argv: the files, relative to the cwd. It prints
// { [file]: { rule, errors } }: the resolved no-restricted-syntax setting and how many
// no-restricted-syntax errors the file gets.
const driver = join(repo, 'driver.mjs');
writeFileSync(
  driver,
  [
    `import { ESLint } from ${JSON.stringify(import.meta.resolve('eslint'))};`,
    'const files = process.argv.slice(2);',
    'const eslint = new ESLint();',
    'const results = await eslint.lintFiles(files);',
    'const out = {};',
    'for (const [i, file] of files.entries()) {',
    '  const config = await eslint.calculateConfigForFile(file);',
    `  const errors = results[i].messages.filter((m) => m.ruleId === ${JSON.stringify(SYNTAX)}).length;`,
    `  out[file] = { rule: config.rules[${JSON.stringify(SYNTAX)}], errors };`,
    '}',
    'process.stdout.write(JSON.stringify(out));',
    '',
  ].join('\n'),
);

type Report = Record<string, { rule: unknown; errors: number }>;
const FILES = ['src/legacy/a.js', 'src/a.js'];

async function run(cwd: string, prefix: string): Promise<Report> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [driver, ...FILES.map((f) => prefix + f)],
    { cwd, encoding: 'utf8' },
  );
  const report = JSON.parse(stdout) as Report;
  // Key by the workspace-relative path, so both runs are directly comparable.
  return Object.fromEntries(FILES.map((f) => [f, report[prefix + f]!]));
}

let fromRoot: Report;
let fromWorkspace: Report;
beforeAll(async () => {
  [fromRoot, fromWorkspace] = await Promise.all([run(repo, 'packages/x/'), run(workspace, '')]);
}, 60_000);

describe('reactUi({ workspaceDir }): the same result from any working directory', () => {
  it('requires workspaceDir (or an explicit workspace)', () => {
    expect(() => reactUi()).toThrow(/workspaceDir: import\.meta\.dirname/);
    expect(() => reactUi({ workspace: 'packages/x' })).not.toThrow();
  });

  it('resolved config: identical from the repo root and from the workspace', () => {
    for (const file of FILES) expect(fromRoot[file]?.rule).toEqual(fromWorkspace[file]?.rule);
    // And the exception is really applied: only the UI selector remains in the excepted file.
    expect(fromRoot['src/legacy/a.js']?.rule).toEqual([2, ...UI_RESTRICTED_SYNTAX]);
    expect(fromRoot['src/a.js']?.rule).toEqual([2, ...RESTRICTED_SYNTAX, ...UI_RESTRICTED_SYNTAX]);
  });

  it('lint results: the excepted file passes and the other fails, from both places', () => {
    const errors = (report: Report) => Object.fromEntries(FILES.map((f) => [f, report[f]?.errors]));
    const expected = { 'src/a.js': 1, 'src/legacy/a.js': 0 };
    expect(errors(fromRoot)).toEqual(expected);
    expect(errors(fromWorkspace)).toEqual(expected);
  });
});
