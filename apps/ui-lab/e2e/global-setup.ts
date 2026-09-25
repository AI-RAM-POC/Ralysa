// Runs once before any spec: the Node check (AR-4 b) and "were the apps built?".
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { satisfiesEngine } from '@ralysa/repo-scripts/node-engine';

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

export default function globalSetup(): void {
  const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const range = pkg.engines?.node;
  if (range === undefined) throw new Error('package.json has no engines.node');
  if (!satisfiesEngine(process.version, range)) {
    throw new Error(
      `Node ${process.version} does not satisfy engines.node "${range}". Pin a Playwright image whose Node does, or set up Node in the job (AR-4 b).`,
    );
  }
  for (const app of ['apps/ui-lab', 'apps/web']) {
    if (!existsSync(root(`${app}/dist/index.html`))) {
      throw new Error(
        `${app}/dist is missing. Build first: pnpm exec turbo run build --filter=@ralysa/ui-lab... --filter=@ralysa/web`,
      );
    }
  }
}
