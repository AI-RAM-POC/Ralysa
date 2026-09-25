// The @ralysa/tsconfig bases compile a small fixture under the pinned TypeScript with no
// diagnostics at all, so no base uses an option TypeScript 6.0 deprecates (AR-4 c). The
// isomorphic base has neither DOM nor Node types (design §2.1).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/lib/repo.ts';

const basesDir = join(findRepoRoot(), 'tooling', 'tsconfig');

function compile(
  base: string,
  source: string,
  extraOptions: Record<string, unknown> = {},
): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'ralysa-tsbase-'));
  mkdirSync(join(dir, 'src'));
  // Every Ralysa workspace is ESM; under NodeNext a folder without this is CommonJS.
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  const isTsx = source.includes('<');
  writeFileSync(join(dir, 'src', isTsx ? 'index.tsx' : 'index.ts'), source);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: join(basesDir, base),
      compilerOptions: { typeRoots: [], ...extraOptions },
      include: ['src'],
    }),
  );
  const parsed = ts.getParsedCommandLineOfConfigFile(join(dir, 'tsconfig.json'), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  });
  if (parsed === undefined) throw new Error('could not parse config');
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(
    (d) => `TS${String(d.code)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
  );
}

const plain = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';

describe('@ralysa/tsconfig bases', () => {
  it.each(['base.json', 'lib-isomorphic.json', 'lib-dom.json'])('%s compiles cleanly', (base) => {
    expect(compile(base, plain)).toEqual([]);
  });

  it('react-lib.json compiles JSX with the automatic runtime (types stubbed)', () => {
    const source =
      'declare global { namespace JSX { interface IntrinsicElements { div: object } } }\nexport const x = 1;\n';
    expect(compile('react-lib.json', source, { jsx: 'preserve' })).toEqual([]);
  });

  it.each(['lib-node.json', 'node-service.json', 'node-cli.json'])(
    '%s asks for Node types',
    (base) => {
      // typeRoots is emptied above, so the only error allowed is the missing @types/node.
      const errors = compile(base, plain);
      expect(errors.every((e) => e.startsWith('TS2688'))).toBe(true);
    },
  );

  it('lib-isomorphic.json rejects DOM globals', () => {
    const errors = compile('lib-isomorphic.json', 'export const title = document.title;\n');
    expect(errors.join('\n')).toMatch(/TS2584|TS2304/);
  });

  it('lib-isomorphic.json rejects Node globals', () => {
    const errors = compile('lib-isomorphic.json', 'export const cwd = process.cwd();\n');
    expect(errors.join('\n')).toMatch(/TS2580|TS2591|TS2304/);
  });
});
