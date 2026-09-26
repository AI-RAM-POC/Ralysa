// AC-10 rotation load harness (F-002-T13; design §5.7, §8.4 TC-F-002-15 and -16). Shared by the
// compressed CI run (test/integration/rotation.int.ts, TC-15) and the 10-minute soak at production
// timings (test/soak/rotation.soak.ts, TC-16).
//
// What runs, against the dev stack and the in-process mock IdP:
// - TWO control-plane replicas (two buildApp instances on one database), each with its own
//   signing-key watcher over the REAL Transit key `ralysa-rts-signing`, its own IdP client-secret
//   watcher (src/secrets/runtime.ts) over a per-run KV path, its own Graph directory and OIDC
//   relying party. Requests alternate between them.
// - A fake gateway on @ralysa/auth: the remote JWKS of replica A (a real listener), the governance
//   feed with its own Transit-signed service identity (ralysa-svc-model-gateway), audience
//   model-gateway.
// - A steady mixed load at `rps`: flow-A exchanges (a fresh IdP token each time), refreshes (each
//   refresh token is used by one caller at a time), flow-B sign-ins end to end (authorize, the
//   mock's headless browser, the callback that redeems the IdP code with the client secret, and
//   the RTS code redemption), and verifications (the fake gateway, and /v1/me on the control
//   plane's own verifier).
// - Rotations by the OPERATOR identity (a token with the dev stack's `ralysa-operator` policy,
//   which can rotate keys and write KV but never read a secret back):
//   * the Transit key at `keyRotateAtMs` (`transit/keys/ralysa-rts-signing/rotate`);
//   * the IdP client secret at `secretRotateAtMs`: add a second secret at the IdP, `kv put` the new
//     version, then remove the old one at the IdP once `secret.rotated phase=observed` is stored
//     (TC-15) or once every replica reports the new version (the runbook; TC-16).
//
// Replica B can be given a slower secret poll than A, so it still holds the old secret when the IdP
// drops it and must recover through the invalid_client re-read. At the moment the old secret is
// removed, replica B's Graph directory is replaced by a fresh one (sharing B's secret watcher): that
// stands in for its cached Graph app token expiring, which otherwise happens only once an hour, so
// Graph's own invalid_client path runs under load too.
//
// The report holds counts, timings, kids and versions only: never a token, code or secret.
import {
  type RevocationFeed,
  buildAuthorizeUrl,
  createAccessTokenVerifier,
  createPkcePair,
  createRevocationFeed,
  createServiceTokenSource,
  createState,
  createTransitAssertionSigner,
  readAuthorizationCallback,
} from '@ralysa/auth';
import { CLI_CLIENT_ID, kidFor } from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import { AuthConfig } from '@ralysa/protocol/control-plane';
import { type KeyCustody, type SecretStore, createOpenBao } from '@ralysa/secrets';
import { type DevStack, baoClient, expectOk, rootBao, uniqueName } from '@ralysa/dev-stack/harness';
import { type MockIdp, signInAtAuthorize, startMockIdp } from '@ralysa/dev-stack/mock-idp';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { buildApp } from '../../src/app.js';
import { createRejectionAggregator } from '../../src/audit/rejections.js';
import { type AuditWriter, createAuditWriter } from '../../src/audit/writer.js';
import type { IdpDirectory } from '../../src/auth/directory-port.js';
import { type GraphDirectory, createGraphDirectory } from '../../src/auth/idp/graph-directory.js';
import { createIdpMetadataSource } from '../../src/auth/idp/metadata.js';
import { type SigningKeys, createSigningKeys } from '../../src/auth/tokens/signing-keys.js';
import type { ServeConfig } from '../../src/config/schema.js';
import { createDb } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { createRateLimiter } from '../../src/http/rate-limits.js';
import type { Logger } from '../../src/observability/logger.js';
import { type MemoryMetrics, createMemoryMetrics } from '../../src/observability/metrics.js';
import { createPinoLogger } from '../../src/observability/pino.js';
import { ensureOrganization } from '../../src/org/bootstrap.js';
import { type IdpClientSecret, createIdpClientSecret } from '../../src/secrets/runtime.js';
import { serveConfig, serveConfigInput } from '../fixtures/serve-config.js';
import { type TestDatabase, createTestDatabase } from '../integration/support/db.js';

