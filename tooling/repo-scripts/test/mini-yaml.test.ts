// The gate's strict YAML reader: everything it accepts it must read exactly as the `yaml`
// package does, and everything outside its subset must be rejected (fail closed).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MiniYamlError, parseMiniYaml } from '../src/lib/mini-yaml.ts';
import { REAL_ROOT } from './repo-copy.ts';

describe('mini-yaml: accepted documents match the yaml package', () => {
  it.each([
    ['the real pnpm-workspace.yaml', readFileSync(join(REAL_ROOT, 'pnpm-workspace.yaml'), 'utf8')],
    ['empty', ''],
    ['comments only', '# nothing\n\n  # still nothing\n'],
    [
      'scalars',
      "a: 1\nb: true\nc: false\nd: null\ne: ~\nf: 4.6.5\ng: ^19.3.0\nh: '>=1 <2'\ni: \"x y\"\nj: 'it''s'\n",
    ],
    ['empty collections', 'allowBuilds: {}\nlist: []\n'],
    [
      'nested maps',
      'catalog:\n  zod: 4.6.5\n  "@types/node": 24.13.6\ncatalogs:\n  legacy:\n    react: 18.3.1\n',
    ],
    ['sequences, indented and not', 'a:\n  - "x/*"\n  - y\nb:\n- one\n- two # comment\n'],
    ['trailing comments', 'minimumReleaseAge: 4320 # 3 days\nkey: "v" # c\n'],
    ['a null value', 'pnpmfile:\nother: 1\n'],
    ['CRLF line endings', 'a: 1\r\nb:\r\n  c: d\r\n'],
  ])('%s', (_name, source) => {
    expect(parseMiniYaml(source)).toEqual(parse(source) ?? {});
  });
});

describe('mini-yaml: everything outside the subset is rejected', () => {
  it.each([
    ['anchor and alias', 'a: &x 1\nb: *x\n'],
    ['alias as a value', 'base:\n  k: v\nconfigDependencies: *base\n'],
    ['merge key', 'b:\n  <<: {}\n'],
    ['tag', 'a: !!str 1\n'],
    ['explicit key', '? configDependencies\n: {}\n'],
    ['flow mapping', 'configDependencies: { pnpm-plugin-x: "1.0.0" }\n'],
    ['flow sequence', 'packages: ["a/*"]\n'],
    ['block scalar', 'a: |\n  text\n'],
    ['escape in a double-quoted key', '"config\\x44ependencies":\n  x: 1\n'],
    ['document marker', '---\na: 1\n'],
    ['second document', 'a: 1\n---\nb: 2\n'],
    ['directive', '%YAML 1.2\na: 1\n'],
    ['tab indentation', 'a:\n\tb: 1\n'],
    ['duplicate top-level key', 'a: 1\na: 2\n'],
    ['duplicate nested key', 'a:\n  b: 1\n  b: 2\n'],
    ['multi-line plain scalar', 'a: one\n  two\n'],
    ['map inside a sequence', 'a:\n  - b: 1\n'],
    ['nested sequence', 'a:\n  - - 1\n'],
    ['root sequence', '- a\n'],
    ['indented root', '  a: 1\n'],
    ['capitalised boolean', 'enablePrePostScripts: True\n'],
    ['yes/no', 'enablePrePostScripts: yes\n'],
    ['float', 'a: 1.5\n'],
    ['hex', 'a: 0x1F\n'],
    ['octal-looking', 'a: 010\n'],
    ['infinity', 'a: .inf\n'],
    ['ambiguous plain scalar', 'a: b: c\n'],
    ['unterminated quote', 'a: "x\n'],
    ['text after a quoted value', 'a: "x" y\n'],
  ])('%s', (_name, source) => {
    expect(() => parseMiniYaml(source)).toThrow(MiniYamlError);
  });
});
