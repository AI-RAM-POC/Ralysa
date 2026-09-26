// F-002-T07 against the dev stack: the serve app with real Postgres and OpenBao Transit
// (throwaway keys per run: a custody flag can't be undone).
//   - JWKS lists the active key; a minted token verifies with jose against the served JWKS;
//   - rotation: publish at once, activate after the delay (DB clock), retire after retention,
//     with secret.rotated for each phase (AC-10);
//   - TC-F-002-33: flipping `exportable` / `allow_plaintext_backup` at runtime stops minting,
//     /readyz goes 503 and one secret.custody_violation is written;
//   - startup refuses a key that violates custody (TC-F-002-14 part);
//   - the one Organization: created from config, region immutable, device-code flag stored.
import { uuidv7 } from '@ralysa/protocol/common';
import { type KeyCustody, createOpenBao } from '@ralysa/secrets';
import { devStackOrSkip, expectOk, rootBao, uniqueName } from '@ralysa/dev-stack/harness';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createAuditWriter } from '../../src/audit/writer.js';
import { mintAccessToken } from '../../src/auth/tokens/mint.js';
import { type SigningKeys, createSigningKeys } from '../../src/auth/tokens/signing-keys.js';
import { ConfigError } from '../../src/config/load.js';
import { createDb } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { silentLogger } from '../../src/observability/logger.js';
import { OrganizationMismatchError, ensureOrganization } from '../../src/org/bootstrap.js';
import { assertSigningKeyCustody } from '../../src/serve.js';
import { fakeRts } from '../fixtures/fake-rts.js';
import { serveConfig } from '../fixtures/serve-config.js';
import { type TestDatabase, createTestDatabase } from './support/db.js';

