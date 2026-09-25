#!/usr/bin/env node
// Pre-install gate: `node tooling/repo-scripts/src/pre-install-gate.ts`. Runs the static config
// gate (config-gate.ts) with Node built-ins only, before any pnpm command. In CI it is the first
// step after setup-node in every job that runs pnpm, because every pnpm command installs
// configDependencies and loads pnpmfiles, and `pnpm install` runs lifecycle scripts.
import { checkConfigGate } from './config-gate.ts';
import { findRepoRoot, formatFindings } from './lib/core.ts';

const root = findRepoRoot(process.cwd());
const { findings } = checkConfigGate({ root });
if (findings.length === 0) {
  console.log('✓ pre-install config gate');
} else {
  console.error(
    `✗ pre-install config gate (${String(findings.length)} finding${findings.length === 1 ? '' : 's'})`,
  );
  console.error(formatFindings(findings));
  console.error('Do not run pnpm on this tree until these are resolved.');
  process.exitCode = 1;
}
