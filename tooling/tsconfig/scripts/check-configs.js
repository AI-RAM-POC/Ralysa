// Dependency-free sanity check for the shared tsconfig bases: every file in `exports` is valid
// JSON, and every relative `extends` target exists. The compile-level checks (TS 6 accepts each
// base with no deprecated options, AR-4 c) live in @ralysa/repo-scripts test/tsconfig-bases.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];

for (const target of Object.values(pkg.exports)) {
  const file = join(root, target);
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`${target}: not valid JSON (${error.message})`);
    continue;
  }
  const parents = [config.extends ?? []].flat();
  for (const parent of parents) {
    if (parent.startsWith('.') && !existsSync(join(root, parent))) {
      problems.push(`${target}: extends missing file ${parent}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`@ralysa/tsconfig: ${Object.keys(pkg.exports).length} configs OK`);
