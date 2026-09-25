// eslint-plugin-jsx-a11y 6.10.2 ships no types. Only the parts react-ui.js uses are declared.
declare module 'eslint-plugin-jsx-a11y' {
  import type { ESLint, Linter } from 'eslint';

  const plugin: ESLint.Plugin & {
    flatConfigs: Record<'recommended' | 'strict', Linter.Config & { rules: Linter.RulesRecord }>;
  };
  export default plugin;
}
