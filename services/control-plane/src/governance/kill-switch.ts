// Kill-switch state, read-only (F-002 design §2.1, §3.4.5; ADR-0025; [AR-14], TM-48). F-012 owns
// the kill-switch API and writes cp.kill_switch; F-002 only reads it: the governance feed carries
// it to every PEP, and the client-attested path refuses a local-tool intent while an active
// switch covers the tenant, the user's department (when set), or the pack or agent the host
// declares in `details.client.pack_id` / `agent_id` (honest-client semantics, like the rest of
// that path).
import type { KillSwitchScope } from '@ralysa/protocol/control-plane';
import { type Transaction, sql } from 'kysely';
import type { Database } from '../db/types.js';

export interface ActiveKillSwitch {
  scope: KillSwitchScope;
  scopeId: string | null;
}

/** What an intent is checked against: the org and user from the token, the host's claims. */
export interface KillSwitchSubject {
  orgId: string;
  departmentId: string | null;
  packId?: string;
  agentId?: string;
}

/** The active switches of the org (run inside withOrg). */
export async function readActiveKillSwitches(
  trx: Transaction<Database>,
): Promise<ActiveKillSwitch[]> {
  const rows = await trx
    .selectFrom('cp.kill_switch')
    .select(['scope', 'scope_id'])
    .where('active', '=', true)
    .execute();
  return rows.map((row) => ({ scope: row.scope, scopeId: row.scope_id }));
}

/** The governance epoch (cp.governance_epoch_seq; never decreases), as the feed reports it. */
export async function readGovernanceEpoch(trx: Transaction<Database>): Promise<number> {
  const { rows } = await sql<{ epoch: string; called: boolean }>`
    select last_value as epoch, is_called as called from cp.governance_epoch_seq`.execute(trx);
  return rows[0]?.called === true ? Number(rows[0].epoch) : 0;
}

/** The first active switch that covers the subject, or undefined. */
export function coveringKillSwitch(
  switches: readonly ActiveKillSwitch[],
  subject: KillSwitchSubject,
): ActiveKillSwitch | undefined {
  return switches.find((s) => {
    switch (s.scope) {
      case 'tenant':
        return s.scopeId === null || s.scopeId === subject.orgId;
      case 'department':
        return subject.departmentId !== null && s.scopeId === subject.departmentId;
      case 'pack':
        return subject.packId !== undefined && s.scopeId === subject.packId;
      case 'agent':
        return subject.agentId !== undefined && s.scopeId === subject.agentId;
    }
  });
}
