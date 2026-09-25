// Import-boundary rules, layer 2 (F-001 design §6.1; ADR-0012, SR-03, ADR-0024, AC-13, RF-7).
// Unlike ESLint's no-restricted-imports, dependency-cruiser also sees require() and import()
// with a literal, and it scans packs/** (no longer a workspace, so ESLint doesn't reach it).
// The package lists come from tooling/eslint-config/boundaries.js, the one shared source.
// Run through `ralysa-repo check-imports` (part of `pnpm repo:check`).
'use strict';

const {
  BANNED_PACKAGE_GROUPS,
  DEV_ONLY_IMPORT_ALLOWED_IN,
  DEV_ONLY_MESSAGE,
  DEV_ONLY_PACKAGES,
  globSource,
  groupNameSource,
} = require('./tooling/eslint-config/boundaries.js');

/** Matches a module path that is the package itself: unresolved (`openai`) or in node_modules. */
const packagePath = (nameSource) => `(?:^|/node_modules/)${nameSource}(?:/|$)`;

/** Repo-relative globs as one anchored regex source. */
const pathsSource = (globs) => `^(?:${globs.map(globSource).join('|')})$`;

const bannedPackageRules = BANNED_PACKAGE_GROUPS.map((group) => ({
  name: `banned-${group.id}`,
  comment: group.message,
  severity: 'error',
  from: group.importAllowedIn.length > 0 ? { pathNot: pathsSource(group.importAllowedIn) } : {},
  to: { path: packagePath(groupNameSource(group)) },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...bannedPackageRules,
    {
      name: 'no-ui-lab',
      comment: 'Nothing imports the internal demo app apps/ui-lab or @ralysa/ui-lab (AC-13).',
      severity: 'error',
      from: { pathNot: '^apps/ui-lab/' },
      to: { path: `^apps/ui-lab/|${packagePath('@ralysa/ui-lab')}` },
    },
    {
      // F-002-T14, SEC-F002-13 (a): the mock IdP never reaches shipped code, whether by package
      // name or by a relative path into tooling/dev-stack.
      name: 'no-dev-only-in-shipped',
      comment: DEV_ONLY_MESSAGE,
      severity: 'error',
      from: { pathNot: pathsSource(DEV_ONLY_IMPORT_ALLOWED_IN) },
      to: {
        path: `^tooling/dev-stack/|${packagePath(`(?:${DEV_ONLY_PACKAGES.map(globSource).join('|')})`)}`,
      },
    },
    {
      name: 'no-packs',
      comment: 'Department packs are content, never part of the build graph (RF-7, TM-41).',
      severity: 'error',
      from: { pathNot: '^packs/' },
      to: { path: '^packs/' },
    },
    {
      name: 'packages-not-to-apps-or-services',
      comment: 'packages/* are shared libraries: they must not import apps or services.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^(?:apps|services)/' },
    },
    {
      name: 'apps-not-to-other-apps',
      comment: 'Apps do not import other apps; shared code goes in packages/*.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'apps-not-to-services',
      comment:
        'Apps talk to services over their contracts, never by importing their modules (AR-9).',
      severity: 'error',
      from: { path: '^apps/' },
      to: { path: '^services/' },
    },
    {
      name: 'services-not-to-other-services',
      comment: 'Services talk only over their contracts; shared code goes in packages/* (AR-9).',
      severity: 'error',
      from: { path: '^services/([^/]+)/' },
      to: { path: '^services/', pathNot: '^services/$1/' },
    },
  ],
  options: {
    // Only `exclude` narrows the scan, and only to build output inside our own folders.
    // `includeOnly`, or an unanchored `node_modules`/`dist` exclude, would also drop the
    // node_modules and unresolved targets (`vite/dist/...`), and with them every banned-package
    // match. check-imports asserts that package targets are still in the graph.
    exclude: {
      path: '^(?:apps|packages|services|tooling|packs)/[^/]+/(?:dist|coverage|\\.turbo|\\.tsc)/',
    },
    doNotFollow: { path: '(?:^|/)node_modules/' },
    moduleSystems: ['es6', 'cjs', 'tsd'],
    // Type-only imports count too: `import type` from a banned SDK is still a dependency on it.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'] },
    },
  },
};
