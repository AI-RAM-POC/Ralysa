// TC-F-001-29 (closure part) and the alias part of TC-F-001-42 (SR-03, ADR-0012, ADR-0024,
// AC-13; AR-5, AR-6; SEC-F001-08, -09 a/c). Lockfiles are small synthetic v9 documents.
import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  checkBannedDeps,
  checkBannedDepsGraph,
  packageNameOfKey,
} from '../src/check-banned-deps.ts';
import { REAL_ROOT } from './repo-copy.ts';

type Deps = Record<string, string>;
interface Importer {
  dependencies?: Deps;
  devDependencies?: Deps;
  optionalDependencies?: Deps;
}

const NAMES = new Map([
  ['.', 'ralysa'],
  ['apps/web', '@ralysa/web'],
  ['apps/cli', '@ralysa/cli'],
  ['apps/ui-lab', '@ralysa/ui-lab'],
  ['packages/ui', '@ralysa/ui'],
  ['services/agent-host', '@ralysa/agent-host'],
  ['services/model-gateway', '@ralysa/model-gateway'],
]);

/** Importer deps are written `name: version`; the helper wraps them the way the lockfile does. */
function lockfile(
  importers: Record<string, Importer>,
  snapshots: Record<string, { dependencies?: Deps; optionalDependencies?: Deps }> = {},
): unknown {
  const wrap = (deps?: Deps) =>
    deps &&
    Object.fromEntries(
      Object.entries(deps).map(([name, version]) => [name, { specifier: version, version }]),
    );
  return {
    lockfileVersion: '9.0',
    importers: Object.fromEntries(
      Object.entries(importers).map(([path, entry]) => [
        path,
        {
          dependencies: wrap(entry.dependencies),
          devDependencies: wrap(entry.devDependencies),
          optionalDependencies: wrap(entry.optionalDependencies),
        },
      ]),
    ),
    snapshots: Object.fromEntries(Object.entries(snapshots).map(([k, v]) => [k, v])),
  };
}

const check = (doc: unknown) => checkBannedDepsGraph(buildGraph(doc, NAMES));
const summary = (doc: unknown) => check(doc).map((f) => `${f.rule} ${f.path}`);