const stack = await devStackOrSkip();
const config = serveConfig({
  env: 'test',
  org: {
    id: uuidv7(),
    name: 'Org F',
    residency: 'in_country',
    region: 'qa-doha',
    deployment_model: 'on_prem',
  },
});
const ORG = config.org.id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(stack === undefined)('serve app (F-002-T07)', () => {
  let db: TestDatabase | undefined;
  let cpDb: Kysely<Database>;
  let custody: KeyCustody;
  let keys: SigningKeys;
  let app: FastifyInstance;
  const key = uniqueName('ralysa-test-t07-sign');
  const backupKey = uniqueName('ralysa-test-t07-bak');
  const replacedKey = uniqueName('ralysa-test-t07-rep');
  const multiKey = uniqueName('ralysa-test-t07-multi');
  const pinKey = uniqueName('ralysa-test-t07-pin');
  const unpinKey = uniqueName('ralysa-test-t07-unpin');
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };
  const events = async (action: string) =>
    (
      await t().superuser.query<{ details: Record<string, unknown>; service: string }>(
        `SELECT details, actor_service AS service FROM audit.audit_event WHERE action = $1 ORDER BY ingest_seq`,
        [action],
      )
    ).rows;
  const claims = () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: config.public_base_url,
      aud: 'model-gateway' as const,
      sub: uuidv7(),
      client_id: 'ralysa-cli',
      tid: ORG,
      sid: uuidv7(),
      idp_sub: '4f1c2e3d-0000-4000-8000-000000000001',
      surface: 'cli' as const,
      auth_time: now,
      region: 'qa-doha',
      token_use: 'access' as const,
      iat: now,
      nbf: now,
      exp: now + 900,
      jti: uuidv7(),
    };
  };
  const servedJwks = async () =>
    (await app.inject('/.well-known/jwks.json')).json<{ keys: { kid: string }[] }>();

  beforeAll(async () => {
    const root = rootBao(stack!);
    for (const name of [key, backupKey]) {
      expectOk(await root('POST', `transit/keys/${name}`, { type: 'ecdsa-p256' }), name);
    }
    custody = createOpenBao({
      addr: stack!.openbao.addr,
      auth: { method: 'token', token: stack!.openbao.rootToken },
      env: 'test',
    }).keys;
    db = await createTestDatabase(stack!);
    await db.migrate(ORG);
    cpDb = createDb<Database>(await db.pool('cp_app', 4));
    await expect(ensureOrganization(cpDb, config)).resolves.toEqual({
      created: true,
      deviceCodeChanged: false,
    });
    keys = createSigningKeys({
      db: cpDb,
      custody,
      orgId: ORG,
      key,
      timing: { activationDelayMs: 1_500, retentionMs: 1_500 },
      writer: createAuditWriter({ db: createDb<Database>(await db.pool('audit_writer', 2)) }),
      logger: silentLogger,
    });
    await keys.poll();
    app = await buildApp({
      config,
      keys,
      rts: fakeRts({ db: cpDb, custody }),
      pingDatabase: async () => {
        await sql`select 1`.execute(cpDb);
        return true;
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    const root = rootBao(stack!);
    for (const name of [key, backupKey, replacedKey, multiKey, pinKey, unpinKey]) {
      await root('POST', `transit/keys/${name}/config`, { deletion_allowed: true });
      await root('DELETE', `transit/keys/${name}`);
    }
    await db?.drop();
  });

  it('the Organization is created once from config; its region is immutable; device-code flag stored', async () => {
    await expect(ensureOrganization(cpDb, config)).resolves.toEqual({
      created: false,
      deviceCodeChanged: false,
    });
    await expect(
      ensureOrganization(cpDb, { ...config, org: { ...config.org, region: 'ae-dubai' } }),
    ).rejects.toBeInstanceOf(OrganizationMismatchError);
    await expect(
      ensureOrganization(cpDb, {
        ...config,
        access: { ...config.access, device_code_enabled: false },
      }),
    ).resolves.toEqual({ created: false, deviceCodeChanged: true });
    const { rows } = await t().superuser.query<{
      settings: { auth: { device_code_enabled: boolean } };
    }>(`SELECT settings FROM cp.organization WHERE id = $1`, [ORG]);
    expect(rows[0]?.settings.auth.device_code_enabled).toBe(false);
    await ensureOrganization(cpDb, config);
  });

  it('/readyz is ready; JWKS lists the active key; a minted token verifies with jose', async () => {
    expect((await app.inject('/readyz')).json()).toMatchObject({ status: 'ready' });
    const jwks = await servedJwks();
    expect(jwks.keys.map((k) => k.kid)).toEqual([`${key}.v1`]);
    const token = await mintAccessToken(keys, claims());
    const { protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks as never), {
      issuer: config.public_base_url,
      audience: 'model-gateway',
      typ: 'at+jwt',
      algorithms: ['ES256'],
    });
    expect(protectedHeader.kid).toBe(`${key}.v1`);
  });

  it('rotation: publish at once, activate after the delay, retire after retention (AC-10)', async () => {
    expectOk(await rootBao(stack!)('POST', `transit/keys/${key}/rotate`, {}), 'rotate');
    await keys.poll();
    expect((await servedJwks()).keys.map((k) => k.kid)).toEqual([`${key}.v2`, `${key}.v1`]);
    expect(decodeProtectedHeader(await mintAccessToken(keys, claims())).kid).toBe(`${key}.v1`);
    await sleep(1_600);
    await keys.poll();
    const token = await mintAccessToken(keys, claims());
    expect(decodeProtectedHeader(token).kid).toBe(`${key}.v2`);
    // Verifiers holding the JWKS from before still accept both (the old key stays published).
    const both = await servedJwks();
    expect(both.keys.map((k) => k.kid)).toEqual([`${key}.v2`, `${key}.v1`]);
    await expect(jwtVerify(token, createLocalJWKSet(both as never))).resolves.toBeDefined();
    await sleep(1_600);
    await keys.poll();
    expect((await servedJwks()).keys.map((k) => k.kid)).toEqual([`${key}.v2`]);
    const phases = (await events('secret.rotated')).map(
      (e) => `${String(e.details.phase)}:v${String(e.details.version)}`,
    );
    expect(phases).toEqual([
      'published:v1',
      'activated:v1',
      'published:v2',
      'activated:v2',
      'retired:v1',
    ]);
  });

  it('startup refuses a key that violates custody (TC-F-002-14 part)', async () => {
    await expect(assertSigningKeyCustody(custody, key)).resolves.toBeUndefined();
    expectOk(
      await rootBao(stack!)('POST', `transit/keys/${backupKey}/config`, {
        allow_plaintext_backup: true,
      }),
      'flip',
    );
    await expect(assertSigningKeyCustody(custody, backupKey)).rejects.toBeInstanceOf(ConfigError);
  });

  it('TC-F-002-33: flipping exportable at runtime stops minting, /readyz 503, one custody_violation', async () => {
    expectOk(
      await rootBao(stack!)('POST', `transit/keys/${key}/config`, { exportable: true }),
      'flip',
    );
    await keys.poll();
    await keys.poll();
    const ready = await app.inject('/readyz');
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ checks: { custody: false } });
    await expect(mintAccessToken(keys, claims())).rejects.toThrow(/signing unavailable/);
    const violations = await events('secret.custody_violation');
    expect(violations).toEqual([
      {
        details: {
          key,
          flag: 'exportable',
          exportable: true,
          allow_plaintext_backup: false,
          key_replaced: false,
        },
        service: 'rts',
      },
    ]);
    // Terminal (SEC-F002-35 a): more polls change nothing and record nothing more.
    await keys.poll();
    expect(keys.status()).toMatchObject({ ready: false, custodyViolation: 'exportable' });
    expect(await events('secret.custody_violation')).toHaveLength(1);
  });

  it('TC-F-002-33: the same for allow_plaintext_backup', async () => {
    const other = createSigningKeys({
      db: cpDb,
      custody,
      orgId: ORG,
      key: backupKey,
      timing: { activationDelayMs: 0, retentionMs: 1_000 },
      writer: createAuditWriter({ db: createDb<Database>(await t().pool('audit_writer', 1)) }),
      logger: silentLogger,
    });
    await other.poll();
    expect(other.status()).toMatchObject({
      ready: false,
      custodyViolation: 'allow_plaintext_backup',
    });
    await expect(mintAccessToken(other, claims())).rejects.toThrow(/signing unavailable/);
    expect((await events('secret.custody_violation')).at(-1)).toEqual({
      details: {
        key: backupKey,
        flag: 'allow_plaintext_backup',
        exportable: false,
        allow_plaintext_backup: true,
        key_replaced: false,
      },
      service: 'rts',
    });
  });

  it('a key recreated under the same name is a custody violation (review of #25, SEC-F002-37)', async () => {
    const root = rootBao(stack!);
    expectOk(await root('POST', `transit/keys/${replacedKey}`, { type: 'ecdsa-p256' }), 'key');
    // cp.signing_key_version is one key per org (UNIQUE (org_id, version)): use a second org.
    const org2 = uuidv7();
    await ensureOrganization(cpDb, { ...config, org: { ...config.org, id: org2 } });
    const watcher = createSigningKeys({
      db: cpDb,
      custody,
      orgId: org2,
      key: replacedKey,
      timing: { activationDelayMs: 0, retentionMs: 1_000 },
      writer: createAuditWriter({ db: createDb<Database>(await t().pool('audit_writer', 1)) }),
      logger: silentLogger,
    });
    await watcher.poll();
    expect(watcher.status()).toMatchObject({ ready: true, activeVersion: 1 });
    await root('POST', `transit/keys/${replacedKey}/config`, { deletion_allowed: true });
    expectOk(await root('DELETE', `transit/keys/${replacedKey}`), 'delete');
    expectOk(await root('POST', `transit/keys/${replacedKey}`, { type: 'ecdsa-p256' }), 'recreate');
    await watcher.poll();
    expect(watcher.status()).toMatchObject({ ready: false, custodyViolation: 'key_replaced' });
    await expect(mintAccessToken(watcher, claims())).rejects.toThrow(/signing unavailable/);
    const { rows } = await t().superuser.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit.audit_event WHERE action = 'secret.custody_violation' AND org_id = $1`,
      [org2],
    );
    expect(rows).toEqual([
      {
        details: {
          key: replacedKey,
          flag: 'key_replaced',
          exportable: false,
          allow_plaintext_backup: false,
          key_replaced: true,
        },
      },
    ]);
  });

  it('versions present at the first poll but never active are superseded and retire (T07 follow-up, review of #35)', async () => {
    const root = rootBao(stack!);
    expectOk(await root('POST', `transit/keys/${multiKey}`, { type: 'ecdsa-p256' }), 'key');
    expectOk(await root('POST', `transit/keys/${multiKey}/rotate`), 'rotate');
    expectOk(await root('POST', `transit/keys/${multiKey}/rotate`), 'rotate');
    const org3 = uuidv7();
    await ensureOrganization(cpDb, { ...config, org: { ...config.org, id: org3 } });
    const watcher = createSigningKeys({
      db: cpDb,
      custody,
      orgId: org3,
      key: multiKey,
      timing: { activationDelayMs: 0, retentionMs: 1_000 },
      writer: createAuditWriter({ db: createDb<Database>(await t().pool('audit_writer', 1)) }),
      logger: silentLogger,
    });
    await watcher.poll();
    expect(watcher.status()).toMatchObject({ ready: true, activeVersion: 3 });
    // v1 and v2 were never active; they stay in JWKS only for the retention, then retire.
    expect((await watcher.jwks()).keys.map((k) => k.kid)).toEqual([
      `${multiKey}.v3`,
      `${multiKey}.v2`,
      `${multiKey}.v1`,
    ]);
    await sleep(1_100);
    await watcher.poll();
    expect((await watcher.jwks()).keys.map((k) => k.kid)).toEqual([`${multiKey}.v3`]);
    const { rows } = await t().superuser.query<{ version: number; phase: string }>(
      `SELECT (details->>'version')::int AS version, details->>'phase' AS phase
         FROM audit.audit_event WHERE action = 'secret.rotated' AND org_id = $1 ORDER BY ingest_seq`,
      [org3],
    );
    expect(rows).toEqual([
      { version: 1, phase: 'published' },
      { version: 2, phase: 'published' },
      { version: 3, phase: 'published' },
      { version: 3, phase: 'activated' },
      { version: 1, phase: 'retired' },
      { version: 2, phase: 'retired' },
    ]);
  });

  /** A key with v1 active, then v2 active (v1 superseded); returns a watcher factory for it. */
  const rolledKey = async (name: string) => {
    const root = rootBao(stack!);
    expectOk(await root('POST', `transit/keys/${name}`, { type: 'ecdsa-p256' }), 'key');
    const org = uuidv7();
    await ensureOrganization(cpDb, { ...config, org: { ...config.org, id: org } });
    const writer = createAuditWriter({ db: createDb<Database>(await t().pool('audit_writer', 1)) });
    const watcher = (pinVersion?: number) =>
      createSigningKeys({
        db: cpDb,
        custody,
        orgId: org,
        key: name,
        timing: {
          activationDelayMs: 0,
          retentionMs: 1_000,
          ...(pinVersion === undefined ? {} : { pinVersion }),
        },
        writer,
        logger: silentLogger,
      });
    const normal = watcher();
    await normal.poll();
    expect(normal.status()).toMatchObject({ activeVersion: 1 });
    expectOk(await root('POST', `transit/keys/${name}/rotate`), 'rotate');
    await normal.poll();
    expect(normal.status()).toMatchObject({ activeVersion: 2 }); // v1 superseded
    const phases = async () =>
      (
        await t().superuser.query<{ version: number; phase: string }>(
          `SELECT (details->>'version')::int AS version, details->>'phase' AS phase
             FROM audit.audit_event WHERE action = 'secret.rotated' AND org_id = $1
            ORDER BY ingest_seq`,
          [org],
        )
      ).rows;
    return { watcher, phases };
  };
  const rolledOut = [
    { version: 1, phase: 'published' },
    { version: 1, phase: 'activated' },
    { version: 2, phase: 'published' },
    { version: 2, phase: 'activated' },
  ];

  it('a pinned version keeps signing past the retention, and the bad newer version retires (#36, review of #37)', async () => {
    const { watcher, phases } = await rolledKey(pinKey);
    // Roll back to v1 (a restart with signing_key_pin_version: 1): v1 is live again, v2 superseded.
    const pinned = watcher(1);
    await pinned.poll();
    expect((await pinned.jwks()).keys.map((k) => k.kid)).toEqual([`${pinKey}.v2`, `${pinKey}.v1`]);
    await sleep(1_100);
    await pinned.poll();
    expect(pinned.status()).toMatchObject({ ready: true, activeVersion: 1 });
    const token = await mintAccessToken(pinned, claims());
    expect(decodeProtectedHeader(token).kid).toBe(`${pinKey}.v1`);
    // v2 left JWKS after the retention although the pin still holds.
    expect((await pinned.jwks()).keys.map((k) => k.kid)).toEqual([`${pinKey}.v1`]);
    // Unpinned after v2 retired: v1 is the only live version and keeps signing, nothing changes.
    const unpinned = watcher();
    await unpinned.poll();
    await sleep(1_100);
    await unpinned.poll();
    expect(unpinned.status()).toMatchObject({ ready: true, activeVersion: 1 });
    expect((await unpinned.jwks()).keys.map((k) => k.kid)).toEqual([`${pinKey}.v1`]);
    expect(await phases()).toEqual([
      ...rolledOut,
      { version: 1, phase: 'pinned' },
      { version: 2, phase: 'retired' },
    ]);
  });

  it('unpinned before the newer version retired: it signs again and the former pin retires (review of #37)', async () => {
    const { watcher, phases } = await rolledKey(unpinKey);
    const pinned = watcher(1);
    await pinned.poll();
    await pinned.poll(); // a second replica's poll: nothing recorded twice
    expect(pinned.status()).toMatchObject({ activeVersion: 1 });
    // Unpinned within the retention: v2 is selected again, is not superseded, and v1 is.
    const unpinned = watcher();
    await unpinned.poll();
    expect(unpinned.status()).toMatchObject({ ready: true, activeVersion: 2 });
    const token = await mintAccessToken(unpinned, claims());
    expect(decodeProtectedHeader(token).kid).toBe(`${unpinKey}.v2`);
    await sleep(1_100);
    await unpinned.poll();
    expect(unpinned.status()).toMatchObject({ ready: true, activeVersion: 2 });
    expect((await unpinned.jwks()).keys.map((k) => k.kid)).toEqual([`${unpinKey}.v2`]);
    expect(await phases()).toEqual([
      ...rolledOut,
      { version: 1, phase: 'pinned' },
      { version: 2, phase: 'reactivated' },
      { version: 1, phase: 'retired' },
    ]);
  });
});