export const SIGNING_KEY = 'ralysa-rts-signing';
const BASE = 'http://127.0.0.1:4199';
const LOOPBACK = 'http://127.0.0.1:49152/callback';
const OPERATOR_POLICY = 'ralysa-operator';
const GATEWAY = 'model-gateway';

export interface ScenarioOptions {
  stack: DevStack;
  durationMs: number;
  /** Operations started per second (each is one request or one sign-in). */
  rps: number;
  keyRotateAtMs: number;
  secretRotateAtMs: number;
  keyPollS: number;
  activationDelayS: number;
  /** The IdP client-secret poll of replica A and replica B. */
  secretPollS: readonly [number, number];
  /** When the operator removes the old secret at the IdP. */
  removeOldSecretWhen: 'observed' | 'all_replicas';
  /** Progress lines (the soak prints them). */
  progress?: (line: string) => void;
}

export type OperationKind = 'exchange' | 'refresh' | 'flow_b' | 'verify_gateway' | 'verify_cp';

export interface OperationFailure {
  kind: OperationKind;
  replica: 'a' | 'b';
  atMs: number;
  /** HTTP status, or the verifier's reason, or an error name. Never a token. */
  detail: string;
}

export interface ScenarioReport {
  durationMs: number;
  operations: Record<OperationKind, number>;
  failures: OperationFailure[];
  signingKey: {
    kidBefore: string;
    kidAfter: string;
    rotatedAtMs: number;
    /** The first token minted with the new kid, measured from the rotation. */
    newKidInUseAfterMs: number | undefined;
    /** Tokens minted before the rotation (old kid), verified again at the end. */
    oldKidTokensVerifiedAtEnd: { total: number; ok: number };
    jwksKidsAtEnd: string[];
    events: { version: number; phase: string }[];
  };
  idpSecret: {
    versionBefore: number;
    versionAfter: number;
    rotatedAtMs: number;
    oldRemovedAtMs: number | undefined;
    /** Per replica: when it first held the new version, measured from the `kv put`. */
    newVersionInUseAfterMs: { a: number | undefined; b: number | undefined };
    invalidClientRetries: { a: number; b: number };
    invalidClientNoRetry: { a: number; b: number };
    events: { version: number; phase: string }[];
  };
  warnings: Record<string, number>;
}

interface Replica {
  name: 'a' | 'b';
  app: FastifyInstance;
  keys: SigningKeys;
  secret: IdpClientSecret;
  metrics: MemoryMetrics;
  stopSecretWatch: () => void;
  keyTimer: ReturnType<typeof setInterval>;
  /** Swapped to a fresh Graph directory when the old secret is removed (see the header). */
  graph: { current: GraphDirectory };
}

const kidOf = (token: string): string => {
  const [header = ''] = token.split('.');
  return (JSON.parse(Buffer.from(header, 'base64url').toString()) as { kid: string }).kid;
};

const versionOf = (kid: string): number => Number(kid.slice(kid.lastIndexOf('.v') + 2));

/**
 * Runs the scenario. Everything it creates (database, KV path, mock IdP, listeners) is removed at
 * the end, also when it throws.
 */
