// Phase 0 policy version (F-002 design §6.1 [AR-4]): the configured groups are the whole policy,
// so decisions carry "p0-static:" + the first 12 hex of SHA-256(JCS(access config)). Stamped on
// auth.sign_in, auth.refresh denials and audit.query. F-006 replaces it with the PDP's version.
import { createHash } from 'node:crypto';
import { jcs } from '@ralysa/protocol/audit';
import type { ServeConfig } from '../config/schema.js';

export function policyVersion(access: ServeConfig['access']): string {
  const plain = JSON.parse(JSON.stringify(access)) as unknown; // drops undefined (not I-JSON)
  return `p0-static:${createHash('sha256').update(jcs(plain)).digest('hex').slice(0, 12)}`;
}
