// @ralysa/eslint-plugin: the repo's local rules, registered under the `ralysa/` prefix by the
// react-ui preset (F-001 design §2, §7.3).
import { noPhysicalInlineStyle } from './no-physical-inline-style.js';
import { noRawColor } from './no-raw-color.js';

/** @type {import('eslint').ESLint.Plugin} */
export const ralysaPlugin = {
  meta: { name: '@ralysa/eslint-plugin', version: '0.0.0' },
  rules: {
    'no-physical-inline-style': noPhysicalInlineStyle,
    'no-raw-color': noRawColor,
  },
};
