import { ESLint, type Linter } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOUNDARY_RULE_IDS } from '../boundaries.js';
import { base, isomorphic, reactUi, tests } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function eslintFor(config: Linter.Config[]): ESLint {
  return new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
}

async function ruleIds(config: Linter.Config[], code: string, filePath: string): Promise<string[]> {
  const [result] = await eslintFor(config).lintText(code, { filePath: join(root, filePath) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
}

const everyPreset = (): Linter.Config[] => [
  ...base({ tsconfigRootDir: root }),
  ...isomorphic(),
  ...reactUi({ workspaceDir: root }),
  ...tests(),
];

describe('base preset: boundary rules everywhere (RC-3)', () => {
  const paths = [
    'src/feature.ts',
    'src/feature.test.ts',
    'test/helpers/fixture.ts',
    'e2e/walk.spec.ts',
    'scripts/build-tokens.ts',
    'vite.config.ts',
    'eslint.config.js',
  ];

  it.each(paths)(
    'keeps every boundary rule at error for %s with all presets composed',
    async (path) => {
      const config = (await eslintFor(everyPreset()).calculateConfigForFile(join(root, path))) as {
        rules: Record<string, [number, ...unknown[]]>;
      };
      for (const id of BOUNDARY_RULE_IDS) {
        expect(config.rules[id]?.[0], `${id} for ${path}`).toBe(2);
      }
      expect(config.rules['@eslint-community/eslint-comments/no-restricted-disable']?.[0]).toBe(2);
    },
  );

  it('the tests preset does not mention any boundary or lint-comment rule', () => {
    const touched = tests().flatMap((config) => Object.keys(config.rules ?? {}));
    for (const id of BOUNDARY_RULE_IDS) expect(touched).not.toContain(id);
    expect(touched.filter((id) => id.includes('eslint-comments'))).toEqual([]);
  });
});

describe('base preset: lint-disable comments (SEC-F001-09 f)', () => {
  const config = (): Linter.Config[] => base({ tsconfigRootDir: root });

  it('rejects a bare eslint-disable block comment', async () => {
    const ids = await ruleIds(config(), '/* eslint-disable */\nexport const a = 1;\n', 'src/a.js');
    expect(ids).toContain('@eslint-community/eslint-comments/no-unlimited-disable');
  });

  it('rejects inline rule configuration', async () => {
    const ids = await ruleIds(
      config(),
      '/* eslint no-restricted-imports: off */\nexport const a = 1;\n',
      'src/a.js',
    );
    expect(ids).toContain('@eslint-community/eslint-comments/no-use');
  });

  it('rejects disabling a boundary rule even with a reason', async () => {
    const ids = await ruleIds(
      config(),
      '// eslint-disable-next-line no-restricted-imports -- trying to sneak past\nimport x from "y";\nexport { x };\n',
      'src/a.js',
    );
    expect(ids).toContain('@eslint-community/eslint-comments/no-restricted-disable');
  });

  it('requires a description on eslint-disable-next-line', async () => {
    const ids = await ruleIds(
      config(),
      '// eslint-disable-next-line eqeqeq\nexport const same = (a, b) => a == b;\n',
      'src/a.js',
    );
    expect(ids).toContain('@eslint-community/eslint-comments/require-description');
  });

  it('accepts a described eslint-disable-next-line for an ordinary rule', async () => {
    const ids = await ruleIds(
      config(),
      '// eslint-disable-next-line eqeqeq -- loose equality is the point of this helper\nexport const same = (a, b) => a == b;\n',
      'src/a.js',
    );
    expect(ids).toEqual([]);
  });
});

describe('isomorphic preset (library-isomorphic)', () => {
  const config = (): Linter.Config[] => [...base({ tsconfigRootDir: root }), ...isomorphic()];

  it.each([
    "import { readFileSync } from 'node:fs';",
    "import { readFileSync } from 'fs';",
    "import { readFile } from 'fs/promises';",
    "import { createHash } from 'node:crypto';",
  ])('bans a Node built-in: %s', async (line) => {
    const ids = await ruleIds(config(), `${line}\nexport const x = 1;\n`, 'src/a.js');
    expect(ids).toContain('no-restricted-imports');
  });

  it('allows ordinary package imports', async () => {
    const ids = await ruleIds(
      config(),
      "import { z } from 'zod';\nexport const s = z;\n",
      'src/a.js',
    );
    expect(ids).toEqual([]);
  });
});

describe('react-ui preset: jsx-a11y through @eslint/compat under ESLint 10 (T02 spike)', () => {
  const config = (): Linter.Config[] => [
    ...base({ tsconfigRootDir: root }),
    ...reactUi({ workspaceDir: root }),
  ];

  it.each([
    ['jsx-a11y/alt-text', '<img src="a.png" />'],
    ['jsx-a11y/anchor-is-valid', '<a href="#">x</a>'],
    ['jsx-a11y/no-autofocus', '<input autoFocus />'],
    ['jsx-a11y/tabindex-no-positive', '<span tabIndex={3}>t</span>'],
    ['jsx-a11y/aria-props', '<div aria-foo="x" />'],
    ['jsx-a11y/role-has-required-aria-props', '<div role="checkbox" />'],
    ['jsx-a11y/click-events-have-key-events', '<div onClick={() => {}} />'],
    ['jsx-a11y/label-has-associated-control', '<label>name</label>'],
    ['jsx-a11y/no-redundant-roles', '<button role="button">b</button>'],
  ])('%s fires', async (rule, jsx) => {
    const ids = await ruleIds(config(), `export const X = () => (${jsx});\n`, 'src/x.jsx');
    expect(ids).toContain(rule);
    expect(ids).not.toContain('fatal');
  });

  it('an accessible element passes', async () => {
    const ids = await ruleIds(
      config(),
      'export const X = () => (<img src="a.png" alt="" />);\n',
      'src/x.jsx',
    );
    expect(ids).toEqual([]);
  });
});
