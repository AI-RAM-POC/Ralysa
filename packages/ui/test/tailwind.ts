// Test helper: compile CSS with Tailwind v4's own compiler (no bundler) and build candidate classes.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';

// This package's own tailwindcss devDependency (a static path: the boundary rules ban
// createRequire, SEC-F001-09 b).
const TAILWIND_INDEX = fileURLToPath(
  new URL('../node_modules/tailwindcss/index.css', import.meta.url),
);

/** Compiles `css` (which may `@import "tailwindcss"` and relative files) and builds `classes`. */
export async function buildTailwind(css: string, base: string, classes: string[]): Promise<string> {
  const compiler = await compile(css, {
    base,
    loadStylesheet: (id: string, from: string) => {
      const path = id === 'tailwindcss' ? TAILWIND_INDEX : resolve(from, id);
      return Promise.resolve({ path, base: dirname(path), content: readFileSync(path, 'utf8') });
    },
  });
  return compiler.build(classes);
}
