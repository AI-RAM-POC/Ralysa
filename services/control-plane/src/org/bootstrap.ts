// The one Organization (ADR-0003; F-002 design §3.8, §4.4). `serve` ensures it at start and
// `control-plane bootstrap-org` does it on its own: the row is created from config if missing.
// If it exists, its region must match (region is immutable: residency), as must residency and
// deployment model. The name follows config. In Phase 0 config is authoritative for
// `auth.device_code_enabled`, which is copied into settings (D-30); revoking live flow-A sessions
// when it turns off is T10's device-code switch.
//
// `serve` then reconciles `cp.idp_group.role` with `access.access_group_id` and
// `access.admin_group_id` (reconcileGroupRoles; #47, SEC-F002-42): a group that is no longer
// configured loses its role at start, not at the next sign-in, and every change is audited as
// `directory.group_role.changed` (privileged when the admin role is involved, TM-49).
import { newTraceId } from '@ralysa/protocol/common';
import { type Kysely, sql } from 'kysely';
import { systemEvent } from '../audit/events.js';
import type { AuditWriter } from '../audit/writer.js';
import type { ServeConfig } from '../config/schema.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import { type GroupRoleChange, reconcileConfiguredGroups } from '../directory/membership.js';

export class OrganizationMismatchError extends Error {
  constructor(field: string) {
    super(`organization ${field} in the database differs from config; it can't be changed here`);
    this.name = 'OrganizationMismatchError';
  }
}

export async function ensureOrganization(
  db: Kysely<Database>,
  config: Pick<ServeConfig, 'org' | 'access'>,
): Promise<{ created: boolean; deviceCodeChanged: boolean }> {
  const { org } = config;
  return withOrg(db, org.id, async (trx) => {
    const existing = await trx
      .selectFrom('cp.organization')
      .selectAll()
      .where('id', '=', org.id)
      .forUpdate()
      .executeTakeFirst();
    const settingsPatch = { auth: { device_code_enabled: config.access.device_code_enabled } };
    if (existing === undefined) {
      await trx
        .insertInto('cp.organization')
        .values({
          id: org.id,
          name: org.name,
          residency: org.residency,
          region: org.region,
          deployment_model: org.deployment_model,
          settings: JSON.stringify(settingsPatch),
        })
        .execute();
      return { created: true, deviceCodeChanged: false };
    }
    if (existing.region !== org.region) throw new OrganizationMismatchError('region');
    if (existing.residency !== org.residency) throw new OrganizationMismatchError('residency');
    if (existing.deployment_model !== org.deployment_model) {
      throw new OrganizationMismatchError('deployment_model');
    }
    const previous = (existing.settings as { auth?: { device_code_enabled?: unknown } }).auth
      ?.device_code_enabled;
    await trx
      .updateTable('cp.organization')
      .set({
        name: org.name,
        settings: sql`settings || ${JSON.stringify(settingsPatch)}::jsonb`,
      })
      .where('id', '=', org.id)
      .execute();
    return {
      created: false,
      deviceCodeChanged: previous !== undefined && previous !== config.access.device_code_enabled,
    };
  });
}

/**
 * Sets every group's role from config (the only source of roles, §4.4) and audits each change,
 * one `directory.group_role.changed` per group, after the change commits. Like the device-code
 * switch at start, the events go through writeOrSpool: a failed audit write is spooled and
 * replayed, it doesn't undo a change that already took effect.
 */
export async function reconcileGroupRoles(
  db: Kysely<Database>,
  config: Pick<ServeConfig, 'org' | 'access'>,
  writer: Pick<AuditWriter, 'writeOrSpool'>,
): Promise<GroupRoleChange[]> {
  const orgId = config.org.id;
  const changes = await withOrg(db, orgId, (trx) =>
    reconcileConfiguredGroups(trx, orgId, {
      access: config.access.access_group_id,
      admin: config.access.admin_group_id,
    }),
  );
  if (changes.length > 0) {
    const traceId = newTraceId();
    await writer.writeOrSpool(
      orgId,
      changes.map((change) =>
        systemEvent({
          action: 'directory.group_role.changed',
          outcome: 'success',
          service: 'rts',
          traceId,
          details: {
            idp_group_id: change.idpGroupId,
            from: change.from,
            to: change.to,
            cause: 'config',
            // TM-49: granting or removing the admin role is privileged.
            privileged: change.from === 'platform_admin' || change.to === 'platform_admin',
          },
        }),
      ),
    );
  }
  return changes;
}
