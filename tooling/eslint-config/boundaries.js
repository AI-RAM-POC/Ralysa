// Shared boundary lists (F-001 design §6.1). ESLint, dependency-cruiser, check-banned-deps,
// check-provider-hosts and check-workspaces all import from this one file, so the rules can't
// drift apart. F-001-T02 creates the slots; F-001-T04 and T16 fill the lists.

/**
 * @typedef {{ name: string, message: string, importNames?: string[] }} RestrictedPath
 * @typedef {{ group: string[], message: string }} RestrictedPattern
 * @typedef {{ selector: string, message: string }} RestrictedSyntax
 * @typedef {{ workspace: string, dependency: string, specifier: string, reason: string }} SpecifierException
 */

/** Imports banned everywhere by `no-restricted-imports` (T04). @type {RestrictedPath[]} */
export const BANNED_IMPORT_PATHS = [];

/** Import patterns banned everywhere by `no-restricted-imports` (T04). @type {RestrictedPattern[]} */
export const BANNED_IMPORT_PATTERNS = [];

/** `no-restricted-syntax` selectors: the dynamic-loading ban (T04). @type {RestrictedSyntax[]} */
export const RESTRICTED_SYNTAX = [];

/**
 * Rule IDs that make up the boundary layer. They live in the `base` preset, no preset may
 * relax them, and `eslint-comments/no-restricted-disable` forbids disabling them inline (RC-3).
 */
export const BOUNDARY_RULE_IDS = ['no-restricted-imports', 'no-restricted-syntax'];

/**
 * Reviewed exceptions to the dependency-specifier rule in check-workspaces (`npm:`, `file:`,
 * `link:`, `portal:`, git and tarball specifiers). A specifier that resolves under `packs/` can
 * never be excepted (SEC-F001-09 a, SEC-F001-26). Starts empty.
 * @type {SpecifierException[]}
 */
export const SPECIFIER_ALLOWLIST = [];
