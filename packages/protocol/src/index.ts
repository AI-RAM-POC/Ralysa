// @ralysa/protocol: isomorphic contracts (loads in browsers and Node; no DOM, no Node built-ins).
// Import a contract family through its subpath (`@ralysa/protocol/audit`, …); the root re-exports
// each family as a namespace (F-002 design §3.10, [AR-18]).
export * as audit from './audit/index.js';
export * as auth from './auth/index.js';
export * as common from './common/index.js';
export * as controlPlane from './control-plane/index.js';

export const PACKAGE_NAME = '@ralysa/protocol';

export function packageName(): string {
  return PACKAGE_NAME;
}
