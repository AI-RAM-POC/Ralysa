// @ralysa/eslint-plugin: the repo's local rules, registered under the `ralysa/` prefix by the
// react-ui preset (F-001 design §2, §7.3) and by services that use them (no-session-db-settings,
// F-002 SEC-F002-31, enabled in services/control-plane).
import { noLiteralAttributeText } from './no-literal-attribute-text.js';
import { noPhysicalInlineStyle } from './no-physical-inline-style.js';
import { noRawColor } from './no-raw-color.js';
import { noSessionDbSettings } from './no-session-db-settings.js';
import { noUnpairedDirectionVariant } from './no-unpaired-direction-variant.js';

/** @type {import('eslint').ESLint.Plugin} */
export const ralysaPlugin = {
  meta: { name: '@ralysa/eslint-plugin', version: '0.0.0' },
  rules: {
    'no-literal-attribute-text': noLiteralAttributeText,
    'no-physical-inline-style': noPhysicalInlineStyle,
    'no-raw-color': noRawColor,
    'no-session-db-settings': noSessionDbSettings,
    'no-unpaired-direction-variant': noUnpairedDirectionVariant,
  },
};
