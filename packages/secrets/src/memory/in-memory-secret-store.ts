// Hermetic SecretStore double (F-002 design §3.7): versioned values in memory, same `watch`
// semantics as the KV v2 adapter (poll, notify on a version change, not for the starting one).
import { SecretsError } from '../errors.js';
import { startInterval } from '../platform.js';
import type { SecretStore, SecretValue } from '../ports.js';

export interface InMemorySecretStore extends SecretStore {
  /** Writes a new version (1 for a new path) and returns it. */
  put(path: string, value: string): number;
  /** Makes the next reads of `path` fail (tests of error handling). */
  fail(path: string, error: Error | undefined): void;
}

export function createInMemorySecretStore(seed: Record<string, string> = {}): InMemorySecretStore {
  const entries = new Map<string, string[]>();
  const failures = new Map<string, Error>();

  const get = (path: string): Promise<SecretValue> => {
    const failure = failures.get(path);
    if (failure !== undefined) return Promise.reject(failure);
    const versions = entries.get(path);
    const value = versions?.at(-1);
    if (versions === undefined || value === undefined) {
      return Promise.reject(new SecretsError('not_found', `read ${path}: not found`, 404));
    }
    return Promise.resolve({ value, version: versions.length });
  };

  const store: InMemorySecretStore = {
    get,
    put(path, value) {
      const versions = entries.get(path) ?? [];
      versions.push(value);
      entries.set(path, versions);
      return versions.length;
    },
    fail(path, error) {
      if (error === undefined) failures.delete(path);
      else failures.set(path, error);
    },
    watch(path, onChange, pollMs, onError) {
      let last: number | undefined;
      const state = { stopped: false };
      // A function, so the check after `await` isn't narrowed away.
      const isStopped = (): boolean => state.stopped;
      const poll = async (): Promise<void> => {
        try {
          const current = await get(path);
          if (isStopped()) return;
          if (last !== undefined && current.version !== last) onChange(current);
          last = current.version;
        } catch (error) {
          onError?.(error);
        }
      };
      void poll();
      const stop = startInterval(() => void poll(), pollMs);
      return () => {
        state.stopped = true;
        stop();
      };
    },
  };
  for (const [path, value] of Object.entries(seed)) store.put(path, value);
  return store;
}
