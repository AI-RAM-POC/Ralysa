// check-integration-scope: a dev-stack binding read at describe-collection time crashes the run
// when the stack is absent (PR #18 review, finding 1). Reads inside hooks, tests and helpers pass.
import { describe, expect, it } from 'vitest';
import {
  checkIntegrationScope,
  checkIntegrationScopeSource,
  isIntegrationTestFile,
} from '../src/check-integration-scope.ts';
import { findRepoRoot } from '../src/lib/repo.ts';

const HEAD = `import { devStackOrSkip } from '../../src/harness/index.ts';
const stack = await devStackOrSkip();
`;
const check = (body: string) =>
  checkIntegrationScopeSource('x/test/integration/a.int.ts', HEAD + body);

describe('check-integration-scope', () => {
  it('flags the original stack.int.ts pattern (client built in the describe body)', () => {
    const findings = check(`describe.skipIf(stack === undefined)('smoke', () => {
  const s = stack!;
  const client = new pg.Client({ ...s.postgres });
  it('works', async () => { await client.connect(); });
});
`);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'integration/stack-at-collection',
        path: 'x/test/integration/a.int.ts:4',
      }),
    ]);
  });

  it.each([
    ['it.each over stack data', `describe('a', () => { it.each(stack!.cases)('%s', () => {}); });`],
    [
      'a nested describe body',
      `describe('a', () => { describe('b', () => { const addr = stack!.openbao.addr; }); });`,
    ],
    ['a describe.each table', `describe.each([stack!.postgres])('a', () => {});`],
  ])('flags %s', (_name, body) => {
    expect(check(body)).toHaveLength(1);
  });

  it.each([
    [
      'hooks and tests',
      `describe.skipIf(stack === undefined)('a', () => {
  let client: Client;
  beforeAll(async () => { client = new Client(stack!.postgres); });
  it('b', () => { expect(stack!.openbao.addr).toBeDefined(); });
});`,
    ],
    [
      'a helper closure called from tests',
      `describe.skipIf(stack === undefined)('a', () => {
  const as = (role: string) => roleBao(stack!, role);
  it('b', async () => { await as('x'); });
});`,
    ],
    ['a type position', `describe('a', () => { let s: typeof stack; });`],
    ['a member named like the binding', `describe('a', () => { const n = other.stack; });`],
  ])('allows %s', (_name, body) => {
    expect(check(body)).toEqual([]);
  });

  it('ignores files without a devStackOrSkip binding and files outside test/integration', () => {
    expect(
      checkIntegrationScopeSource(
        'x/test/integration/w.int.ts',
        `const stack = {}; describe('a', () => { stack; });`,
      ),
    ).toEqual([]);
    expect(isIntegrationTestFile('tooling/dev-stack/test/integration/stack.int.ts')).toBe(true);
    expect(isIntegrationTestFile('tooling/dev-stack/test/env.test.ts')).toBe(false);
    expect(isIntegrationTestFile('tooling/dev-stack/src/integration/x.int.ts')).toBe(false);
  });

  it('skips a listed file that no longer exists (deleted but not yet staged)', () => {
    expect(
      checkIntegrationScope({ root: findRepoRoot(), files: ['x/test/integration/gone.int.ts'] }),
    ).toEqual([]);
  });

  it('the real repository is clean', () => {
    expect(checkIntegrationScope({ root: findRepoRoot() })).toEqual([]);
  });
});
