// Helpers for the migration files (F-002 design §4.2–§4.5). Migrations are static DDL: no value
// in them comes from input, so `sql.raw` over literal statements is the parameterised-SQL rule's
// documented exception. One statement per call, because node-postgres sends a parameter array
// with every Kysely query and the extended protocol refuses multi-statement strings.
import { type Kysely, sql } from 'kysely';

export async function exec(db: Kysely<unknown>, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
}

/**
 * ENABLE + FORCE row-level security and one policy per operation scoped to `currentOrg()`
 * (ADR-0003, §4.1). FORCE applies the policies to the table owner too.
 */
export function orgIsolation(table: string, currentOrg: string): string[] {
  const name = table.split('.').at(-1) ?? table;
  const scoped = `org_id = ${currentOrg}()`;
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${name}_org_select ON ${table} FOR SELECT USING (${scoped})`,
    `CREATE POLICY ${name}_org_insert ON ${table} FOR INSERT WITH CHECK (${scoped})`,
    `CREATE POLICY ${name}_org_update ON ${table} FOR UPDATE USING (${scoped}) WITH CHECK (${scoped})`,
    `CREATE POLICY ${name}_org_delete ON ${table} FOR DELETE USING (${scoped})`,
  ];
}

/** `current_setting('app.org_id')` errors when unset and the cast errors on '': fail closed. */
export function currentOrgFunction(schema: string): string {
  return `CREATE FUNCTION ${schema}.current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT current_setting('app.org_id')::uuid $$`;
}
