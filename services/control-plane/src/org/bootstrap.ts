// The one Organization (ADR-0003; F-002 design §3.8, §4.4). `serve` ensures it at start and
// `control-plane bootstrap-org` does it on its own: the row is created from config if missing.
// If it exists, its region must match (region is immutable: residency), as must residency and
// deployment model. The name follows config. In Phase 0 config is authoritative for
// `auth.device_code_enabled`, which is copied into settings (D-30); revoking live flow-A sessions
// when it turns off is T10's device-code switch.
import { type Kysely, sql } from 'kysely';
import type { ServeConfig } from '../config/schema.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';

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
