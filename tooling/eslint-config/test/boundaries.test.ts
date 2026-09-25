// TC-F-001-29 (ESLint layer) and the dynamic-loading and disable parts of TC-F-001-42
// (ADR-0012, SR-03, ADR-0024; RC-3; SEC-F001-08, -09 b/f). dependency-cruiser's layer, which
// also sees require() and import(), is tested in tooling/repo-scripts/test/check-imports.test.ts.
import { ESLint, type Linter } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import {
  BANNED_PACKAGE_GROUPS,
  bannedGroupOf,
  bannedImportPatterns,
  globSource,
} from '../boundaries.js';
import { base, isomorphic, reactUi, tests, workspaceGlob } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function lint(code: string, filePath: string, workspace = 'apps/web'): Promise<string[]> {
  const config: Linter.Config[] = [
    ...base({ tsconfigRootDir: root, workspace }),
    ...reactUi({ workspaceDir: root }),
    ...tests(),
  ];
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? `fatal: ${message.message}`);
}

const importOf = (name: string): string => `import x from '${name}';\nexport { x };\n`;

// RC-3: source, test, test-helper, script and config paths all get the same boundary rules.
const PATHS = [
  'src/feature.js',
  'src/feature.test.js',
  'test/helpers/fixture.js',
  'scripts/build-tokens.mjs',
  'vite.config.js',
];

describe('banned packages: no-restricted-imports in the base preset', () => {
  const banned = [
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk/embed',
    '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    '@anthropic-ai/sdk',
    '@anthropic-ai/claude-code',
    '@anthropic-ai/anything-new',
    'openai',
    'openai/resources/chat',
    '@azure/openai',
    '@google/genai',
    '@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/client-bedrock-agent-runtime',
    '@mistralai/mistralai',
    'groq-sdk',
    '@huggingface/transformers',
    '@openrouter/ai-sdk-provider',
    'ai',
    'ai/rsc',
    '@ai-sdk/react',
    '@ai-sdk/gateway',
    '@langchain/core',
    'onnxruntime-node',
    '@tensorflow/tfjs-node',
    'tesseract.js',
    '@sentry/node',
    'dd-trace',
    'posthog-js',
    '@vercel/analytics',
    '@fullstory/browser',
  ];

  it.each(banned)('%s is an error', async (name) => {
    expect(await lint(importOf(name), 'src/feature.js')).toContain('no-restricted-imports');
  });

  it.each(PATHS)('fires in %s too (RC-3)', async (path) => {
    for (const name of [
      '@anthropic-ai/claude-agent-sdk',
      'openai',
      '@ai-sdk/react',
      '@sentry/react',
    ]) {
      expect(await lint(importOf(name), path), `${name} in ${path}`).toContain(
        'no-restricted-imports',
      );
    }
  });

  it.each(['zod', 'aim', 'ai-utils', 'openai-compatible-sdk-docs', '@aws-sdk/client-s3', 'react'])(
    'look-alike %s is allowed',
    async (name) => {
      expect(await lint(importOf(name), 'src/feature.js')).toEqual([]);
    },
  );

  it('the type-only form is banned too', async () => {
    // A virtual .ts file isn't in any tsconfig project, so this case parses without type info;
    // no-restricted-imports is syntactic.
    const config: Linter.Config[] = [
      ...base({ tsconfigRootDir: root, workspace: 'apps/web' }),
      { ...tseslint.configs.disableTypeChecked, files: ['**/*.ts'] },
      { files: ['**/*.ts'], languageOptions: { parserOptions: { projectService: false } } },
    ];
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
    const [result] = await eslint.lintText(
      "import type { x } from 'openai';\nexport type { x };\n",
      {
        filePath: join(root, 'src/types.ts'),
      },
    );
    expect(result?.messages.map((m) => m.ruleId)).toEqual(['no-restricted-imports']);
  });

  it('re-exports are banned', async () => {
    expect(await lint("export { x } from 'openai';\n", 'src/feature.js')).toContain(
      'no-restricted-imports',
    );
  });
});

