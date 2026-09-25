// F-002-T14: the DB-dump, log and deploy/** scans of the integration suite, against the dev stack
// and the in-process mock IdP.
//   - TC-F-002-20 (AC-14, SEC-F002-21): the serve logs captured while flow A (device code and
//     exchange), flow B (authorize, callback, redemption), refresh, refresh-token reuse, /v1/me,
//     sign-out, a rejected bearer, a flow-B callback that fails with `code` and `state` in its URL,
//     and a failed OpenBao call run hold no JWT, `rly_rt_`, `rly_ac_`, device or user code, PKCE
//     verifier, state, IdP code, secret or fixture email, and every user reference is a UUID.
//   - TC-F-002-14 (AC-9, BC-13): after those flows, `pg_dump --data-only` of the test database,
//     the captured logs and the tracked deploy/** files (the committed configs) are scanned with
//     the artefact gitleaks config and an exact-value scan for the IdP client secret, every DB
//     role password, the serve AppRole secret id and the dev stack's own credentials: 0 findings.
//     `cp.credential.vault_path` rows match the path pattern; the RTS signing and checkpoint keys
//     report exportable=false and allow_plaintext_backup=false. (The control plane refusing an
//     exportable key is serve.int.ts, TC-F-002-14 part.)
// The scans run the same CLI as CI (`secret-scan-cli.ts dir`), so they need the hash-pinned
// gitleaks (`pnpm tools:install`). Exact values reach it in a mode-0600 file, never argv.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeIdpToken,
  fetchAuthConfig,
  readAuthorizationCallback,
  startIdpDeviceSignIn,
} from '@ralysa/auth';
import {
  DB_ROLES,
  type DevStack,
  dbPassword,
  devStackOrSkip,
  rootBao,
  roleCredentials,
} from '@ralysa/dev-stack/harness';
import {
  type MockIdp,
  approveDeviceCode,
  signInAtAuthorize,
  startMockIdp,
} from '@ralysa/dev-stack/mock-idp';
import { CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import { AuthConfig } from '@ralysa/protocol/control-plane';
import {
  type SecretStore,
  createInMemoryKeyCustody,
  createInMemorySecretStore,
  createOpenBao,
} from '@ralysa/secrets';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRejectionAggregator } from '../../src/audit/rejections.js';
import { type AuditWriter, createAuditWriter } from '../../src/audit/writer.js';
import { createGraphDirectory } from '../../src/auth/idp/graph-directory.js';
import { createIdpMetadataSource } from '../../src/auth/idp/metadata.js';
import type { ServeConfig } from '../../src/config/schema.js';
import { createDb } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { createRateLimiter } from '../../src/http/rate-limits.js';
import { type PinoLogger, createPinoLogger, loggerFromPino } from '../../src/observability/pino.js';
import { ensureOrganization } from '../../src/org/bootstrap.js';
import { fakeKeys } from '../fixtures/fake-keys.js';
import { serveConfig, serveConfigInput } from '../fixtures/serve-config.js';
import { type TestDatabase, createTestDatabase } from './support/db.js';

const stack = await devStackOrSkip();
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCAN_CLI = join(REPO_ROOT, 'tooling/repo-scripts/src/secret-scan-cli.ts');
const COMPOSE_FILE = join(REPO_ROOT, 'deploy/docker/dev/compose.yaml');
const ENV_FILE = join(REPO_ROOT, 'deploy/docker/dev/.env');
const kv = (key: string) => `kv/ralysa/control-plane/${key}`;
const HMAC_KEY = 'scans-audit-hmac-key-not-a-secret';
const LOOPBACK = 'http://127.0.0.1:49152/callback';
/** A path the serve AppRole may not read (it is the migrator's credential): OpenBao answers 403. */
const DENIED_PATH = kv('db/migrator');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => {
    server.close(() => {
      done();
    });
  });
  return port;
}

