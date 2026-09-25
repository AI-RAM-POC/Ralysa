// Writes openapi/control-plane.v1.json from the built route contracts (F-002 design §3.10).
// `check:generated` runs it after tsc; CI fails if the committed file then differs.
import { writeFileSync } from 'node:fs';
import { openApiText } from '../dist/http/openapi.js';

writeFileSync(new URL('../openapi/control-plane.v1.json', import.meta.url), openApiText());
console.log('@ralysa/control-plane: openapi/control-plane.v1.json');
