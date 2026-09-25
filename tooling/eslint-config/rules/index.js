// @ralysa/eslint-plugin: the repo's local rules, registered under the `ralysa/` prefix by the
// react-ui preset (F-001 design §2, §7.3).
import { noLiteralAttributeText } from './no-literal-attribute-text.js';
import { noPhysicalInlineStyle } from './no-physical-inline-style.js';
import { noRawColor } from './no-raw-color.js';
import { noUnpairedDirectionVariant } from './no-unpaired-direction-variant.js';

/** @type {import('eslint').ESLint.Plugin} */
export const ralysaPlugin = {
  meta: { name: '@ralysa/eslint-plugin', version: '0.0.0' },
  rules: {
    'no-literal-attribute-text': noLiteralAttributeText,
    'no-physical-inline-style': noPhysicalInlineStyle,
    'no-raw-color': noRawColor,
    'no-unpaired-direction-variant': noUnpairedDirectionVariant,
  },
};
