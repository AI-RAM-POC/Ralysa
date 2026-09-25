#!/usr/bin/env node
// `node tooling/repo-scripts/src/check-node-engine.ts`: fails when the running Node doesn't satisfy
// the root package.json `engines.node` (AR-4 b). Node built-ins only, so it can run before pnpm;
// the CI ui-e2e job runs it first thing in the Playwright container.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './lib/core.ts';
import { satisfiesEngine } from './node-engine.ts';

const root = findRepoRoot(process.cwd());
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  engines?: { node?: string };
};
const range = pkg.engines?.node;
if (range === undefined) {
  console.error('✗ package.json has no engines.node');
  process.exitCode = 1;
} else if (satisfiesEngine(process.version, range)) {
  console.log(`✓ Node ${process.version} satisfies engines.node "${range}"`);
} else {
  console.error(
    `✗ Node ${process.version} does not satisfy engines.node "${range}". Pin a Playwright image whose Node does, or set up Node in the job (AR-4 b).`,
  );
  process.exitCode = 1;
}
