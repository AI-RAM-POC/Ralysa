// @ralysa/dev-stack: local dev and test stack for F-002 (design §2, §8.2, §8.3). kind "tooling",
// shipped: false. Nothing shipped may depend on it or on oidc-provider (SEC-F002-13, [AR-12]):
// check-workspaces enforces it over the workspace graph (F-002-T01), and T14 extends the check
// to the lockfile's production closure and the image scan.
export const PACKAGE_NAME = '@ralysa/dev-stack';
