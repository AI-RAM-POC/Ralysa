// The SHA-256 of each migration, compiled in from migrations.lock.json by `pnpm migrations:lock`
// (the lock itself isn't part of the built artefact). check-migrations-immutable keeps the two in
// step, so db.migration.applied's `checksum` is the hash the repo check guards.
import { MIGRATION_CHECKSUMS } from './migration-checksums.generated.js';

export function migrationChecksums(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(MIGRATION_CHECKSUMS).map(([name, entry]) => [name, entry.sha256]),
  );
}
