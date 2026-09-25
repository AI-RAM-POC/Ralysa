// The audit migration set, imported statically (SEC-F001-09 b). Append only [AR-10]. Run by
// `migrate --audit` as the audit owner; never rewrites audit_event rows (§4.2).
import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_audit_store.js';
import * as m0002 from './0002_custody_violation_fn.js';

export const AUDIT_MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_audit_store': m0001,
  '0002_custody_violation_fn': m0002,
};
