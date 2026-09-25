import { node } from '@ralysa/vitest-config';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  node,
  defineConfig({ test: { testTimeout: 30_000, setupFiles: ['./test/setup.ts'] } }),
);
