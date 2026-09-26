import { defineConfig } from 'vitest/config';

// test:soak (F-002-T13, design §8.1): test/soak/**/*.soak.ts against the dev stack, run by hand or
// by the `soak` workflow (workflow_dispatch). Never part of `test` or `test:integration`.
export default defineConfig({
  test: {
    include: ['test/soak/**/*.soak.ts'],
    environment: 'node',
    restoreMocks: true,
    passWithNoTests: false,
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 120_000,
  },
});
