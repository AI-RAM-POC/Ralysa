// KV v2 SecretStore (F-002 design §3.7; [KV v2 API](https://openbao.org/api-docs/secret/kv/kv-v2/)).
// Paths name the mount first (`kv/ralysa/control-plane/idp-client-secret`); the adapter inserts
// `data/`. The value is the entry's `value` field, as the dev-stack bootstrap writes it.
import { SecretsError } from '../errors.js';
import { startInterval } from '../platform.js';
import type { SecretStore, SecretValue } from '../ports.js';
import type { AuthedBao } from './auth.js';
import { assertApiPath, record, replyError } from './http.js';

/** `kv/ralysa/x` → `kv/data/ralysa/x`. */
export function kvDataPath(path: string): string {
  assertApiPath(path);
  const slash = path.indexOf('/');
  if (slash <= 0 || slash === path.length - 1) {
    throw new SecretsError('config', `KV path ${JSON.stringify(path)} must be <mount>/<name>`);
  }
  return `${path.slice(0, slash)}/data/${path.slice(slash + 1)}`;
}

export function createKv2SecretStore(bao: AuthedBao): SecretStore {
  const get = async (path: string): Promise<SecretValue> => {
    const api = kvDataPath(path);
    const reply = await bao.request('GET', api);
    if (reply.status !== 200) throw replyError(reply, `read ${path}`);
    const data = record(reply.body?.data);
    const value = record(data?.data)?.value;
    const version = record(data?.metadata)?.version;
    // A deleted or destroyed latest version comes back with data: null.
    if (data?.data === null) throw new SecretsError('not_found', `read ${path}: deleted`, 404);
    if (typeof value !== 'string' || typeof version !== 'number' || !Number.isInteger(version)) {
      throw new SecretsError('invalid_response', `read ${path}: no string value and version`);
    }
    return { value, version };
  };

  return {
    get,
    watch(path, onChange, pollMs, onError) {
      kvDataPath(path);
      let last: number | undefined;
      const state = { stopped: false };
      // A function, so the check after `await` isn't narrowed away.
      const isStopped = (): boolean => state.stopped;
      let busy = false;
      const poll = async (): Promise<void> => {
        if (busy || isStopped()) return;
        busy = true;
        try {
          const current = await get(path);
          if (isStopped()) return;
          if (last !== undefined && current.version !== last) onChange(current);
          last = current.version;
        } catch (error) {
          onError?.(error);
        } finally {
          busy = false;
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
}
