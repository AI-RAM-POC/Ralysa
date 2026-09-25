import { describe, expect, it } from 'vitest';

// F-002-T01: proves the test:integration wiring (vitest.integration.config.ts, *.int.ts outside
// the hermetic include). Service-backed tests replace it from T02 on.
describe('@ralysa/secrets test:integration wiring', () => {
  it('runs *.int.ts files', () => {
    expect(expect.getState().testPath).toMatch(/\.int\.ts$/);
  });
});
