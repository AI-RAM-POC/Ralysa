// Shared Vitest presets. `test` is hermetic: no network, database or containers (F-001 design
// §2.1). Tests that need services go in a workspace's `test:integration` script instead.
// Use: `export default mergeConfig(node, defineConfig({ test: { ... } }))`.
import { defineConfig } from 'vitest/config';

const shared = {
  include: ['{src,test}/**/*.test.{ts,tsx}'],
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
  passWithNoTests: false,
};

/** Node environment: services, CLIs, tooling and isomorphic libraries. */
export const node = defineConfig({ test: { ...shared, environment: 'node' } });

/** jsdom environment: React components. The workspace adds `jsdom` as a devDependency. */
export const jsdom = defineConfig({ test: { ...shared, environment: 'jsdom' } });
