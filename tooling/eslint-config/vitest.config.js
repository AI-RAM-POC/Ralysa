// Self-contained on purpose: @ralysa/vitest-config depends on this package for linting, so
// importing it here would create a workspace cycle.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
