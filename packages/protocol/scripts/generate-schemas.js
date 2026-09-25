// check:generated for @ralysa/protocol (F-002 design §3.5): regenerates src/schema/generated/*.json
// from the built contracts. It runs after `tsc -p tsconfig.build.json` (see package.json), so it
// needs no TypeScript runner. CI fails if the result differs from what is committed.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSchemas } from '../dist/schema/generator.js';

const out = join(import.meta.dirname, '..', 'src', 'schema', 'generated');
mkdirSync(out, { recursive: true });
const files = generateSchemas();
for (const name of readdirSync(out)) {
  if (name.endsWith('.json') && !files.has(name)) rmSync(join(out, name));
}
for (const [name, text] of files) writeFileSync(join(out, name), text);
console.log(`@ralysa/protocol: ${String(files.size)} JSON Schemas in src/schema/generated`);