/** Runs `secret-scan-cli.ts dir <dir>` with the exact values; returns its exit code and output. */
function scanDir(dir: string, exact: Map<string, string>): { status: number; output: string } {
  const work = mkdtempSync(join(tmpdir(), 'ralysa-scan-values-'));
  try {
    const file = join(work, 'values');
    writeFileSync(
      file,
      [...exact.entries()]
        .filter(([, value]) => value.length >= 16)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    const result = spawnSync(
      process.execPath,
      [SCAN_CLI, 'dir', dir, '--exact-values', file, '--report-dir', join(work, 'reports')],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe.skipIf(stack === undefined)('DB-dump, log and deploy scans (F-002-T14)', () => {
  let idp: MockIdp;
  let config: ServeConfig;
  let db: TestDatabase | undefined;
  let cpDb: Kysely<Database>;
  let writer: AuditWriter;
  let app: FastifyInstance;
  let baoApp: FastifyInstance;
  let base: string;
  let cfg: AuthConfig;
  let log: PinoLogger;
  const lines: string[] = [];
  /** Every secret or token value seen during the flows: name → value. */
  const seen = new Map<string, string>();
  const remember = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') seen.set(`${name}_${String(seen.size)}`, value);
  };
  /** The serve AppRole secret_ids this file used. */
  const secretIds: string[] = [];
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };
  const dev = (): DevStack => {
    if (stack === undefined) throw new Error('no dev stack');
    return stack;
  };

  const form = (target: FastifyInstance, url: string, params: Record<string, string>) =>
    target.inject({
      method: 'POST',
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'ralysa-cli/test',
      },
      payload: new URLSearchParams(params).toString(),
    });
  const get = (target: FastifyInstance, url: string, cookie?: string) =>
    target.inject({
      method: 'GET',
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        'user-agent': 'Mozilla/5.0 (test browser)',
        ...(cookie === undefined ? {} : { cookie }),
      },
    });

  const buildWith = async (serve: ServeConfig, directorySecrets: SecretStore) => {
    const secrets = createInMemorySecretStore({
      [kv('idp-client-secret')]: idp.clientSecret,
      [kv('audit-hmac')]: HMAC_KEY,
    });
    const idpMetadata = createIdpMetadataSource({ issuer: idp.issuer });
    return buildApp({
      config: serve,
      keys: (await fakeKeys()).keys,
      rts: {
        db: cpDb,
        custody: createInMemoryKeyCustody(),
        directory: createGraphDirectory({
          config: serve,
          secrets: directorySecrets,
          tokenEndpoint: async () => (await idpMetadata.get()).tokenEndpoint,
        }),
        writer,
        rejections: createRejectionAggregator({ emit: () => undefined }),
        secrets,
        idpMetadata,
        logger: loggerFromPino(log),
      },
      rateLimiter: createRateLimiter({ perIpPerMinute: 10_000, globalPerMinute: 10_000 }),
      pingDatabase: () => Promise.resolve(true),
      logger: log,
    });
  };

  beforeAll(async () => {
    log = createPinoLogger('debug', {
      write: (line: string) => {
        lines.push(line);
      },
    });
    const port = await freePort();
    base = `http://127.0.0.1:${String(port)}`;
    idp = await startMockIdp({
      deviceCodeTtlSeconds: 10,
      deviceCodeIntervalSeconds: 1,
      rtsRedirectUris: [`${base}/oauth2/idp/callback`],
    });
    const input = serveConfigInput({
      env: 'test',
      org: {
        id: uuidv7(),
        name: 'Org Scans',
        residency: 'in_country',
        region: 'qa-doha',
        deployment_model: 'on_prem',
      },
      public_base_url: base,
      idp: {
        kind: 'entra',
        tenant_id: idp.tenantId,
        issuer: idp.issuer,
        rts_client_id: idp.rtsClientId,
        allowed_public_client_ids: [idp.cliClientId],
        signin_scope: idp.signinScope,
        client_secret_path: kv('idp-client-secret'),
        graph_base_url: idp.graphBaseUrl,
        require_mfa_claim: true,
      },
      access: { access_group_id: idp.accessGroupId, admin_group_id: idp.adminGroupId },
    });
    config = serveConfig(input);
    db = await createTestDatabase(dev());
    await db.migrate(config.org.id);
    cpDb = createDb<Database>(await db.pool('cp_app', 6));
    await ensureOrganization(cpDb, config);
    writer = createAuditWriter({ db: createDb<Database>(await db.pool('audit_writer', 3)) });
    app = await buildWith(
      config,
      createInMemorySecretStore({ [kv('idp-client-secret')]: idp.clientSecret }),
    );
    await app.listen({ host: '127.0.0.1', port });
    cfg = AuthConfig.parse((await app.inject({ url: '/v1/auth/config' })).json());

    // The second app reads the IdP client secret from real OpenBao as the serve AppRole, at a path
    // that role may not read: every Graph call fails on a 403 from OpenBao.
    const { roleId, secretId } = await roleCredentials(dev(), 'ralysa-cp-serve');
    secretIds.push(secretId);
    const bao = createOpenBao({
      addr: dev().openbao.addr,
      auth: { method: 'approle', roleId, secretId: () => Promise.resolve(secretId) },
      env: 'dev',
    });
    baoApp = await buildWith(
      serveConfig({
        ...input,
        idp: { ...(input.idp as object), client_secret_path: DENIED_PATH },
      }),
      bao.secrets,
    );
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await baoApp.close();
    await idp.close();
    await db?.drop();
  });

  it('runs the flows whose logs and database the scans read', async () => {
    // Flow A: the IdP-native device flow through @ralysa/auth, then the exchange (over HTTP).
    const deviceCfg = await fetchAuthConfig(base);
    const device = await startIdpDeviceSignIn(deviceCfg);
    remember('user_code', device.userCode);
    const polled = device.poll();
    await approveDeviceCode({
      verificationUri: device.verificationUri,
      userCode: device.userCode,
      username: 'alice',
    });
    const { idpAccessToken } = await polled;
    remember('entra_access_token', idpAccessToken);
    const flowA = await exchangeIdpToken(deviceCfg, idpAccessToken, {
      deviceLabel: 'alice-laptop',
    });
    remember('access_token', flowA.accessToken);
    remember('refresh_token', flowA.refreshToken);

    // Refresh, then present the old refresh token again (reuse revokes the family).
    const refreshed = await form(app, '/oauth2/token', {
      grant_type: 'refresh_token',
      client_id: CLI_CLIENT_ID,
      refresh_token: flowA.refreshToken,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const rotated = refreshed.json<{ access_token: string; refresh_token: string }>();
    remember('access_token', rotated.access_token);
    remember('refresh_token', rotated.refresh_token);
    const reuse = await form(app, '/oauth2/token', {
      grant_type: 'refresh_token',
      client_id: CLI_CLIENT_ID,
      refresh_token: flowA.refreshToken,
    });
    expect(reuse.statusCode).toBe(400);

    // Flow B: authorize, the IdP, the callback, the redemption; /v1/me; sign-out.
    const { verifier, challenge } = await createPkcePair();
    const state = createState();
    remember('pkce_verifier', verifier);
    remember('state', state);
    const authorizeUrl = new URL(
      buildAuthorizeUrl(cfg, { redirectUri: LOOPBACK, challenge, state }).href,
    );
    const start = await get(app, `${authorizeUrl.pathname}${authorizeUrl.search}`);
    expect(start.statusCode).toBe(302);
    const setCookie = start.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
    const atIdp = await signInAtAuthorize({
      authorizationUrl: String(start.headers.location),
      username: 'fatima',
    });
    remember('idp_code', atIdp.searchParams.get('code') ?? undefined);
    remember('idp_state', atIdp.searchParams.get('state') ?? undefined);
    const callback = await get(app, `${atIdp.pathname}${atIdp.search}`, cookie);
    expect(callback.statusCode).toBe(302);
    const loopback = new URL(String(callback.headers.location));
    const code = readAuthorizationCallback(Object.fromEntries(loopback.searchParams), state);
    remember('authorization_code', code);
    const redeemed = await form(app, '/oauth2/token', {
      grant_type: 'authorization_code',
      client_id: CLI_CLIENT_ID,
      code,
      redirect_uri: LOOPBACK,
      code_verifier: verifier,
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const flowB = redeemed.json<{ access_token: string; refresh_token: string }>();
    remember('access_token', flowB.access_token);
    remember('refresh_token', flowB.refresh_token);
    const me = await app.inject({
      url: '/v1/me',
      headers: { authorization: `Bearer ${flowB.access_token}` },
    });
    expect(me.statusCode, me.body).toBe(200);
    const revoked = await form(app, '/oauth2/revoke', {
      client_id: CLI_CLIENT_ID,
      token: flowB.refresh_token,
    });
    expect(revoked.statusCode).toBe(200);
    // A second redemption of the same code is refused as reuse (and logged).
    expect(
      (
        await form(app, '/oauth2/token', {
          grant_type: 'authorization_code',
          client_id: CLI_CLIENT_ID,
          code,
          redirect_uri: LOOPBACK,
          code_verifier: verifier,
        })
      ).statusCode,
    ).toBe(400);

    // A rejected bearer (a tampered token) and a flow-B callback without the binding cookie,
    // with the IdP's `code` and `state` in its URL [SEC-F002-21].
    const tampered = `${flowB.access_token.slice(0, -4)}AAAA`;
    expect(
      (await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${tampered}` } }))
        .statusCode,
    ).toBe(401);
    const { challenge: c2 } = await createPkcePair();
    const s2 = createState();
    remember('state', s2);
    const url2 = new URL(
      buildAuthorizeUrl(cfg, { redirectUri: LOOPBACK, challenge: c2, state: s2 }).href,
    );
    const start2 = await get(app, `${url2.pathname}${url2.search}`);
    const atIdp2 = await signInAtAuthorize({
      authorizationUrl: String(start2.headers.location),
      username: 'alice',
    });
    remember('idp_code', atIdp2.searchParams.get('code') ?? undefined);
    remember('idp_state', atIdp2.searchParams.get('state') ?? undefined);
    const noCookie = await get(app, `${atIdp2.pathname}${atIdp2.search}`);
    expect(noCookie.statusCode).toBeGreaterThanOrEqual(400);

    // A failed OpenBao call: the Graph directory can't read the IdP client secret (403), so the
    // exchange fails closed, and the error is logged through the same pino instance.
    const denied = await form(baoApp, '/oauth2/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: CLI_CLIENT_ID,
      subject_token: idp.mintAccessToken('alice'),
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    });
    expect(denied.statusCode).toBeGreaterThanOrEqual(400);
    // secret_ids are single use: a fresh one for the direct read.
    const fresh = await roleCredentials(dev(), 'ralysa-cp-serve');
    secretIds.push(fresh.secretId);
    const bao = createOpenBao({
      addr: dev().openbao.addr,
      auth: {
        method: 'approle',
        roleId: fresh.roleId,
        secretId: () => Promise.resolve(fresh.secretId),
      },
      env: 'dev',
    });
    const failure = await bao.secrets.get(DENIED_PATH).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    log.error({ err: failure, path: DENIED_PATH }, 'vault read failed');
    expect(lines.length).toBeGreaterThan(10);
  }, 120_000);

  /** Every credential the scans look for, by name (values never printed). */
  const exactValues = async (): Promise<Map<string, string>> => {
    const values = new Map(seen);
    values.set('IDP_CLIENT_SECRET', idp.clientSecret);
    values.set('AUDIT_HMAC_KEY', HMAC_KEY);
    secretIds.forEach((id, index) => values.set(`APPROLE_SECRET_ID_${String(index)}`, id));
    values.set('POSTGRES_PASSWORD', dev().postgres.password);
    values.set('BAO_ROOT_TOKEN', dev().openbao.rootToken);
    for (const role of DB_ROLES) {
      values.set(`DB_PASSWORD_${role.key.toUpperCase()}`, await dbPassword(dev(), role.key));
    }
    return values;
  };

  it('TC-F-002-20: the captured logs hold no token, code, verifier, secret or email; users are UUIDs', async () => {
    const text = lines.join('');
    // Shapes first, so a finding names the kind of leak.
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.eyJ/);
    expect(text).not.toMatch(/rly_rt_[A-Za-z0-9_-]{8}/);
    expect(text).not.toMatch(/rly_ac_[A-Za-z0-9_-]{8}/);
    expect(text).not.toMatch(/[?&](?:code|state|code_verifier|session_state)=/);
    expect(text).not.toMatch(/@contoso\.example/);
    // OpenBao and Vault token shapes (the AppRole login's client token is never seen by the test).
    expect(text).not.toMatch(/\b(?:hvs|hvb|hvr|s|b|r)\.[A-Za-z0-9]{24,}\b/);
    // Then every value the flows produced, including the short user code.
    const values = await exactValues();
    for (const [name, value] of values) {
      expect(text.includes(value), `${name.replace(/_\d+$/, '')} is in the log`).toBe(false);
    }
    // Structured lines only; every user reference is a UUID.
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      for (const key of ['user_id', 'actor_user_id', 'sub']) {
        if (record[key] !== undefined) expect(record[key]).toMatch(UUID);
      }
      expect(record).not.toHaveProperty('email');
      expect(record).not.toHaveProperty('display_name');
    }
    // The failures above were logged (so the test saw them): the refused callback and the vault.
    expect(text).toMatch(/"route":"\/oauth2\/idp\/callback"/);
    expect(text).toMatch(/vault read failed/);

    // The artefact gitleaks config and the exact-value scan over the log file (as CI would).
    const dir = mkdtempSync(join(tmpdir(), 'ralysa-scan-logs-'));
    try {
      writeFileSync(join(dir, 'control-plane.log'), text);
      const scan = scanDir(dir, values);
      expect(scan.output).toContain('0 findings');
      expect(scan.status, scan.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TC-F-002-14: pg_dump --data-only of the test database scans clean', async () => {
    const dump = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        '--env-file',
        ENV_FILE,
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '-U',
        'postgres',
        '--data-only',
        '--no-owner',
        '-d',
        t().name,
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    expect(dump.status, dump.stderr).toBe(0);
    // The dump holds the flows' rows (the positive control): users, sessions, audit events.
    expect(dump.stdout).toMatch(/COPY cp\.app_user /);
    expect(dump.stdout).toMatch(/COPY audit\.audit_event /);
    expect(dump.stdout).toContain(idp.user('alice').oid);
    const dir = mkdtempSync(join(tmpdir(), 'ralysa-scan-dump-'));
    try {
      writeFileSync(join(dir, `${t().name}.sql`), dump.stdout);
      const scan = scanDir(dir, await exactValues());
      expect(scan.status, scan.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TC-F-002-14: cp.credential holds vault paths only', async () => {
    const orgId = config.org.id;
    await t().superuser.query(
      `INSERT INTO cp.credential (id, org_id, kind, vault_path, owner_scope)
       VALUES ($1, $2, 'idp_client_secret', $3, 'org')`,
      [uuidv7(), orgId, kv('idp-client-secret')],
    );
    await expect(
      t().superuser.query(
        `INSERT INTO cp.credential (id, org_id, kind, vault_path, owner_scope)
         VALUES ($1, $2, 'audit_hmac', $3, 'org')`,
        [uuidv7(), orgId, idp.clientSecret],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const rows = (
      await t().superuser.query<{ vault_path: string }>('SELECT vault_path FROM cp.credential')
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.vault_path).toMatch(/^(kv|transit)\/[a-z0-9/_.-]{1,200}$/);
  });

  it('TC-F-002-14: the RTS signing and checkpoint keys are non-exportable with no plaintext backup', async () => {
    const root = rootBao(dev());
    for (const key of ['ralysa-rts-signing', 'ralysa-audit-checkpoint']) {
      const reply = await root('GET', `transit/keys/${key}`);
      expect(reply.status).toBe(200);
      expect(reply.body?.data).toMatchObject({ exportable: false, allow_plaintext_backup: false });
    }
  });

  it('TC-F-002-14: the tracked deploy/** files (committed configs) scan clean', async () => {
    const listed = spawnSync('git', ['ls-files', '-z', 'deploy'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(listed.status, listed.stderr).toBe(0);
    const files = listed.stdout.split('\0').filter((f) => f !== '');
    expect(files).toContain('deploy/docker/dev/control-plane.serve.dev.yaml');
    expect(files).toContain('deploy/docker/control-plane.Dockerfile');
    expect(files.some((f) => /(?:^|\/)\.env$/.test(f))).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'ralysa-scan-deploy-'));
    try {
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        copyFileSync(join(REPO_ROOT, file), join(dir, file));
      }
      const scan = scanDir(dir, await exactValues());
      expect(scan.status, scan.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
