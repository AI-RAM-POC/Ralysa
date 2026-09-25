// AR-4 b: the Node check the ui-e2e job and the E2E global setup run.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { satisfiesEngine } from '../src/node-engine.ts';
import { REAL_ROOT } from './repo-copy.ts';

describe('satisfiesEngine', () => {
  it.each([
    ['v24.20.0', '>=24.12 <25', true],
    ['v24.12.0', '>=24.12 <25', true],
    ['v24.11.1', '>=24.12 <25', false],
    ['v25.0.0', '>=24.12 <25', false],
    ['v22.20.0', '>=24.12 <25', false],
    ['v24.1.0', '24.x', true],
    ['v23.9.0', '24.x', false],
    ['v24.0.0', '>=24', true],
    ['v24.0.0', '>24', false],
    ['v24.0.0', '=24.0.0', true],
    ['v24.3.0', '24', true],
  ])('%s against %s → %s', (version, range, expected) => {
    expect(satisfiesEngine(version, range)).toBe(expected);
  });

  it.each(['^24', '~24.1', '24 || 26', ''])('rejects an unsupported range %j', (range) => {
    expect(() => satisfiesEngine('v24.1.0', range)).toThrow();
  });

  it('the running Node satisfies the real engines.node (the CLI passes)', () => {
    const out = execFileSync(
      process.execPath,
      [join(REAL_ROOT, 'tooling/repo-scripts/src/check-node-engine.ts')],
      { cwd: REAL_ROOT, encoding: 'utf8' },
    );
    expect(out).toMatch(/satisfies engines.node/);
  });
});
