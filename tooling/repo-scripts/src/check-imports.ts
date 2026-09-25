// check-imports (F-001 design §6.1; TC-F-001-26, -29): runs dependency-cruiser with the root
// .dependency-cruiser.cjs over source, tests, scripts, configs and packs/** (RC-3). It is the
// import-boundary layer that sees require() and import() with a literal, and it reaches packs/,
// which ESLint doesn't.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import type { Finding } from './lib/repo.ts';

/** Folders dependency-cruiser scans, relative to the repo root. */
export const SCAN_ROOTS = ['apps', 'packages', 'services', 'tooling', 'packs'] as const;

export interface CheckImportsOptions {
  root: string;
  /** The dependency-cruiser config; defaults to `<root>/.dependency-cruiser.cjs`. */
  configFile?: string;
}

export async function checkImports(options: CheckImportsOptions): Promise<Finding[]> {
  // The resolver returns real paths. If the root is reached through a symlink (macOS /var is
  // /private/var), every resolved path would sit outside baseDir and no path rule would match.
  const root = realpathSync(options.root);
  const configFile = options.configFile ?? join(root, '.dependency-cruiser.cjs');
  if (!existsSync(configFile)) {
    return [{ rule: 'imports/config', path: configFile, message: 'config file not found' }];
  }
  const cruiseOptions = await extractDepcruiseOptions(configFile);
  const roots = SCAN_ROOTS.filter((dir) => existsSync(join(root, dir)));
  const { output } = await cruise(roots, { ...cruiseOptions, baseDir: root });
  if (typeof output === 'string') {
    return [{ rule: 'imports/output', path: configFile, message: 'unexpected string output' }];
  }
  return findingsFrom(output);
}

function findingsFrom(result: ICruiseResult): Finding[] {
  // Sanity check: if a config change (an `exclude` or `includeOnly` that matches node_modules,
  // say) drops every package target from the graph, the banned-package rules can't fire, and
  // "0 violations" would mean nothing.
  const dependencies = result.modules.flatMap((module) => module.dependencies);
  const packageTargets = dependencies.filter(
    (dependency) => !dependency.coreModule && !dependency.module.startsWith('.'),
  );
  if (dependencies.length > 0 && packageTargets.length === 0) {
    return [
      {
        rule: 'imports/graph-sanity',
        path: '.dependency-cruiser.cjs',
        message: `${String(dependencies.length)} dependencies cruised but none on a package; the options drop package targets, so the banned-package rules can't fire`,
      },
    ];
  }
  return result.summary.violations
    .filter((violation) => violation.rule.severity === 'error')
    .map((violation) => ({
      rule: `imports/${violation.rule.name}`,
      path: violation.from,
      message: `imports ${violation.to}${ruleComment(result, violation.rule.name)}`,
    }));
}

function ruleComment(result: ICruiseResult, name: string): string {
  const rule = result.summary.ruleSetUsed?.forbidden?.find((r) => r.name === name);
  return rule?.comment ? `: ${rule.comment}` : '';
}