export async function runRotationScenario(options: ScenarioOptions): Promise<ScenarioReport> {
  const { stack } = options;
  const progress = options.progress ?? (() => undefined);
  const root = rootBao(stack);
  const secretPath = `kv/ralysa/control-plane/${uniqueName('t13-idp-client-secret')}`;
  const cleanups: (() => Promise<unknown>)[] = [];
  const warnings: Record<string, number> = {};

  try {
    // --- the operator identity (runbook): rotate keys and write KV, never read a secret ------------
    const created = expectOk(
      await root('POST', 'auth/token/create', {
        policies: [OPERATOR_POLICY],
        no_default_policy: true,
        ttl: `${String(Math.ceil(options.durationMs / 1000) + 600)}s`,
        display_name: 't13-operator',
      }),
      'operator token',
    ) as { auth?: { client_token?: string } };
    const operatorToken = created.auth?.client_token;
    if (operatorToken === undefined) throw new Error('no operator token');
    const operator = baoClient(stack.openbao.addr, operatorToken);
    cleanups.push(() => root('POST', 'auth/token/revoke', { token: operatorToken }));
    cleanups.push(() => root('DELETE', `kv/metadata/${secretPath.slice('kv/'.length)}`));
    const kvPut = async (value: string) =>
      expectOk(
        await operator('POST', `kv/data/${secretPath.slice('kv/'.length)}`, { data: { value } }),
        'operator kv put',
      );
    // --- the IdP, the database and the organization ----------------------------------------------
    const idp: MockIdp = await startMockIdp({ rtsRedirectUris: [`${BASE}/oauth2/idp/callback`] });
    cleanups.push(() => idp.close());
    await kvPut(idp.clientSecret);
    // The operator can't read the value back (runbook: versions only, from metadata). Checked
    // once the entry exists, and only 403 passes: a 404 would prove nothing (review of #35).
    const readBack = await operator('GET', `kv/data/${secretPath.slice('kv/'.length)}`);
    if (readBack.status !== 403) {
      throw new Error(
        `the operator identity must get 403 reading KV data, got ${String(readBack.status)}`,
      );
    }
    const input = serveConfigInput({
      env: 'test',
      org: {
        id: uuidv7(),
        name: 'Org Rotation',
        residency: 'in_country',
        region: 'qa-doha',
        deployment_model: 'on_prem',
      },
      public_base_url: BASE,
      idp: {
        kind: 'entra',
        tenant_id: idp.tenantId,
        issuer: idp.issuer,
        rts_client_id: idp.rtsClientId,
        allowed_public_client_ids: [idp.cliClientId],
        signin_scope: idp.signinScope,
        client_secret_path: secretPath,
        client_secret_poll_s: options.secretPollS[0],
        graph_base_url: idp.graphBaseUrl,
        require_mfa_claim: true,
      },
      access: { access_group_id: idp.accessGroupId, admin_group_id: idp.adminGroupId },
      tokens: { key_poll_s: options.keyPollS, activation_delay_s: options.activationDelayS },
    });
    const config: ServeConfig = serveConfig(input);
    const ORG = config.org.id;
    const db: TestDatabase = await createTestDatabase(stack);
    cleanups.push(() => db.drop());
    await db.migrate(ORG);
    const cpDb: Kysely<Database> = createDb<Database>(await db.pool('cp_app', 12));
    await ensureOrganization(cpDb, config);
    // Fire-and-forget audit writes are tracked, so the database outlives them.
    const pending = new Set<Promise<unknown>>();
    const real = createAuditWriter({ db: createDb<Database>(await db.pool('audit_writer', 6)) });
    const track = <T>(p: Promise<T>): Promise<T> => {
      pending.add(p);
      void p.finally(() => pending.delete(p)).catch(() => undefined);
      return p;
    };
    const writer: AuditWriter = {
      write: (org, events) => track(real.write(org, events)),
      writeOrSpool: (org, events) => track(real.writeOrSpool(org, events)),
    };
    cleanups.push(async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    });

    const bao = createOpenBao({
      addr: stack.openbao.addr,
      auth: { method: 'token', token: stack.openbao.rootToken },
      env: 'test',
    });
    const custody: KeyCustody = bao.keys;
    const secrets: SecretStore = bao.secrets;
    const idpMetadata = createIdpMetadataSource({ issuer: idp.issuer });
    const tokenEndpoint = async () => (await idpMetadata.get()).tokenEndpoint;

    // --- two replicas ----------------------------------------------------------------------------
    const portLogger = (replica: string): Logger => {
      const count = (level: string) => (msg: string) => {
        if (level === 'info') return;
        const key = `${replica}:${level}:${msg}`;
        warnings[key] = (warnings[key] ?? 0) + 1;
      };
      return { info: count('info'), warn: count('warn'), error: count('error') };
    };
    const pinoLines = (replica: string) =>
      createPinoLogger('warn', {
        write: (line: string) => {
          const msg = (JSON.parse(line) as { msg?: string }).msg ?? 'unknown';
          const key = `${replica}:pino:${msg}`;
          warnings[key] = (warnings[key] ?? 0) + 1;
        },
      });

    const replica = async (name: 'a' | 'b', secretPollS: number): Promise<Replica> => {
      const logger = portLogger(name);
      const metrics = createMemoryMetrics();
      const secret = createIdpClientSecret({
        secrets,
        path: secretPath,
        audit: { writer, orgId: ORG },
        pollMs: secretPollS * 1000,
        logger,
        metrics,
      });
      const stopSecretWatch = secret.start();
      const keys = createSigningKeys({
        db: cpDb,
        custody,
        orgId: ORG,
        key: SIGNING_KEY,
        timing: {
          activationDelayMs: config.tokens.activation_delay_s * 1000,
          retentionMs: (config.tokens.access_ttl_s + 300) * 1000,
        },
        writer,
        logger,
        metrics,
        staleAfterMs: Math.max(30_000, 2 * config.tokens.key_poll_s * 1000),
      });
      await keys.poll();
      const keyTimer = setInterval(
        () => void keys.poll().catch(() => undefined),
        config.tokens.key_poll_s * 1000,
      );
      const newGraph = () =>
        createGraphDirectory({ config, clientSecret: secret, tokenEndpoint, metrics });
      const graph = { current: newGraph() };
      const directory: IdpDirectory = {
        check: (input) => graph.current.check(input),
        groupDisplayName: async (id) => graph.current.groupDisplayName?.(id),
      };
      const app = await buildApp({
        config,
        keys,
        rts: {
          db: cpDb,
          custody,
          directory,
          writer,
          rejections: createRejectionAggregator({ emit: () => undefined }),
          secrets,
          idpClientSecret: secret,
          idpMetadata,
          metrics,
          logger,
        },
        rateLimiter: createRateLimiter({ perIpPerMinute: 1_000_000, globalPerMinute: 1_000_000 }),
        logger: pinoLines(name),
        pingDatabase: () => Promise.resolve(true),
      });
      const built: Replica = {
        name,
        app,
        keys,
        secret,
        metrics,
        stopSecretWatch,
        keyTimer,
        graph,
      };
      cleanups.push(async () => {
        clearInterval(keyTimer);
        stopSecretWatch();
        await app.close();
      });
      return built;
    };
    const a = await replica('a', options.secretPollS[0]);
    const b = await replica('b', options.secretPollS[1]);
    const replicas = [a, b] as const;
    await a.secret.current();
    await b.secret.current();
    const versionBefore = a.secret.version() ?? 0;
    const base = await a.app.listen({ host: '127.0.0.1', port: 0 });
    const cfg = AuthConfig.parse((await a.app.inject({ url: '/v1/auth/config' })).json());

    // --- the fake gateway ------------------------------------------------------------------------
    const serviceTokens = createServiceTokenSource({
      tokenEndpoint: `${base}/oauth2/token`,
      assertionAudience: `${BASE}/oauth2/token`,
      clientId: `svc:${GATEWAY}`,
      signer: createTransitAssertionSigner({ custody, transitKey: `ralysa-svc-${GATEWAY}` }),
    });
    const feed: RevocationFeed = createRevocationFeed({
      url: `${base}/v1/internal/governance`,
      serviceTokens,
    });
    const gateway = createAccessTokenVerifier({
      issuer: BASE,
      audience: GATEWAY,
      jwksUrl: `${base}/.well-known/jwks.json`,
      kidPrefix: SIGNING_KEY,
      revocation: feed,
      orgId: ORG,
    });
    if ((await feed.start()) !== 'confirmed') throw new Error('the governance feed did not start');
    cleanups.push(() => {
      feed.stop();
      return Promise.resolve();
    });

    // --- operations ------------------------------------------------------------------------------
    const started = Date.now();
    const at = () => Date.now() - started;
    const operations: Record<OperationKind, number> = {
      exchange: 0,
      refresh: 0,
      flow_b: 0,
      verify_gateway: 0,
      verify_cp: 0,
    };
    const failures: OperationFailure[] = [];
    const refreshPool: string[] = [];
    const gatewayTokens: string[] = [];
    const cpTokens: string[] = [];
    const oldKidTokens: string[] = [];
    let rotatedAtMs = Number.POSITIVE_INFINITY;
    let newKidInUseAfterMs: number | undefined;
    const kidBefore = kidFor(SIGNING_KEY, a.keys.status().activeVersion ?? 0);
    const kidAfter = kidFor(SIGNING_KEY, versionOf(kidBefore) + 1);

    const minted = (token: string, pool: string[]) => {
      const kid = kidOf(token);
      if (kid === kidAfter && newKidInUseAfterMs === undefined) {
        newKidInUseAfterMs = at() - rotatedAtMs;
        progress(`new kid ${kid} in use ${String(newKidInUseAfterMs)} ms after the rotation`);
      }
      if (
        kid === kidBefore &&
        at() < rotatedAtMs &&
        oldKidTokens.length < 20 &&
        pool === gatewayTokens
      ) {
        oldKidTokens.push(token);
      }
      pool.push(token);
      if (pool.length > 50) pool.shift();
    };
    const form = (target: Replica, params: Record<string, string>) =>
      target.app.inject({
        method: 'POST',
        url: '/oauth2/token',
        remoteAddress: '127.0.0.1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'ralysa-cli/rotation-harness',
        },
        payload: new URLSearchParams(params).toString(),
      });
    const fail = (kind: OperationKind, target: Replica, detail: string) => {
      failures.push({ kind, replica: target.name, atMs: at(), detail: detail.slice(0, 120) });
      progress(`FAILED ${kind} on ${target.name} at ${String(at())} ms: ${detail.slice(0, 120)}`);
    };
    const problem = (status: number, body: string) => {
      try {
        const parsed = JSON.parse(body) as { error?: string; code?: string };
        return `${String(status)} ${parsed.error ?? parsed.code ?? ''}`;
      } catch {
        return String(status);
      }
    };

    const exchange = async (target: Replica) => {
      operations.exchange += 1;
      const reply = await form(target, {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: CLI_CLIENT_ID,
        subject_token: idp.mintAccessToken('alice'),
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: GATEWAY,
      });
      if (reply.statusCode !== 200) {
        fail('exchange', target, problem(reply.statusCode, reply.body));
        return;
      }
      const body = reply.json<{ access_token: string; refresh_token: string }>();
      minted(body.access_token, gatewayTokens);
      refreshPool.push(body.refresh_token);
    };
    const refresh = async (target: Replica) => {
      const token = refreshPool.shift();
      if (token === undefined) return exchange(target);
      operations.refresh += 1;
      const reply = await form(target, {
        grant_type: 'refresh_token',
        client_id: CLI_CLIENT_ID,
        refresh_token: token,
        audience: GATEWAY,
      });
      if (reply.statusCode !== 200) {
        fail('refresh', target, problem(reply.statusCode, reply.body));
        return;
      }
      const body = reply.json<{ access_token: string; refresh_token: string }>();
      minted(body.access_token, gatewayTokens);
      refreshPool.push(body.refresh_token);
    };
    const leg = (target: Replica, url: string, cookie?: string) =>
      target.app.inject({
        method: 'GET',
        url,
        remoteAddress: '127.0.0.1',
        headers: {
          'user-agent': 'Mozilla/5.0 (rotation harness)',
          ...(cookie === undefined ? {} : { cookie }),
        },
      });
    const flowB = async (target: Replica) => {
      operations.flow_b += 1;
      const { verifier, challenge } = await createPkcePair();
      const state = createState();
      const authorizeUrl = new URL(
        buildAuthorizeUrl(cfg, { redirectUri: LOOPBACK, challenge, state }).href,
      );
      const start = await leg(target, `${authorizeUrl.pathname}${authorizeUrl.search}`);
      const setCookie = start.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
      const location = start.headers.location;
      if (start.statusCode !== 302 || typeof location !== 'string') {
        fail('flow_b', target, `authorize ${String(start.statusCode)}`);
        return;
      }
      const atIdp = await signInAtAuthorize({ authorizationUrl: location, username: 'alice' });
      const callback = await leg(target, `${atIdp.pathname}${atIdp.search}`, cookie);
      const back = callback.headers.location;
      if (callback.statusCode !== 302 || typeof back !== 'string') {
        fail('flow_b', target, `callback ${String(callback.statusCode)}`);
        return;
      }
      const loopback = new URL(back);
      if (loopback.searchParams.has('error')) {
        fail('flow_b', target, `callback error=${loopback.searchParams.get('error') ?? ''}`);
        return;
      }
      const code = readAuthorizationCallback(Object.fromEntries(loopback.searchParams), state);
      const reply = await form(target, {
        grant_type: 'authorization_code',
        client_id: CLI_CLIENT_ID,
        code,
        redirect_uri: LOOPBACK,
        code_verifier: verifier,
      });
      if (reply.statusCode !== 200) {
        fail('flow_b', target, problem(reply.statusCode, reply.body));
        return;
      }
      const body = reply.json<{ access_token: string; refresh_token: string }>();
      minted(body.access_token, cpTokens);
      refreshPool.push(body.refresh_token);
    };
    const verifyGateway = async (target: Replica, token?: string) => {
      const pick = token ?? gatewayTokens.at(-1);
      if (pick === undefined) return exchange(target);
      operations.verify_gateway += 1;
      const result = await gateway.verify(`Bearer ${pick}`);
      if (!result.ok) fail('verify_gateway', target, result.reason);
      return undefined;
    };
    const verifyControlPlane = async (target: Replica) => {
      const pick = cpTokens.at(-1);
      if (pick === undefined) return flowB(target);
      operations.verify_cp += 1;
      const reply = await target.app.inject({
        url: '/v1/me',
        headers: { authorization: `Bearer ${pick}` },
      });
      if (reply.statusCode !== 200)
        fail('verify_cp', target, problem(reply.statusCode, reply.body));
      return undefined;
    };

    const plan: [OperationKind, (target: Replica) => Promise<unknown>][] = [
      ['exchange', exchange],
      ['flow_b', flowB],
      ['refresh', refresh],
      ['verify_gateway', verifyGateway],
      ['refresh', refresh],
      ['verify_cp', verifyControlPlane],
    ];
    let tick = 0;
    const inflight = new Set<Promise<unknown>>();
    const launch = () => {
      // Each full pass over the plan goes to one replica, the next pass to the other, so both
      // replicas serve every kind of operation.
      const target = replicas[Math.floor(tick / plan.length) % 2] ?? a;
      const [kind, op] = plan[tick % plan.length] ?? ['exchange', exchange];
      tick += 1;
      const run = op(target).catch((error: unknown) => {
        fail(kind, target, `threw ${error instanceof Error ? error.name : 'unknown'}`);
      });
      inflight.add(run);
      void run.finally(() => inflight.delete(run));
    };

    // --- rotations -------------------------------------------------------------------------------
    let secretRotatedAtMs = Number.POSITIVE_INFINITY;
    let oldRemovedAtMs: number | undefined;
    let versionAfter = versionBefore + 1;
    const newVersionInUseAfterMs: { a: number | undefined; b: number | undefined } = {
      a: undefined,
      b: undefined,
    };
    const observedStored = async (version: number) =>
      (
        await db.superuser.query<{ n: number }>(
          `select count(*)::int as n from audit.audit_event
            where action = 'secret.rotated' and details->>'kind' = 'idp_client_secret'
              and (details->>'version')::int = $1 and details->>'phase' = 'observed'`,
          [version],
        )
      ).rows[0]?.n ?? 0;

    const rotateKey = async () => {
      expectOk(await operator('POST', `transit/keys/${SIGNING_KEY}/rotate`), 'operator rotate');
      rotatedAtMs = at();
      progress(`Transit key rotated at ${String(rotatedAtMs)} ms (was ${kidBefore})`);
    };
    const rotateSecret = async () => {
      const oldSecret = idp.clientSecret;
      const next = idp.addClientSecret(); // 1. a second secret at the IdP
      const put = (await kvPut(next)) as { data?: { version?: number } }; // 2. kv put
      versionAfter = put.data?.version ?? versionBefore + 1;
      secretRotatedAtMs = at();
      progress(`IdP secret v${String(versionAfter)} written at ${String(secretRotatedAtMs)} ms`);
      // 3. remove the old secret at the IdP once the new version was observed (TC-15), or once
      // every replica reports it (the runbook).
      const ready = async () =>
        options.removeOldSecretWhen === 'observed'
          ? (await observedStored(versionAfter)) > 0
          : replicas.every((r) => r.secret.version() === versionAfter);
      while (!(await ready())) await new Promise((r) => setTimeout(r, 200));
      idp.removeClientSecret(oldSecret);
      oldRemovedAtMs = at();
      // Replica B's Graph app token "expires" now (see the header).
      b.graph.current = createGraphDirectory({
        config,
        clientSecret: b.secret,
        tokenEndpoint,
        metrics: b.metrics,
      });
      progress(`old IdP secret removed at ${String(oldRemovedAtMs)} ms`);
    };
    const watchSecretAdoption = setInterval(() => {
      if (!Number.isFinite(secretRotatedAtMs)) return;
      for (const r of replicas) {
        if (newVersionInUseAfterMs[r.name] === undefined && r.secret.version() === versionAfter) {
          newVersionInUseAfterMs[r.name] = at() - secretRotatedAtMs;
        }
      }
    }, 100);
    cleanups.push(() => {
      clearInterval(watchSecretAdoption);
      return Promise.resolve();
    });

    // --- run -------------------------------------------------------------------------------------
    progress(
      `load ${String(options.rps)} rps for ${String(options.durationMs)} ms; key at ${String(options.keyRotateAtMs)} ms, secret at ${String(options.secretRotateAtMs)} ms`,
    );
    const loadTimer = setInterval(launch, Math.round(1000 / options.rps));
    const rotations = [
      new Promise<void>((resolve, reject) => {
        setTimeout(() => void rotateKey().then(resolve, reject), options.keyRotateAtMs);
      }),
      new Promise<void>((resolve, reject) => {
        setTimeout(() => void rotateSecret().then(resolve, reject), options.secretRotateAtMs);
      }),
    ];
    let lastProgress = 0;
    const progressTimer = setInterval(() => {
      if (at() - lastProgress < 60_000) return;
      lastProgress = at();
      const done = Object.values(operations).reduce((x, y) => x + y, 0);
      progress(
        `${String(Math.round(at() / 1000))} s: ${String(done)} operations, ${String(failures.length)} failures`,
      );
    }, 1_000);
    await new Promise((r) => setTimeout(r, options.durationMs));
    clearInterval(loadTimer);
    clearInterval(progressTimer);
    await Promise.all(rotations);
    while (inflight.size > 0) await Promise.allSettled([...inflight]);

    // --- after the run: old-kid tokens, JWKS, events ----------------------------------------------
    let oldOk = 0;
    for (const token of oldKidTokens) {
      if ((await gateway.verify(`Bearer ${token}`)).ok) oldOk += 1;
    }
    const jwks = (await a.app.inject('/.well-known/jwks.json')).json<{ keys: { kid: string }[] }>();
    while (pending.size > 0) await Promise.allSettled([...pending]);
    const rotatedEvents = (
      await db.superuser.query<{ kind: string; version: number; phase: string }>(
        `select details->>'kind' as kind, (details->>'version')::int as version,
                details->>'phase' as phase
           from audit.audit_event where action = 'secret.rotated' order by ingest_seq`,
      )
    ).rows;
    const retries = (r: Replica, retried: 'true' | 'false') =>
      r.metrics.counter('idp_invalid_client_total', { retried });

    return {
      durationMs: at(),
      operations,
      failures,
      signingKey: {
        kidBefore,
        kidAfter,
        rotatedAtMs,
        newKidInUseAfterMs,
        oldKidTokensVerifiedAtEnd: { total: oldKidTokens.length, ok: oldOk },
        jwksKidsAtEnd: jwks.keys.map((k) => k.kid),
        events: rotatedEvents
          .filter((e) => e.kind === 'signing_key')
          .map(({ version, phase }) => ({ version, phase })),
      },
      idpSecret: {
        versionBefore,
        versionAfter,
        rotatedAtMs: secretRotatedAtMs,
        oldRemovedAtMs,
        newVersionInUseAfterMs,
        invalidClientRetries: { a: retries(a, 'true'), b: retries(b, 'true') },
        invalidClientNoRetry: { a: retries(a, 'false'), b: retries(b, 'false') },
        events: rotatedEvents
          .filter((e) => e.kind === 'idp_client_secret')
          .map(({ version, phase }) => ({ version, phase })),
      },
      warnings,
    };
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  }
}
