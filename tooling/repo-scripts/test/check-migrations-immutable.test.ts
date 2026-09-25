// check-migrations-immutable [AR-10]: new migrations must be locked, locked files can't change,
// and the base branch's entries can't be rewritten or dropped from the lock.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECKSUMS_MODULE,
  LOCK_FILE,
  MIGRATIONS_ROOT,
  type MigrationsLock,
  checkMigrationsImmutable,
  currentMigrationHashes,
  writeMigrationsLock,
} from '../src/check-migrations-immutable.ts';
import { findRepoRoot } from '../src/lib/repo.ts';
import { makeTempDir } from './temp.ts';

function fixture(files: Record<string, string>): string {
  const root = makeTempDir('ralysa-migrations-');
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, MIGRATIONS_ROOT, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  mkdirSync(join(root, 'services/control-plane/src/db'), { recursive: true });
  return root;
}
const noBase = { lock: null, ref: 'origin/main' } as const;
const rules = (
  root: string,
  base: Parameters<typeof checkMigrationsImmutable>[0]['base'] = noBase,
) => checkMigrationsImmutable({ root, base }).map((f) => `${f.rule} ${f.path}`);

describe('check-migrations-immutable', () => {
  const files = {
    'ddl.ts': 'export {};',
    'cp/0001_a.ts': 'up1',
    'cp/index.ts': 'index is not hashed',
    'audit/0001_b.ts': 'up2',
  };

  it('hashes migration files and the shared helpers, not the index', () => {
    expect(Object.keys(currentMigrationHashes(fixture(files))).sort()).toEqual([
      'audit/0001_b.ts',
      'cp/0001_a.ts',
      'ddl.ts',
    ]);
  });

  it('passes when the lock matches', () => {
    const root = fixture(files);
    writeMigrationsLock(root);
    expect(rules(root)).toEqual([]);
  });

  it('flags a new unlocked migration, a changed one, a changed helper and a missing file', () => {
    const root = fixture(files);
    writeMigrationsLock(root);
    writeFileSync(join(root, MIGRATIONS_ROOT, 'cp/0002_new.ts'), 'up3');
    writeFileSync(join(root, MIGRATIONS_ROOT, 'cp/0001_a.ts'), 'up1 edited');
    writeFileSync(join(root, MIGRATIONS_ROOT, 'ddl.ts'), 'export const x = 1;');
    const lock = writeMigrationsLock(fixture(files));
    lock.migrations['cp/0000_gone.ts'] = { sha256: 'f'.repeat(64) };
    writeFileSync(join(root, LOCK_FILE), JSON.stringify(lock));
    expect(rules(root).sort()).toEqual([
      `migrations/changed ${MIGRATIONS_ROOT}/cp/0001_a.ts`,
      `migrations/changed ${MIGRATIONS_ROOT}/ddl.ts`,
      `migrations/checksums-module-stale ${CHECKSUMS_MODULE}`,
      `migrations/missing-file ${MIGRATIONS_ROOT}/cp/0000_gone.ts`,
      `migrations/unlocked ${MIGRATIONS_ROOT}/cp/0002_new.ts`,
    ]);
  });

  it('a rewritten lock cannot launder a change to a migration released on the base', () => {
    const root = fixture(files);
    const released = writeMigrationsLock(root);
    writeFileSync(join(root, MIGRATIONS_ROOT, 'cp/0001_a.ts'), 'up1 edited');
    writeMigrationsLock(root); // the lock now matches the edited file
    expect(rules(root, { lock: released, ref: 'origin/main' })).toEqual([
      `migrations/released-changed ${MIGRATIONS_ROOT}/cp/0001_a.ts`,
    ]);
  });

  it('a base entry dropped from the lock is flagged; a local entry the base lacks is not', () => {
    const root = fixture(files);
    const released = writeMigrationsLock(root);
    const trimmed: MigrationsLock = { version: 2, migrations: { ...released.migrations } };
    delete trimmed.migrations['audit/0001_b.ts'];
    expect(
      checkMigrationsImmutable({ root, base: { lock: trimmed, ref: 'x' } }).map((f) => f.rule),
    ).toEqual([]);
    expect(
      rules(root, {
        lock: {
          version: 2,
          migrations: { ...released.migrations, 'cp/9999_z.ts': { sha256: 'a'.repeat(64) } },
        },
        ref: 'b',
      }),
    ).toEqual([`migrations/released-changed ${MIGRATIONS_ROOT}/cp/9999_z.ts`]);
  });

  it('a missing base is a finding in CI only', () => {
    const root = fixture(files);
    writeMigrationsLock(root);
    const base = { lock: undefined, ref: 'origin/main' };
    expect(checkMigrationsImmutable({ root, base })).toEqual([]);
    expect(checkMigrationsImmutable({ root, base, ci: true }).map((f) => f.rule)).toEqual([
      'migrations/no-base',
    ]);
  });

  it('the generated checksums module must match the lock (review of #21)', () => {
    const root = fixture(files);
    writeMigrationsLock(root);
    expect(rules(root)).toEqual([]);
    writeFileSync(join(root, CHECKSUMS_MODULE), 'export const MIGRATION_CHECKSUMS = {};\n');
    expect(rules(root)).toEqual([`migrations/checksums-module-stale ${CHECKSUMS_MODULE}`]);
  });

  it('an invalid lock file is one finding', () => {
    const root = fixture(files);
    writeFileSync(join(root, LOCK_FILE), '{"version": 1, "migrations": {}}');
    expect(rules(root)).toEqual([`migrations/lock-invalid ${LOCK_FILE}`]);
  });

  it('the real repository is clean against its own lock', () => {
    expect(checkMigrationsImmutable({ root: findRepoRoot(), base: noBase })).toEqual([]);
  });
});
