// The SHA-256 of each migration as recorded in migrations.lock.json (the file the
// check-migrations-immutable repo check guards), for db.migration.applied's `checksum`.
// Resolved relative to this module: src/db and dist/db are both two levels below the package.
import { readFileSync } from 'node:fs';

export function migrationChecksums(
  lockUrl: URL = new URL('../../migrations.lock.json', import.meta.url),
): Record<string, string> {
  try {
    const lock = JSON.parse(readFileSync(lockUrl, 'utf8')) as {
      migrations?: Record<string, { sha256?: unknown }>;
    };
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(lock.migrations ?? {})) {
      if (typeof entry.sha256 === 'string') out[name] = entry.sha256;
    }
    return out;
  } catch {
    return {};
  }
}
