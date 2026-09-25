// Self-contained, like @ralysa/eslint-config's: this package doesn't need the shared presets.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
