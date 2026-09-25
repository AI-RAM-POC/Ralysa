// `isomorphic` is for libraries that must load in browsers and in Node (packages/protocol, auth,
// sdk): Node built-in modules are banned here, and DOM globals are type errors because
// lib-isomorphic.json has no DOM lib (F-001 design §2.1).
import { builtinModules } from 'node:module';
import { ALL_FILES, boundaryRules } from './base.js';

const MESSAGE =
  'Isomorphic packages must load in browsers and Node: no Node built-in modules. Move Node-only code to a service or a lib-node package.';

/**
 * @param {{ files?: string[] }} [options]
 * @returns {import('eslint').Linter.Config[]}
 */
export function isomorphic({ files = ALL_FILES } = {}) {
  const builtins = builtinModules.filter(
    (name) => !name.startsWith('_') && !name.startsWith('node:'),
  );
  return [
    {
      name: 'ralysa/isomorphic',
      files,
      rules: boundaryRules({
        paths: builtins.map((name) => ({ name, message: MESSAGE })),
        patterns: [{ group: ['node:*', ...builtins.map((name) => `${name}/*`)], message: MESSAGE }],
      }),
    },
  ];
}
