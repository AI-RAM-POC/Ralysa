// Kysely over a role's pool, and withOrg() — the only way application code reaches org data
// (F-002 design §4.1; ADR-0003; SEC-F002-31). withOrg opens a transaction and sets app.org_id
// transaction-locally, so nothing leaks to the next user of the pooled connection; outside it,
// cp.current_org() / audit.current_org() error and every RLS-scoped query fails closed.
//
// Where orgId comes from [SEC-F002-31]: the verified token's `tid`, or config.org.id on
// unauthenticated routes and grants. Never a header, host, path or body.
import { Kysely, PostgresDialect, type Transaction, sql } from 'kysely';
import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertOrgId(orgId: string): void {
  if (!UUID.test(orgId)) throw new Error('withOrg: orgId must be a lowercase UUID');
}

export function createDb<DB>(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export async function withOrg<DB, R>(
  db: Kysely<DB>,
  orgId: string,
  fn: (trx: Transaction<DB>) => Promise<R>,
): Promise<R> {
  assertOrgId(orgId);
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.org_id', ${orgId}, true)`.execute(trx);
    return fn(trx);
  });
}
