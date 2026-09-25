// TC-F-001-26 (AC-13) and the dependency-cruiser layer of TC-F-001-29 (ADR-0012, SR-03, ADR-0024,
// RF-7, AR-9; RC-3): the real .dependency-cruiser.cjs over throw-away source trees. Unlike
// ESLint, this layer sees require() and import() with a literal, and it scans packs/**.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkImports } from '../src/check-imports.ts';
import { REAL_ROOT } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const CONFIG = join(REAL_ROOT, '.dependency-cruiser.cjs');

function tree(files: Record<string, string>): string {
  const root = makeTempDir('ralysa-fixture-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

async function violations(files: Record<string, string>): Promise<string[]> {
  const findings = await checkImports({ root: tree(files), configFile: CONFIG });
  return findings.map((f) => `${f.rule} ${f.path}`).sort();
}

// Every fixture also imports a harmless package, so the graph-sanity check has a package target.
const ok = "import { z } from 'zod';\nexport const schema = z;\n";

describe('check-imports (dependency-cruiser)', () => {
  it('passes the real repository', async () => {
    expect(await checkImports({ root: REAL_ROOT })).toEqual([]);
  });

  it('passes a clean tree', async () => {
    expect(
      await violations({
        'apps/web/src/main.ts': `${ok}import { x } from './x.ts';\nexport { x };\n`,
        'apps/web/src/x.ts': 'export const x = 1;\n',
        'packages/ui/src/index.ts': ok,
      }),
    ).toEqual([]);
  });

  it('TC-F-001-26: apps/web importing apps/ui-lab fails, by path or by package name (AC-13)', async () => {
    expect(
      await violations({
        'apps/web/src/main.ts': `${ok}import { demo } from '../../ui-lab/src/demo.ts';\nexport { demo };\n`,
        'apps/web/src/other.ts': "export { demo } from '@ralysa/ui-lab';\n",
        'apps/ui-lab/src/demo.ts': 'export const demo = 1;\n',
      }),
    ).toEqual([
      'imports/apps-not-to-other-apps apps/web/src/main.ts',
      'imports/no-ui-lab apps/web/src/main.ts',
      'imports/no-ui-lab apps/web/src/other.ts',
    ]);
  });

  it('require() and import() with a literal are caught, which ESLint does not see', async () => {
    expect(
      await violations({
        'apps/web/src/a.cjs': "const openai = require('openai');\nmodule.exports = openai;\n",
        'apps/web/src/b.ts': `${ok}export const sdk = await import('@anthropic-ai/claude-agent-sdk');\n`,
        'apps/web/src/c.ts': "export const t = await import('@sentry/browser');\n",
        'apps/web/src/d.ts':
          "import type { UIMessage } from '@ai-sdk/react';\nexport type M = UIMessage;\n",
      }),
    ).toEqual([
      'imports/banned-agent-sdk apps/web/src/b.ts',
      'imports/banned-model-provider apps/web/src/a.cjs',
      'imports/banned-model-provider apps/web/src/d.ts',
      'imports/banned-telemetry-vendor apps/web/src/c.ts',
    ]);
  });

  it('tests, scripts and config files are scanned too (RC-3)', async () => {
    const line = "import OpenAI from 'openai';\nexport { OpenAI };\n";
    expect(
      await violations({
        'apps/web/src/main.ts': ok,
        'apps/web/test/app.test.ts': line,
        'apps/web/scripts/build-tokens.ts': line,
        'apps/web/vite.config.ts': line,
        'tooling/repo-scripts/src/tool.ts': line,
      }),
    ).toEqual([
      'imports/banned-model-provider apps/web/scripts/build-tokens.ts',
      'imports/banned-model-provider apps/web/test/app.test.ts',
      'imports/banned-model-provider apps/web/vite.config.ts',
      'imports/banned-model-provider tooling/repo-scripts/src/tool.ts',
    ]);
  });

  it('packs/** is scanned, and nothing may import from it (RF-7)', async () => {
    expect(
      await violations({
        'packs/finance/tools/fetch.js': "import OpenAI from 'openai';\nexport { OpenAI };\n",
        'apps/web/src/main.ts': `${ok}import { rules } from '../../../packs/finance/rules.js';\nexport { rules };\n`,
        'packs/finance/rules.js': 'export const rules = [];\n',
      }),
    ).toEqual([
      'imports/banned-model-provider packs/finance/tools/fetch.js',
      'imports/no-packs apps/web/src/main.ts',
    ]);
  });

  it('the Agent SDK is allowed only in services/agent-host/src/engine/claude/**', async () => {
    const sdk =
      "import { query } from '@anthropic-ai/claude-agent-sdk';\nimport Anthropic from '@anthropic-ai/sdk';\nexport { query, Anthropic };\n";
    expect(
      await violations({
        'services/agent-host/src/engine/claude/run.ts': sdk,
        'services/agent-host/src/server.ts': sdk,
      }),
    ).toEqual([
      'imports/banned-agent-sdk services/agent-host/src/server.ts',
      'imports/banned-anthropic-sdk-peer services/agent-host/src/server.ts',
    ]);
  });

  it('provider SDKs are allowed only in services/model-gateway; vendor telemetry nowhere', async () => {
    expect(
      await violations({
        'services/model-gateway/src/providers.ts':
          "import OpenAI from 'openai';\nimport Anthropic from '@anthropic-ai/sdk';\nimport { generateText } from 'ai';\nexport { OpenAI, Anthropic, generateText };\n",
        'services/model-gateway/src/trace.ts':
          "import tracer from 'dd-trace';\nexport { tracer };\n",
        'services/model-gateway/src/agent.ts':
          "export { query } from '@anthropic-ai/claude-agent-sdk';\n",
        'services/control-plane/src/llm.ts': "import OpenAI from 'openai';\nexport { OpenAI };\n",
      }),
    ).toEqual([
      'imports/banned-agent-sdk services/model-gateway/src/agent.ts',
      'imports/banned-model-provider services/control-plane/src/llm.ts',
      'imports/banned-telemetry-vendor services/model-gateway/src/trace.ts',
    ]);
  });

  it('layering: packages do not import apps or services; services do not import each other; apps do not import services (AR-9)', async () => {
    expect(
      await violations({
        'packages/ui/src/a.ts': `${ok}import { x } from '../../../apps/web/src/x.ts';\nexport { x };\n`,
        'packages/ui/src/b.ts':
          "import { y } from '../../../services/control-plane/src/y.ts';\nexport { y };\n",
        'apps/web/src/x.ts':
          "import { y } from '../../../services/control-plane/src/y.ts';\nexport const x = y;\n",
        'services/control-plane/src/y.ts':
          "import { z } from '../../agent-host/src/z.ts';\nexport const y = z;\n",
        'services/agent-host/src/z.ts': "import { w } from './w.ts';\nexport const z = w;\n",
        'services/agent-host/src/w.ts': 'export const w = 1;\n',
      }),
    ).toEqual([
      'imports/apps-not-to-services apps/web/src/x.ts',
      'imports/packages-not-to-apps-or-services packages/ui/src/a.ts',
      'imports/packages-not-to-apps-or-services packages/ui/src/b.ts',
      'imports/services-not-to-other-services services/control-plane/src/y.ts',
    ]);
  });

  it('TC-F-002-35: shipped code importing @ralysa/dev-stack or oidc-provider fails; tests and tooling may (SEC-F002-13 a)', async () => {
    expect(
      await violations({
        'services/control-plane/src/idp.ts': `${ok}import { startMockIdp } from '@ralysa/dev-stack/mock-idp';\nexport { startMockIdp };\n`,
        'services/control-plane/src/provider.cjs':
          "const Provider = require('oidc-provider');\nmodule.exports = Provider;\n",
        'packages/auth/src/dev.ts':
          "export const mock = await import('../../../tooling/dev-stack/src/mock-idp/index.ts');\n",
        'apps/web/src/types.ts':
          "import type { Configuration } from 'oidc-provider';\nexport type C = Configuration;\n",
        'services/control-plane/test/integration/sign-in.int.ts': `${ok}import { startMockIdp } from '@ralysa/dev-stack/mock-idp';\nexport { startMockIdp };\n`,
        'tooling/dev-stack/src/mock-idp/index.ts':
          "import Provider from 'oidc-provider';\nexport { Provider };\n",
      }),
    ).toEqual([
      'imports/no-dev-only-in-shipped apps/web/src/types.ts',
      'imports/no-dev-only-in-shipped packages/auth/src/dev.ts',
      'imports/no-dev-only-in-shipped services/control-plane/src/idp.ts',
      'imports/no-dev-only-in-shipped services/control-plane/src/provider.cjs',
    ]);
  });

  it('fails when the options drop every package target (graph sanity)', async () => {
    expect(
      await violations({
        'apps/web/src/main.ts': "import { x } from './x.ts';\nexport { x };\n",
        'apps/web/src/x.ts': 'export const x = 1;\n',
      }),
    ).toEqual(['imports/graph-sanity .dependency-cruiser.cjs']);
  });
});
