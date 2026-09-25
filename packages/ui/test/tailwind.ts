// Test helper: compile CSS with Tailwind v4's own compiler (no bundler) and build candidate classes.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { compile } from 'tailwindcss';

const require = createRequire(import.meta.url);

/** Compiles `css` (which may `@import "tailwindcss"` and relative files) and builds `classes`. */
export async function buildTailwind(css: string, base: string, classes: string[]): Promise<string> {
  const compiler = await compile(css, {
    base,
    loadStylesheet: (id: string, from: string) => {
      const path =
        id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : resolve(from, id);
      return Promise.resolve({ path, base: dirname(path), content: readFileSync(path, 'utf8') });
    },
  });
  return compiler.build(classes);
}
