// check-migrations-immutable (F-002 design §4.2, [AR-10]): a migration that has shipped to
// customer-operated installs must never change, because each install has already applied it.
//
// services/control-plane/migrations.lock.json records the SHA-256 of every migration file. The
// check fails when:
//   - a migration file is missing from the lock, or its hash differs (run
//     `pnpm migrations:lock` for a NEW migration);
//   - a lock entry has no file;
//   - an entry in the base branch's lock (origin/main, or RALYSA_MIGRATIONS_BASE) was changed or
//     removed: rewriting the lock can't launder a change to a released migration.
// Without the base ref, the base comparison is skipped locally and is a finding in CI (the
// repo-checks job fetches main first).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './lib/repo.ts';

export const MIGRATIONS_ROOT = 'services/control-plane/src/db/migrations';
export const MIGRATION_SETS = ['audit', 'cp'] as const;
export const LOCK_FILE = 'services/control-plane/migrations.lock.json';
/** The lock's hashes compiled into the service, for db.migration.applied (dist has no lock). */
export const CHECKSUMS_MODULE = 'services/control-plane/src/db/migration-checksums.generated.ts';
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.ts$/;

/**
 * Each entry is an object, not a bare hash, so the lock never reads like `<name with a keyword>:
 * <high-entropy value>` to the secret scanner (gitleaks' generic-api-key rule flagged
 * `…_tokens.ts": "<sha256>"`).
 */
export interface MigrationsLock {
  version: 2;
  migrations: Record<string, { sha256: string }>;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * `<set>/<file>` → SHA-256 of every migration file on disk, plus the shared helper modules at
 * the migrations root (e.g. `ddl.ts`): released migrations import them, so changing a helper
 * would change what a released migration does. New helpers go in a new file.
 */
export function currentMigrationHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const shared = join(root, MIGRATIONS_ROOT);
  if (existsSync(shared)) {
    for (const file of readdirSync(shared).sort()) {
      if (/^[a-z0-9_-]+\.ts$/.test(file)) out[file] = sha256File(join(shared, file));
    }
  }
  for (const set of MIGRATION_SETS) {
    const dir = join(root, MIGRATIONS_ROOT, set);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (MIGRATION_FILE.test(file)) out[`${set}/${file}`] = sha256File(join(dir, file));
    }
  }
  return out;
}

function parseLock(text: string): MigrationsLock | undefined {
  try {
    const value = JSON.parse(text) as Partial<MigrationsLock>;
    if (value.version !== 2 || typeof value.migrations !== 'object') return undefined;
    const valid = Object.values(value.migrations as Record<string, unknown>).every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        /^[0-9a-f]{64}$/.test(String((entry as { sha256?: unknown }).sha256)),
    );
    return valid ? (value as MigrationsLock) : undefined;
  } catch {
    return undefined;
  }
}

const hashOf = (lock: MigrationsLock, name: string): string | undefined =>
  lock.migrations[name]?.sha256;

export interface BaseLock {
  /** undefined: the base ref isn't available; null: the base has no lock file yet. */
  lock: MigrationsLock | null | undefined;
  ref: string;
}

export function readBaseLock(root: string, ref: string): BaseLock {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return { lock: undefined, ref };
  }
  try {
    return { lock: parseLock(git(['show', `${ref}:${LOCK_FILE}`])) ?? null, ref };
  } catch {
    return { lock: null, ref };
  }
}

export interface CheckMigrationsOptions {
  root: string;
  base?: BaseLock;
  ci?: boolean;
}

