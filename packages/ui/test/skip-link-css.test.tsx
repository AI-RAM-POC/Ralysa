// PR #17 review 3: the skip link lost its padding on focus. `focus:not-sr-only` sets
// `padding: 0`, and it comes after `px-4 py-2` in the utilities layer, so the focused link needs
// its own `focus:px-4 focus:py-2`. jsdom applies no Tailwind CSS, so this compiles the link's
// real classes with Tailwind and reads which padding the last :focus rule leaves in place.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTokens } from '../scripts/build-tokens.ts';
import { SkipLink } from '../src/index.js';
import { buildTailwind } from './tailwind.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ralysa-ui-skip-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SkipLink focus styles (review 3)', () => {
  it('keeps its spacing-token padding when focused', async () => {
    const html = renderToStaticMarkup(<SkipLink target="content" />);
    const classes = (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);
    expect(classes).toContain('focus:not-sr-only');

    writeFileSync(join(dir, 'theme.css'), buildTokens(packageDir)['src/styles/theme.css']);
    const entry = readFileSync(join(packageDir, 'src/styles/tailwind.css'), 'utf8');
    const css = await buildTailwind(entry, dir, classes);

    // In source order within the utilities layer, the later :focus declaration wins.
    const declarations = [...css.matchAll(/\.focus\\:[^{]+:focus\s*\{([^}]*)\}/g)].flatMap((m) =>
      [...(m[1] ?? '').matchAll(/(padding(?:-inline|-block)?):\s*([^;]+);/g)].map((d) => ({
        property: d[1],
        value: d[2]?.trim(),
      })),
    );
    const winner = (axis: string): string | undefined =>
      declarations.filter((d) => d.property === 'padding' || d.property === axis).at(-1)?.value;
    expect(winner('padding-inline')).toBe('var(--ralysa-space-4)');
    expect(winner('padding-block')).toBe('var(--ralysa-space-2)');
  });
});
