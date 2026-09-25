// check-ui-lint (F-001 design §7.3.1; AC-3, AC-4, AC-5; code review 3): every UI workspace
// (`ralysa.ui: true`, not a placeholder) runs BOTH layers of the UI lint:
//   - ESLint with the react-ui preset (logical classes, raw colours, literal strings), and
//   - Stylelint with @ralysa/stylelint-config (logical CSS, raw colours in CSS).
// A UI workspace that forgot either would pass lint while its CSS or JSX went unchecked.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, isRecord, listWorkspaceDirs, readJson } from './lib/core.ts';

const STYLELINT_CONFIGS = ['stylelint.config.js', 'stylelint.config.mjs', 'stylelint.config.cjs'];
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts'];

function firstExisting(dir: string, names: string[]): string | undefined {
  return names.find((name) => existsSync(join(dir, name)));
}

export function checkUiLint({ root }: { root: string }): Finding[] {
  const findings: Finding[] = [];
  for (const dir of listWorkspaceDirs(root)) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    if (!isRecord(pkg) || !isRecord(pkg.ralysa) || pkg.ralysa.ui !== true) continue;
    if (pkg.ralysa.kind === 'placeholder') continue;

    const lint =
      isRecord(pkg.scripts) && typeof pkg.scripts.lint === 'string' ? pkg.scripts.lint : '';
    if (!/(?:^|&&|;)\s*eslint\b/.test(lint)) {
      findings.push({
        rule: 'ui-lint/eslint-not-wired',
        path: `${dir}/package.json`,
        message: 'the lint script of a UI workspace must run eslint',
      });
    }
    if (!/(?:^|&&|;)\s*stylelint\b/.test(lint)) {
      findings.push({
        rule: 'ui-lint/stylelint-not-wired',
        path: `${dir}/package.json`,
        message:
          'the lint script of a UI workspace must run `stylelint "**/*.css" --allow-empty-input`',
      });
    }

    const stylelintConfig = firstExisting(join(root, dir), STYLELINT_CONFIGS);
    if (
      stylelintConfig === undefined ||
      !readFileSync(join(root, dir, stylelintConfig), 'utf8').includes('@ralysa/stylelint-config')
    ) {
      findings.push({
        rule: 'ui-lint/stylelint-config',
        path: `${dir}/${stylelintConfig ?? 'stylelint.config.js'}`,
        message: 'a UI workspace needs a stylelint.config.js that uses @ralysa/stylelint-config',
      });
    }

    const eslintConfig = firstExisting(join(root, dir), ESLINT_CONFIGS);
    const eslintSource =
      eslintConfig === undefined ? '' : readFileSync(join(root, dir, eslintConfig), 'utf8');
    if (!/\breactUi\s*\(/.test(eslintSource)) {
      findings.push({
        rule: 'ui-lint/react-ui-preset',
        path: `${dir}/${eslintConfig ?? 'eslint.config.js'}`,
        message: 'a UI workspace eslint.config.js must include the react-ui preset (reactUi())',
      });
    }
  }
  return findings;
}