export function checkMigrationsImmutable(options: CheckMigrationsOptions): Finding[] {
  const { root } = options;
  const findings: Finding[] = [];
  const current = currentMigrationHashes(root);
  const lockPath = join(root, LOCK_FILE);
  if (Object.keys(current).length === 0 && !existsSync(lockPath)) return [];
  const lock = existsSync(lockPath) ? parseLock(readFileSync(lockPath, 'utf8')) : undefined;
  if (lock === undefined) {
    return [
      {
        rule: 'migrations/lock-invalid',
        path: LOCK_FILE,
        message:
          'missing or not {"version": 2, "migrations": {<file>: {"sha256": …}}}; run pnpm migrations:lock',
      },
    ];
  }
  for (const [name, hash] of Object.entries(current)) {
    const locked = hashOf(lock, name);
    if (locked === undefined) {
      findings.push({
        rule: 'migrations/unlocked',
        path: `${MIGRATIONS_ROOT}/${name}`,
        message: 'a new migration must be recorded in migrations.lock.json (pnpm migrations:lock)',
      });
    } else if (locked !== hash) {
      findings.push({
        rule: 'migrations/changed',
        path: `${MIGRATIONS_ROOT}/${name}`,
        message:
          'differs from its recorded hash: released migrations are immutable; add a new migration instead [AR-10]',
      });
    }
  }
  for (const name of Object.keys(lock.migrations)) {
    if (current[name] === undefined) {
      findings.push({
        rule: 'migrations/missing-file',
        path: `${MIGRATIONS_ROOT}/${name}`,
        message: 'recorded in migrations.lock.json but the file is gone',
      });
    }
  }
  const moduleText = existsSync(join(root, CHECKSUMS_MODULE))
    ? readFileSync(join(root, CHECKSUMS_MODULE), 'utf8')
    : undefined;
  if (Object.keys(lock.migrations).length > 0 && moduleText !== renderChecksumsModule(lock)) {
    findings.push({
      rule: 'migrations/checksums-module-stale',
      path: CHECKSUMS_MODULE,
      message: 'does not match migrations.lock.json; run pnpm migrations:lock',
    });
  }
  const base =
    options.base ?? readBaseLock(root, process.env.RALYSA_MIGRATIONS_BASE ?? 'origin/main');
  if (base.lock === undefined) {
    if (options.ci === true) {
      findings.push({
        rule: 'migrations/no-base',
        path: LOCK_FILE,
        message: `base ref ${base.ref} is not available, so released migrations can't be compared (fetch it first)`,
      });
    }
  } else if (base.lock !== null) {
    for (const name of Object.keys(base.lock.migrations)) {
      if (hashOf(lock, name) !== hashOf(base.lock, name)) {
        findings.push({
          rule: 'migrations/released-changed',
          path: `${MIGRATIONS_ROOT}/${name}`,
          message: `released on ${base.ref} and ${hashOf(lock, name) === undefined ? 'removed from' : 'changed in'} the lock: released migrations are immutable [AR-10]`,
        });
      }
    }
  }
  return findings;
}

/** Records every migration file's hash (new migrations only; a check still guards the base). */
export function renderChecksumsModule(lock: MigrationsLock): string {
  const entries = Object.entries(lock.migrations)
    .map(([name, entry]) => `  '${name}': {\n    sha256: '${entry.sha256}',\n  },`)
    .join('\n');
  return `// GENERATED by \`pnpm migrations:lock\` from migrations.lock.json. Do not edit.
// check-migrations-immutable fails when this file and the lock disagree.
// Nested like the lock, so no line reads as \`<name>: <high-entropy value>\` to the secret scanner.
export const MIGRATION_CHECKSUMS: Readonly<Record<string, { sha256: string }>> = {
${entries}
};
`;
}

export function writeMigrationsLock(root: string): MigrationsLock {
  const lock: MigrationsLock = {
    version: 2,
    migrations: Object.fromEntries(
      Object.entries(currentMigrationHashes(root)).map(([name, sha256]) => [name, { sha256 }]),
    ),
  };
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  if (existsSync(join(root, CHECKSUMS_MODULE, '..'))) {
    writeFileSync(join(root, CHECKSUMS_MODULE), renderChecksumsModule(lock));
  }
  return lock;
}
