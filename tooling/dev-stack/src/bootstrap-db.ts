// Postgres bootstrap for the dev stack (F-002 design §4.1, §8.2; SEC-F002-29): checks the UTF-8
// server encoding and SCRAM, creates the login roles, and sets each role's password from OpenBao
// KV. The script reaches psql over **stdin** (`docker compose exec -T postgres psql`), never on a
// command line, and carries SCRAM verifiers computed here, never the passwords themselves.
//
// Scope in F-002-T02: login roles and passwords only. Ownership, grants, memberships, the NOLOGIN
// `ralysa_audit_owner` and the DDL event trigger are bootstrap-roles.sql (F-002-T05), which will
// run through the same stdin channel with the same psql variables.
import { spawn } from 'node:child_process';
import { scramVerifier } from './scram.ts';
import { DB_ROLES } from './stack.ts';

/** A psql variable name for a role's verifier. */
export const passwordVariable = (role: string): string => `pw_${role}`;

/**
 * The psql script. Verifiers are set with `\set` (psql-side variables, interpolated as literals by
 * `:'name'`), so the SQL text itself never contains a credential.
 */
export function rolesScript(verifiers: Record<string, string>): string {
  const lines: string[] = ['\\set ON_ERROR_STOP on', '\\set QUIET on'];
  for (const { role } of DB_ROLES) {
    const verifier = verifiers[role];
    if (verifier === undefined || !verifier.startsWith('SCRAM-SHA-256$')) {
      throw new Error(`no SCRAM verifier for ${role}`);
    }
    if (/['\\\n]/.test(verifier)) throw new Error(`unexpected character in the ${role} verifier`);
    lines.push(`\\set ${passwordVariable(role)} '${verifier}'`);
  }
  const roleArray = DB_ROLES.map(({ role }) => `'${role}'`).join(', ');
  lines.push(
    // AC-15: the database must be UTF-8; stop before creating anything otherwise.
    `DO $$ BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'server_encoding is %, Ralysa needs UTF8 (AC-15)', current_setting('server_encoding');
  END IF;
END $$;`,
    // Login roles with no elevated attributes. No Ralysa role gets SUPERUSER, CREATEDB,
    // CREATEROLE, REPLICATION or BYPASSRLS (ADR-0003, §4.1).
    `SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r)
  FROM unnest(ARRAY[${roleArray}]) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \\gexec`,
  );
  for (const { role } of DB_ROLES) {
    lines.push(
      `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'${passwordVariable(role)}';`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function verifiersFor(passwords: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    DB_ROLES.map(({ role, key }) => {
      const password = passwords[key];
      if (password === undefined) throw new Error(`no password for db/${key}`);
      return [role, scramVerifier(password)];
    }),
  );
}

/** Runs psql in the postgres container with the script on stdin. */
export function runPsql(options: {
  composeFile: string;
  envFile: string;
  script: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose',
        '-f',
        options.composeFile,
        '--env-file',
        options.envFile,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-U',
        'postgres',
        '-d',
        'ralysa',
      ],
      { stdio: ['pipe', 'inherit', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql exited with ${String(code)}: ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.end(options.script);
  });
}
