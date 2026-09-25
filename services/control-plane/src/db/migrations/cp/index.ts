// The cp migration set, imported statically (no dynamic loading, SEC-F001-09 b). Append only:
// released entries are frozen by migrations.lock.json [AR-10].
import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_schemas_and_rls_helpers.js';
import * as m0002 from './0002_cp_identity.js';
import * as m0003 from './0003_cp_sessions_and_tokens.js';
import * as m0004 from './0004_usage_credential_governance.js';
import * as m0005 from './0005_governance_epoch.js';

export const CP_MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_schemas_and_rls_helpers': m0001,
  '0002_cp_identity': m0002,
  '0003_cp_sessions_and_tokens': m0003,
  '0004_usage_credential_governance': m0004,
  '0005_governance_epoch': m0005,
};
