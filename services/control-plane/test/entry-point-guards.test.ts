// TC-F-002-34 (SEC-F002-12, T-12; #41): every entry point, not only `serve`, refuses to start in
// production when OpenBao `sys/seal-status` reports in-memory storage (a dev server). Each case
// drives `main()` with a hardened production config, so the config guards pass and the OpenBao
// check is the only refusal. The one fetch is the seal-status probe: nothing reaches OpenBao
// auth, KV, Transit or the database, and the exit code is 2 (a production-guard refusal).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/commands.js';
import { openBaoStorageRefusals } from '../src/config/guards.js';
import { serveConfig, serveConfigInput } from './fixtures/serve-config.js';

const kv = (key: string) => `kv/ralysa/control-plane/${key}`;
const SEAL_STATUS = 'https://bao.internal:8200/v1/sys/seal-status';

const serve = serveConfigInput();
const common = { org: serve.org, vault: serve.vault, db: serve.db };
const configs: Record<string, Record<string, unknown>> = {
  serve,
  migrate: {
    ...common,
    db_credentials: { migrator: kv('db/migrator'), audit_writer: kv('db/audit_writer') },
  },
  'migrate-audit': {
    ...common,
    db_credentials: {
      audit_migrator: kv('db/audit_migrator'),
      audit_writer: kv('db/audit_writer'),
    },
  },
  sealer: {
    ...common,
    checkpoint_key: 'ralysa-audit-checkpoint',
    db_credentials: { audit_sealer: kv('db/audit_sealer') },
  },
  'audit-verify': {
    ...common,
    checkpoint_key: 'ralysa-audit-checkpoint',
    db_credentials: { audit_reader: kv('db/audit_reader') },
  },
};

let dir: string;
const file = (name: string) => join(dir, `${name}.yaml`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-entry-guards-'));
  // JSON is YAML; env is unset in every file, so each one runs as production.
  for (const [name, config] of Object.entries(configs)) {
    writeFileSync(file(name), JSON.stringify(config));
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Stubs fetch with a seal-status body and captures the JSON lines written to stdout. */
function harness(body: unknown) {
  const fetch = vi.fn(() => Promise.resolve(Response.json(body)));
  vi.stubGlobal('fetch', fetch);
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    return true;
  });
  return { fetch, lines };
}

describe('every entry point refuses an in-memory OpenBao in production (TC-F-002-34; #41)', () => {
  it.each([
    ['serve', ['serve', '--config', 'serve']],
    ['bootstrap-org', ['bootstrap-org', '--config', 'serve']],
    ['migrate', ['migrate', '--config', 'migrate']],
    ['migrate --audit', ['migrate', '--audit', '--config', 'migrate-audit']],
    ['sealer', ['sealer', '--config', 'sealer']],
    ['audit-verify', ['audit-verify', '--config', 'audit-verify']],
  ])('%s exits 2 before touching OpenBao or the database', async (_name, argv) => {
    const { fetch, lines } = harness({ storage_type: 'inmem', sealed: false });
    const args = argv.map((a, i) => (argv[i - 1] === '--config' ? file(a) : a));

    await expect(main(args)).resolves.toBe(2);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([SEAL_STATUS, expect.anything()]);
    const failure = lines.find((l) => l.level === 'error');
    expect(failure).toMatchObject({
      msg: `${String(argv[0])} failed`,
      error: expect.stringMatching(
        /^refusing to start:\n {2}OpenBao reports in-memory storage \(a dev server\)$/,
      ) as unknown,
    });
  });

  it('a config refusal and the OpenBao refusal are reported together', async () => {
    const { lines } = harness({ storage_type: 'inmem', sealed: false });
    const path = file('sealer-no-ssl');
    writeFileSync(
      path,
      JSON.stringify({ ...configs.sealer, db: { ...(common.db as object), ssl: false } }),
    );

    await expect(main(['sealer', '--config', path])).resolves.toBe(2);
    const error = String(lines.find((l) => l.level === 'error')?.error);
    expect(error).toContain('db.ssl must be true in production');
    expect(error).toContain('OpenBao reports in-memory storage');
  });

  it('outside production the OpenBao storage check is not made (as in serve)', async () => {
    const fetch = vi.fn();
    await expect(openBaoStorageRefusals(serveConfig({ env: 'dev' }), fetch)).resolves.toEqual([]);
    await expect(openBaoStorageRefusals(serveConfig({ env: 'test' }), fetch)).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
