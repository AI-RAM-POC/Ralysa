// @ralysa/control-plane: Node service. Unit tests under `test` stay hermetic; tests that need Postgres,
// Redis or another service go in a `test:integration` script (docs/engineering/repo-conventions.md).
export interface ServiceInfo {
  name: string;
}

export function serviceInfo(): ServiceInfo {
  return { name: '@ralysa/control-plane' };
}