describe('allowed paths (boundaries.js importAllowedIn)', () => {
  it('agent-host engine/claude may import the Agent SDK and its @anthropic-ai/sdk peer', async () => {
    const path = 'src/engine/claude/run.js';
    for (const name of [
      '@anthropic-ai/claude-agent-sdk',
      '@anthropic-ai/claude-agent-sdk-linux-x64',
      '@anthropic-ai/sdk',
    ]) {
      expect(await lint(importOf(name), path, 'services/agent-host'), name).toEqual([]);
    }
  });

  it('agent-host engine/claude still may not import other providers or vendor telemetry', async () => {
    const path = 'src/engine/claude/run.js';
    for (const name of ['openai', '@anthropic-ai/claude-code', 'ai', '@sentry/node']) {
      expect(await lint(importOf(name), path, 'services/agent-host'), name).toContain(
        'no-restricted-imports',
      );
    }
  });

  it('the rest of agent-host may not import the Agent SDK', async () => {
    for (const path of ['src/server.js', 'src/engine/other/run.js', 'test/engine.test.js']) {
      expect(
        await lint(importOf('@anthropic-ai/claude-agent-sdk'), path, 'services/agent-host'),
        path,
      ).toContain('no-restricted-imports');
    }
  });

  it('the model gateway may import provider SDKs in any file', async () => {
    for (const path of ['src/providers/openai.js', 'test/providers.test.js', 'vite.config.js']) {
      for (const name of ['openai', '@anthropic-ai/sdk', 'ai', '@aws-sdk/client-bedrock-runtime']) {
        expect(
          await lint(importOf(name), path, 'services/model-gateway'),
          `${name} ${path}`,
        ).toEqual([]);
      }
    }
  });

  it('the model gateway may not import the Agent SDK or vendor telemetry', async () => {
    for (const name of ['@anthropic-ai/claude-agent-sdk', 'dd-trace']) {
      expect(await lint(importOf(name), 'src/a.js', 'services/model-gateway'), name).toContain(
        'no-restricted-imports',
      );
    }
  });

  it('a look-alike workspace name gets no exception', async () => {
    expect(await lint(importOf('openai'), 'src/a.js', 'services/model-gateway-v2')).toContain(
      'no-restricted-imports',
    );
  });

  it('the isomorphic preset keeps the package bans', async () => {
    const config: Linter.Config[] = [
      ...base({ tsconfigRootDir: root, workspace: 'packages/protocol' }),
      ...isomorphic(),
    ];
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
    const [result] = await eslint.lintText(importOf('openai'), {
      filePath: join(root, 'src/a.js'),
    });
    expect(result?.messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
  });
});

describe('dynamic loading ban: no-restricted-syntax (SEC-F001-09 b)', () => {
  it.each([
    ['import() with a variable', 'const name = "openai";\nexport const m = import(name);\n'],
    ['import() with a template', 'const v = "ai";\nexport const m = import(`${v}`);\n'],
    ['require() with a variable', 'const n = "openai";\nexport const m = require(n);\n'],
    ['require() with a concatenation', 'export const m = require("open" + "ai");\n'],
    [
      'createRequire import',
      "import { createRequire } from 'node:module';\nexport const r = createRequire;\n",
    ],
    [
      'module.createRequire',
      "import mod from 'node:module';\nexport const r = mod.createRequire(import.meta.url);\n",
    ],
    [
      'computed createRequire',
      "import mod from 'node:module';\nexport const r = mod['createRequire'];\n",
    ],
    ['process.getBuiltinModule', "export const fs = process.getBuiltinModule('fs');\n"],
    ['eval', "export const v = eval('1 + 1');\n"],
    ['indirect eval', "export const v = (0, globalThis.eval)('1');\n"],
    ['new Function', "export const f = new Function('return 1');\n"],
    ['Function()', "export const f = Function('return 1');\n"],
    // Code review finding 5: require without a bare `require` callee.
    ['module.require with a concatenation', "export const m = module.require('op' + 'enai');\n"],
    ['module.require with a variable', 'const n = "x";\nexport const m = module.require(n);\n'],
    ['computed module["require"]', "const n = 'x';\nexport const m = module['require'](n);\n"],
    ['process.mainModule.require', "export const m = process.mainModule.require('op' + 'enai');\n"],
    [
      'an alias of process.mainModule',
      'const main = process.mainModule;\nexport const r = main;\n',
    ],
    ['computed process["mainModule"]', "export const r = process['mainModule'];\n"],
    // Round 2: the require handle, not only direct calls.
    [
      'module.require.bind',
      "const rq = module.require.bind(module);\nexport const m = rq('op' + 'enai');\n",
    ],
    [
      'destructured { require: rq }',
      "const { require: rq } = module;\nexport const m = rq('x');\n",
    ],
    [
      "destructured { 'require': rq }",
      "const { 'require': rq } = module;\nexport const m = rq('x');\n",
    ],
    [
      'Reflect.apply(module.require, …)',
      "export const m = Reflect.apply(module.require, module, ['op' + 'enai']);\n",
    ],
    ['module.require stored', 'const rq = module.require;\nexport { rq };\n'],
    ['module.require() with no argument', 'export const m = module.require();\n'],
  ])('%s is an error', async (_, code) => {
    expect(await lint(code, 'src/loader.js')).toContain('no-restricted-syntax');
  });

  it.each([
    ['import() with a literal', "export const m = import('./local.js');\n"],
    ['require() with a literal', "export const m = require('./local.cjs');\n"],
    ['import.meta.glob with a literal', "export const m = import.meta.glob('./pages/*.tsx');\n"],
    ['module.require with a literal', "export const m = module.require('./local.cjs');\n"],
  ])('%s is allowed', async (_, code) => {
    expect(await lint(code, 'src/loader.js')).not.toContain('no-restricted-syntax');
  });

  it.each(PATHS)('fires in %s too (RC-3)', async (path) => {
    expect(await lint('const n = "x";\nexport const m = import(n);\n', path)).toContain(
      'no-restricted-syntax',
    );
  });
});

describe('lint-disable comments cannot switch the boundary rules off (SEC-F001-09 f)', () => {
  it('a described disable-next-line for a banned import is itself an error', async () => {
    const ids = await lint(
      "// eslint-disable-next-line no-restricted-imports -- needed for a spike\nimport x from 'openai';\nexport { x };\n",
      'src/a.js',
    );
    expect(ids).toContain('@eslint-community/eslint-comments/no-restricted-disable');
  });

  it('a bare block disable before a banned import is an error', async () => {
    const ids = await lint(
      "/* eslint-disable */\nimport x from 'openai';\nexport { x };\n",
      'src/a.js',
    );
    expect(ids).toContain('@eslint-community/eslint-comments/no-unlimited-disable');
  });

  it('inline rule config that turns the rule off is an error', async () => {
    const ids = await lint(
      "/* eslint no-restricted-imports: off */\nimport x from 'openai';\nexport { x };\n",
      'src/a.js',
    );
    expect(ids).toContain('@eslint-community/eslint-comments/no-use');
  });

  it('disabling the loading ban is an error', async () => {
    const ids = await lint(
      '// eslint-disable-next-line no-restricted-syntax -- plugin loader\nexport const m = (n) => import(n);\n',
      'src/a.js',
    );
    expect(ids).toContain('@eslint-community/eslint-comments/no-restricted-disable');
  });
});

describe('boundaries.js helpers', () => {
  it('assigns every package to the first matching group', () => {
    expect(bannedGroupOf('@anthropic-ai/claude-agent-sdk')?.id).toBe('agent-sdk');
    expect(bannedGroupOf('@anthropic-ai/claude-agent-sdk-win32-x64')?.id).toBe('agent-sdk');
    expect(bannedGroupOf('@anthropic-ai/sdk')?.id).toBe('anthropic-sdk-peer');
    expect(bannedGroupOf('@anthropic-ai/claude-code')?.id).toBe('model-provider');
    expect(bannedGroupOf('@ai-sdk/react')?.id).toBe('model-provider');
    expect(bannedGroupOf('@sentry/browser')?.id).toBe('telemetry-vendor');
    expect(bannedGroupOf('zod')).toBeUndefined();
    expect(bannedGroupOf('@aws-sdk/client-s3')).toBeUndefined();
  });

  it('has no @ai-sdk/react exemption (SEC-F001-08)', () => {
    const provider = BANNED_PACKAGE_GROUPS.find((group) => group.id === 'model-provider');
    expect(provider?.packages).toEqual(expect.arrayContaining(['ai', '@ai-sdk/*']));
    expect(JSON.stringify(BANNED_PACKAGE_GROUPS)).not.toMatch(/@ai-sdk\/react/);
  });

  it('only the reviewed groups have allowed paths', () => {
    expect(
      Object.fromEntries(BANNED_PACKAGE_GROUPS.map((group) => [group.id, group.importAllowedIn])),
    ).toEqual({
      'agent-sdk': ['services/agent-host/src/engine/claude/**'],
      'anthropic-sdk-peer': [
        'services/agent-host/src/engine/claude/**',
        'services/model-gateway/**',
      ],
      'model-provider': ['services/model-gateway/**'],
      'telemetry-vendor': [],
    });
  });

  it('globSource', () => {
    expect(new RegExp(`^${globSource('@scope/*')}$`).test('@scope/pkg')).toBe(true);
    expect(new RegExp(`^${globSource('@scope/*')}$`).test('@scope/pkg/sub')).toBe(false);
    expect(new RegExp(`^${globSource('a/**')}$`).test('a/b/c')).toBe(true);
    expect(new RegExp(`^${globSource('tesseract.js')}$`).test('tesseractXjs')).toBe(false);
  });

  it('workspaceGlob maps repo globs into a workspace', () => {
    expect(workspaceGlob('services/agent-host/src/engine/claude/**', 'services/agent-host')).toBe(
      'src/engine/claude/**',
    );
    expect(workspaceGlob('services/model-gateway/**', 'services/model-gateway')).toBe('**');
    expect(workspaceGlob('services/model-gateway/**', 'services/agent-host')).toBeUndefined();
    expect(workspaceGlob('services/model-gateway/**', 'services/model-gateway-v2')).toBeUndefined();
  });

  it('bannedImportPatterns drops only the allowed groups', () => {
    expect(bannedImportPatterns()).toHaveLength(BANNED_PACKAGE_GROUPS.length);
    expect(bannedImportPatterns(['model-provider'])).toHaveLength(BANNED_PACKAGE_GROUPS.length - 1);
  });
});
