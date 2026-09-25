// TC-F-001-42, hostname part (SR-03; SEC-F001-09 d): a provider hostname in source outside the
// gateway, and in a built bundle, fails check-provider-hosts; the same string inside
// services/model-gateway/** passes. Positive hostnames are derived from PROVIDER_HOSTS at
// runtime, so this file itself holds none (the real source check scans it too).
import { PROVIDER_HOSTS } from '@ralysa/eslint-config/boundaries';
import { describe, expect, it } from 'vitest';
import {
  checkProviderHosts,
  checkProviderHostsInArtefacts,
  findProviderHosts,
} from '../src/check-provider-hosts.ts';
import { writeFile } from './gitleaks-bin.ts';
import { REAL_ROOT } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

/** A concrete hostname for each pattern: `*.` → a resource name, `*` → a region. */
const sample = (pattern: string): string =>
  pattern
    .replace(/^\*\./, 'ralysa-prod.')
    .replace('*', pattern.startsWith('*a') ? 'us-central1-' : 'eu-west-1');

/** The sample hostname of the PROVIDER_HOSTS entry containing `part`. */
const host = (part: string): string => sample(PROVIDER_HOSTS.find((h) => h.includes(part)) ?? part);

const OPENAI = host('api.openai');
const fetchLine = (host: string): string =>
  `await fetch("https://${host}/v1/messages", { method: "POST" });`;

describe('findProviderHosts', () => {
  it.each(PROVIDER_HOSTS.map((pattern) => [pattern, sample(pattern)]))(
    '%s matches %s',
    (_, host) => {
      expect(findProviderHosts(fetchLine(host)).map((h) => h.host)).toEqual([host]);
      expect(findProviderHosts(`const base = '${host.toUpperCase()}';`)).toHaveLength(1);
    },
  );

  it('matches a listed host under a subdomain, and reports line numbers', () => {
    expect(findProviderHosts(`// a\n// b\nconst u = "wss://eu.${OPENAI}/v1";\n`)).toEqual([
      { host: OPENAI, line: 3 },
    ]);
  });

  it.each([
    'myapi.openai.com',
    'api.openai.company',
    'api.openai.com-proxy.example.net',
    'https://openai.com/policies',
    'https://platform.openai.com/docs',
    'https://docs.anthropic.com/en/api',
    "import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';",
    'bedrock.us-east-1.amazonaws.com',
    'https://huggingface.co/models',
    'openai.azure.com.evil',
    'https://ralysa.blob.core.windows.net',
  ])('does not match %s', (text) => {
    expect(findProviderHosts(text)).toEqual([]);
  });
});

describe('check-provider-hosts: source', () => {
  it('passes the real repository (0 findings on main)', () => {
    expect(checkProviderHosts(REAL_ROOT)).toEqual([]);
  });

  it('fails outside the gateway and passes inside it and in docs', () => {
    const root = makeTempDir('ralysa-hosts-');
    const files: Record<string, string> = {
      'apps/web/src/api.ts': `export const a = 1;\n${fetchLine(OPENAI)}\n`,
      'packages/sdk/test/client.test.ts': fetchLine(host('openai.azure')),
      'services/control-plane/src/llm.ts': fetchLine(host('bedrock')),
      'services/model-gateway-v2/src/x.ts': fetchLine(OPENAI),
      'packs/finance/tools/fetch.js': fetchLine(host('groq')),
      'apps/web/vite.config.ts': `export default { server: { proxy: { '/v1': 'https://${OPENAI}' } } };`,
      'services/model-gateway/src/providers/openai.ts': fetchLine(OPENAI),
      'services/model-gateway/README.md': OPENAI,
      'docs/architecture/model-gateway.md': OPENAI,
      'README.md': OPENAI,
      'requirements/spec.txt': OPENAI,
      'tooling/eslint-config/boundaries.js': `export const H = ['${OPENAI}'];`,
    };
    for (const [path, content] of Object.entries(files)) writeFile(root, path, content);
    expect(checkProviderHosts(root, Object.keys(files)).map((f) => `${f.rule} ${f.path}`)).toEqual([
      'provider-hosts/source apps/web/src/api.ts:2',
      'provider-hosts/source packages/sdk/test/client.test.ts:1',
      'provider-hosts/source services/control-plane/src/llm.ts:1',
      'provider-hosts/source services/model-gateway-v2/src/x.ts:1',
      'provider-hosts/source packs/finance/tools/fetch.js:1',
      'provider-hosts/source apps/web/vite.config.ts:1',
    ]);
  });
});

describe('check-provider-hosts --artefacts', () => {
  function repo(files: Record<string, string>): string {
    const root = makeTempDir('ralysa-hosts-art-');
    writeFile(root, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
    const meta = (shipped: boolean) =>
      JSON.stringify({
        name: 'x',
        ralysa: { kind: 'app', shipped, ui: true, artefacts: ['dist'] },
      });
    writeFile(root, 'apps/web/package.json', meta(true));
    writeFile(root, 'apps/ui-lab/package.json', meta(false));
    for (const [path, content] of Object.entries(files)) writeFile(root, path, content);
    return root;
  }

  it('fails on a provider host in a built bundle', () => {
    const root = repo({
      'apps/web/dist/index.html': '<!doctype html>',
      'apps/web/dist/assets/index-abc123.js': `var e="https://${host('anthropic')}/v1/messages";`,
    });
    expect(checkProviderHostsInArtefacts(root).map((f) => `${f.rule} ${f.path}`)).toEqual([
      'provider-hosts/artefact apps/web/dist/assets/index-abc123.js:1',
    ]);
  });

  it('passes a clean bundle and ignores unshipped workspaces', () => {
    const root = repo({
      'apps/web/dist/assets/index-abc123.js': 'var e="/api/v1";',
      'apps/ui-lab/dist/assets/demo.js': `var e="https://${OPENAI}";`,
    });
    expect(checkProviderHostsInArtefacts(root)).toEqual([]);
  });

  it('fails when a shipped artefact path is missing', () => {
    expect(checkProviderHostsInArtefacts(repo({})).map((f) => f.rule)).toEqual([
      'provider-hosts/artefact-missing',
    ]);
  });
});