describe('check-banned-deps', () => {
  it('passes the real lockfile', () => {
    expect(checkBannedDeps({ root: REAL_ROOT })).toEqual([]);
  });

  it('packageNameOfKey strips the version and peer suffix', () => {
    expect(packageNameOfKey('openai@4.0.0')).toBe('openai');
    expect(packageNameOfKey('@ai-sdk/react@4.0.117(react@19.3.0)')).toBe('@ai-sdk/react');
    expect(packageNameOfKey('@scope/x@1.0.0(@scope/y@2.0.0(z@3.0.0))')).toBe('@scope/x');
  });

  it('a clean graph passes', () => {
    const doc = lockfile(
      { 'apps/web': { dependencies: { react: '19.3.0' }, devDependencies: { vitest: '4.1.11' } } },
      {
        'react@19.3.0': {},
        'vitest@4.1.11': { dependencies: { tinyspy: '4.0.0' } },
        'tinyspy@4.0.0': {},
      },
    );
    expect(check(doc)).toEqual([]);
  });

  describe('model providers (SR-03)', () => {
    it('a direct provider SDK in a web app fails', () => {
      const doc = lockfile(
        { 'apps/web': { dependencies: { openai: '6.0.0' } } },
        { 'openai@6.0.0': {} },
      );
      expect(summary(doc)).toEqual(['banned-deps/model-provider apps/web']);
    });

    it('a provider SDK in the **dev** closure, two levels down, fails (SEC-F001-09 c)', () => {
      const doc = lockfile(
        { 'packages/ui': { devDependencies: { 'some-tool': '1.0.0' } } },
        {
          'some-tool@1.0.0': { dependencies: { helper: '2.0.0' } },
          'helper@2.0.0': { dependencies: { '@ai-sdk/gateway': '1.0.0' } },
          '@ai-sdk/gateway@1.0.0': {},
        },
      );
      const [finding] = check(doc);
      expect(finding?.rule).toBe('banned-deps/model-provider');
      expect(finding?.message).toContain(
        '@ralysa/ui (packages/ui) → some-tool@1.0.0 → helper@2.0.0 → @ai-sdk/gateway@1.0.0',
      );
    });

    it('an optional dependency is checked too', () => {
      const doc = lockfile(
        { 'apps/web': { optionalDependencies: { 'onnxruntime-node': '1.22.0' } } },
        { 'onnxruntime-node@1.22.0': {} },
      );
      expect(summary(doc)).toEqual(['banned-deps/model-provider apps/web']);
    });

    it('the root package.json is checked', () => {
      const doc = lockfile(
        { '.': { devDependencies: { langchain: '1.0.0' } } },
        { 'langchain@1.0.0': {} },
      );
      expect(summary(doc)).toEqual(['banned-deps/model-provider .']);
    });

    it('@ai-sdk/react brings in ai and @ai-sdk/gateway: no exemption (SEC-F001-08)', () => {
      const doc = lockfile(
        { 'apps/web': { dependencies: { '@ai-sdk/react': '4.0.117(react@19.3.0)' } } },
        {
          '@ai-sdk/react@4.0.117(react@19.3.0)': { dependencies: { ai: '7.0.114' } },
          'ai@7.0.114': { dependencies: { '@ai-sdk/gateway': '3.0.0' } },
          '@ai-sdk/gateway@3.0.0': {},
        },
      );
      expect(check(doc).map((f) => f.message.split(' ')[0])).toEqual([
        '@ai-sdk/react',
        'ai',
        '@ai-sdk/gateway',
      ]);
    });

    it('an npm: alias is caught by its resolved name (SEC-F001-09 a)', () => {
      const doc = lockfile(
        { 'apps/web': { dependencies: { 'totally-harmless': 'openai@6.0.0' } } },
        { 'openai@6.0.0': {} },
      );
      const [finding] = check(doc);
      expect(finding?.rule).toBe('banned-deps/model-provider');
      expect(finding?.message).toMatch(/^openai is in the dependency graph/);
    });

    it('an alias inside a dependency is caught too', () => {
      const doc = lockfile(
        { 'apps/web': { dependencies: { wrapper: '1.0.0' } } },
        {
          'wrapper@1.0.0': { dependencies: { llm: '@anthropic-ai/sdk@0.93.0' } },
          '@anthropic-ai/sdk@0.93.0': {},
        },
      );
      expect(summary(doc)).toEqual(['banned-deps/anthropic-sdk-peer apps/web']);
    });

    it('the model gateway may depend on providers', () => {
      const doc = lockfile(
        {
          'services/model-gateway': {
            dependencies: { openai: '6.0.0', '@anthropic-ai/sdk': '0.93.0', ai: '7.0.0' },
          },
        },
        { 'openai@6.0.0': {}, '@anthropic-ai/sdk@0.93.0': {}, 'ai@7.0.0': {} },
      );
      expect(check(doc)).toEqual([]);
    });
  });

  describe('Agent SDK (ADR-0012, AR-6)', () => {
    const snapshots = {
      '@anthropic-ai/claude-agent-sdk@0.3.282(zod@4.6.5)': {
        dependencies: { '@anthropic-ai/sdk': '0.93.0' },
        optionalDependencies: { '@anthropic-ai/claude-agent-sdk-darwin-arm64': '0.3.282' },
      },
      '@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.282': {},
      '@anthropic-ai/sdk@0.93.0': {},
    };
    const agentHost = {
      dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.282(zod@4.6.5)' },
    };

    it('agent-host may depend on the SDK, its platform packages and its @anthropic-ai/sdk peer', () => {
      expect(check(lockfile({ 'services/agent-host': agentHost }, snapshots))).toEqual([]);
    });

    it('apps/cli may reach the SDK through @ralysa/agent-host', () => {
      const doc = lockfile(
        {
          'apps/cli': { dependencies: { '@ralysa/agent-host': 'link:../../services/agent-host' } },
          'services/agent-host': agentHost,
        },
        snapshots,
      );
      expect(check(doc)).toEqual([]);
    });

    it('a direct Agent SDK dependency outside agent-host fails', () => {
      const doc = lockfile({ 'apps/cli': agentHost }, snapshots);
      expect(check(doc).map((f) => `${f.rule} ${f.message.split(' ')[0] ?? ''}`)).toEqual([
        'banned-deps/agent-sdk @anthropic-ai/claude-agent-sdk',
        'banned-deps/anthropic-sdk-peer @anthropic-ai/sdk',
        'banned-deps/agent-sdk @anthropic-ai/claude-agent-sdk-darwin-arm64',
      ]);
    });

    it('@anthropic-ai/sdk in agent-host, but not through the Agent SDK, fails', () => {
      const doc = lockfile(
        { 'services/agent-host': { dependencies: { '@anthropic-ai/sdk': '0.93.0' } } },
        { '@anthropic-ai/sdk@0.93.0': {} },
      );
      expect(summary(doc)).toEqual(['banned-deps/anthropic-sdk-peer services/agent-host']);
    });

    it('apps/web and packages/* may not depend on @ralysa/agent-host at all', () => {
      const doc = lockfile({
        'apps/web': { dependencies: { '@ralysa/ui': 'link:../../packages/ui' } },
        'packages/ui': {
          devDependencies: { '@ralysa/agent-host': 'link:../../services/agent-host' },
        },
        'services/agent-host': {},
      });
      expect(summary(doc)).toEqual([
        'banned-deps/workspace apps/web',
        'banned-deps/workspace packages/ui',
      ]);
      expect(check(doc)[0]?.message).toContain(
        '@ralysa/web (apps/web) → @ralysa/ui (packages/ui) → @ralysa/agent-host (services/agent-host)',
      );
    });
  });

  it('vendor telemetry is banned everywhere, the gateway included (ADR-0024)', () => {
    const doc = lockfile(
      {
        'apps/web': { dependencies: { '@sentry/react': '10.0.0' } },
        'services/model-gateway': { dependencies: { 'dd-trace': '5.0.0' } },
      },
      { '@sentry/react@10.0.0': {}, 'dd-trace@5.0.0': {} },
    );
    expect(summary(doc)).toEqual([
      'banned-deps/telemetry-vendor apps/web',
      'banned-deps/telemetry-vendor services/model-gateway',
    ]);
  });

  it('lucide-react only through @ralysa/ui, the icon registry (§3.4, AC-7)', () => {
    const doc = lockfile(
      {
        'packages/ui': { dependencies: { 'lucide-react': '1.34.0' } },
        'apps/web': { dependencies: { '@ralysa/ui': 'link:../../packages/ui' } },
        'apps/ui-lab': {
          dependencies: { '@ralysa/ui': 'link:../../packages/ui', 'lucide-react': '1.34.0' },
        },
      },
      { 'lucide-react@1.34.0': {} },
    );
    expect(summary(doc)).toEqual(['banned-deps/icon-set apps/ui-lab']);
  });

  it('nothing may depend on @ralysa/ui-lab (AC-13)', () => {
    const doc = lockfile({
      'apps/web': { devDependencies: { '@ralysa/ui-lab': 'link:../ui-lab' } },
      'apps/ui-lab': {},
    });
    expect(summary(doc)).toEqual(['banned-deps/workspace apps/web']);
  });

  it('handles dependency cycles', () => {
    const doc = lockfile(
      { 'apps/web': { dependencies: { a: '1.0.0' } } },
      {
        'a@1.0.0': { dependencies: { b: '1.0.0' } },
        'b@1.0.0': { dependencies: { a: '1.0.0', openai: '6.0.0' } },
        'openai@6.0.0': {},
      },
    );
    expect(summary(doc)).toEqual(['banned-deps/model-provider apps/web']);
  });

  it('fails closed on an unknown lockfile version or an unresolvable entry', () => {
    expect(summary({ lockfileVersion: '10.0', importers: {} })).toEqual([
      'banned-deps/lockfile pnpm-lock.yaml',
    ]);
    const doc = lockfile({ 'apps/web': { dependencies: { ghost: '1.0.0' } } });
    expect(summary(doc)).toEqual(['banned-deps/lockfile pnpm-lock.yaml']);
    const link = lockfile({ 'apps/web': { dependencies: { x: 'link:../../elsewhere' } } });
    expect(summary(link)).toEqual(['banned-deps/lockfile pnpm-lock.yaml']);
  });
});
