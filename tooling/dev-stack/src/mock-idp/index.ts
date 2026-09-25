// The mock IdP (F-002 design §8.3, D-9): an Entra v2-shaped OpenID provider for tests and local
// runs, built on oidc-provider. Tests start it in-process with startMockIdp(); the compose
// `mock-idp` service runs main.ts. Never shipped (SEC-F002-13): `@ralysa/dev-stack` is tooling,
// and check-workspaces refuses it (and oidc-provider) in any shipped workspace's dependencies.
//
// Per run: a fresh RSA signing key (never committed, SEC-F002-13 d), fresh user object ids, a
// fresh RTS client secret, and a fresh bearer for the test-control API, which listens on
// 127.0.0.1 only (SEC-F002-13 e).
import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signBytes,
} from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jwtVerify } from 'jose';
import type { JWK } from 'oidc-provider';
import { GRAPH_RESOURCE, userAccessClaims } from './claims.ts';
import { handleControl } from './control.ts';
import type { MockUser } from './fixtures.ts';
import { handleGraph } from './graph.ts';
import { createProvider, handleInteraction, splitScope } from './provider.ts';
import {
  type GraphFault,
  type MockIdpState,
  type UserPatch,
  createState,
  newClientSecret,
  patchUser,
  revokeSessions,
  userByName,
} from './state.ts';

export { ACCESS_GROUP_NAME, ADMIN_GROUP_NAME, FATIMA_NAME, type MockUser } from './fixtures.ts';
export { GRAPH_RESOURCE } from './claims.ts';
export type { GraphFault, UserPatch } from './state.ts';
export { approveDeviceCode, signInAtAuthorize } from './browser.ts';

export interface MockIdpOptions {
  tenantId?: string;
  /** The RTS app registration's client id (Entra `aud` of the tokens RTS accepts). */
  rtsClientId?: string;
  /** The CLI's public client id (`idp.allowed_public_client_ids`). */
  cliClientId?: string;
  rtsRedirectUris?: string[];
  signinScope?: string;
  accessGroupId?: string;
  adminGroupId?: string;
  /** Device-code lifetime (tests use 10 s). */
  deviceCodeTtlSeconds?: number;
  /** The polling interval reported to device-flow clients (default 5, as Entra; tests use 1). */
  deviceCodeIntervalSeconds?: number;
  /** Interface for the IdP and Graph listener (default 127.0.0.1). */
  host?: string;
  port?: number;
  /** The test-control API always binds 127.0.0.1; only the port is configurable. */
  controlPort?: number;
  /** The externally visible base URL, when it differs from http://host:port (containers). */
  publicBaseUrl?: string;
  /** The first RTS client secret (default: random). */
  clientSecret?: string;
}

export interface MintOptions {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  expiresInSeconds?: number;
  /** `foreign`: signed with a per-run key that is NOT in the JWKS (bad-signature tests). */
  signWith?: 'idp' | 'foreign';
}

export interface MockIdpHandle {
  state: MockIdpState;
  patchUser(username: string, patch: UserPatch): MockUser;
  revokeSessions(username: string): Date;
  addClientSecret(): string;
  removeClientSecret(secret: string): boolean;
  setGraphFault(fault: GraphFault): void;
  mintAccessToken(username: string, options?: MintOptions): string;
}

export interface MockIdp extends MockIdpHandle {
  tenantId: string;
  issuer: string;
  /** http://127.0.0.1:<port>, or `publicBaseUrl`. */
  baseUrl: string;
  /** `<baseUrl>/graph`: the control plane's `idp.graph_base_url` (Graph paths follow, /v1.0/…). */
  graphBaseUrl: string;
  rtsClientId: string;
  cliClientId: string;
  signinScope: string;
  accessGroupId: string;
  adminGroupId: string;
  endpoints: {
    discovery: string;
    authorization: string;
    token: string;
    deviceAuthorization: string;
    deviceVerification: string;
    jwks: string;
  };
  control: { url: string; token: string };
  /** The first RTS client secret. */
  clientSecret: string;
  user(username: string): MockUser;
  close(): Promise<void>;
}

/** Graph is served under this path, so one listener serves the IdP and Graph. */
export const GRAPH_PREFIX = '/graph';

const listen = (server: Server, host: string, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

const b64u = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

function signRs256(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(signBytes('sha256', Buffer.from(input), key))}`;
}

export async function startMockIdp(options: MockIdpOptions = {}): Promise<MockIdp> {
  const tenantId = options.tenantId ?? randomUUID();
  const rtsClientId = options.rtsClientId ?? randomUUID();
  const cliClientId = options.cliClientId ?? randomUUID();
  const accessGroupId = options.accessGroupId ?? randomUUID();
  const adminGroupId = options.adminGroupId ?? randomUUID();
  const signinScope = options.signinScope ?? 'api://ralysa-rts/Ralysa.SignIn';
  const host = options.host ?? '127.0.0.1';
  const state = createState({ accessGroupId, adminGroupId });
  if (options.clientSecret !== undefined) state.secrets = new Set([options.clientSecret]);
  const clientSecret = [...state.secrets][0] ?? newClientSecret();
  const controlToken = randomBytes(32).toString('base64url');

  // Per-run keys: the IdP's signing key and a "foreign" key for bad-signature tests.
  const kid = randomBytes(8).toString('hex');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signingJwk = {
    ...(privateKey.export({ format: 'jwk' }) as JWK),
    kid,
    alg: 'RS256',
    use: 'sig',
  } as JWK;
  const foreignKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const publicKey = createPublicKey(createPrivateKey({ key: signingJwk as never, format: 'jwk' }));

  // Listen first: the issuer needs the port.
  const server = createServer();
  const port = await listen(server, host, options.port ?? 0);
  const baseUrl = (options.publicBaseUrl ?? `http://${host}:${String(port)}`).replace(/\/+$/, '');
  const issuer = `${baseUrl}/${tenantId}/v2.0`;
  const graphBaseUrl = `${baseUrl}${GRAPH_PREFIX}`;
  const authority = `${baseUrl}/${tenantId}`;
  const provider = createProvider({
    issuer,
    tenantId,
    rtsClientId,
    cliClientId,
    rtsRedirectUris: options.rtsRedirectUris ?? ['http://127.0.0.1:4100/oauth2/idp/callback'],
    signinScope,
    deviceCodeTtlSeconds: options.deviceCodeTtlSeconds ?? 900,
    deviceCodeIntervalSeconds: options.deviceCodeIntervalSeconds ?? 5,
    signingJwk,
    graphBaseUrl,
    state,
  });
  const callback = provider.callback();
  const hanging = new Set<ServerResponse>();
  const graphContext = {
    state,
    hanging,
    verifyAppToken: async (token: string) => {
      try {
        await jwtVerify(token, publicKey, {
          issuer,
          audience: GRAPH_RESOURCE,
          algorithms: ['RS256'],
        });
        return true;
      } catch {
        return false;
      }
    },
  };

  const prefix = `/${tenantId}`;
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    if (path.startsWith(`${GRAPH_PREFIX}/`)) {
      await handleGraph(req, res, path.slice(GRAPH_PREFIX.length), graphContext);
      return;
    }
    if (path === `${prefix}/v2.0/.well-known/openid-configuration`) {
      // Entra's discovery path; oidc-provider serves it at <mount>/.well-known/….
      Object.assign(req, { originalUrl: `${prefix}/.well-known/openid-configuration` });
      req.url = `/.well-known/openid-configuration${url.search}`;
      await callback(req, res);
      return;
    }
    if (path.startsWith(`${prefix}/interaction/`)) {
      await handleInteraction(req, res, provider, { tenantId, state }, path.slice(prefix.length));
      return;
    }
    if (path.startsWith(`${prefix}/`)) {
      Object.assign(req, { originalUrl: req.url });
      req.url = (req.url ?? '/').slice(prefix.length);
      await callback(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  };
  server.on('request', (req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    });
  });

  const handle: MockIdpHandle = {
    state,
    patchUser: (username, patch) => patchUser(state, username, patch),
    revokeSessions: (username) => revokeSessions(state, username),
    addClientSecret: () => {
      const secret = newClientSecret();
      state.secrets.add(secret);
      return secret;
    },
    removeClientSecret: (secret) => state.secrets.delete(secret),
    setGraphFault: (fault) => {
      state.graphFault = fault;
      if (fault.mode !== 'hang') {
        for (const res of hanging) res.destroy();
        hanging.clear();
      }
    },
    mintAccessToken: (username, mint = {}) => {
      const user = userByName(state, username);
      const iat = Math.floor(Date.now() / 1000);
      const payload = {
        ...userAccessClaims(user, {
          issuer,
          tenantId,
          audience: rtsClientId,
          azp: cliClientId,
          scp: splitScope(signinScope).scp,
          iat,
          exp: iat + (mint.expiresInSeconds ?? 3600),
          graphBaseUrl,
        }),
        ...mint.claims,
      };
      const header = { alg: 'RS256', typ: 'JWT', kid, ...mint.header };
      return signRs256(
        header,
        payload,
        mint.signWith === 'foreign'
          ? foreignKey
          : createPrivateKey({ key: signingJwk as never, format: 'jwk' }),
      );
    },
  };

  const controlServer = createServer((req, res) => {
    handleControl(req, res, handle, controlToken).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const controlPort = await listen(controlServer, '127.0.0.1', options.controlPort ?? 0);

  return {
    ...handle,
    tenantId,
    issuer,
    baseUrl,
    graphBaseUrl,
    rtsClientId,
    cliClientId,
    signinScope,
    accessGroupId,
    adminGroupId,
    clientSecret,
    endpoints: {
      discovery: `${issuer}/.well-known/openid-configuration`,
      authorization: `${authority}/oauth2/v2.0/authorize`,
      token: `${authority}/oauth2/v2.0/token`,
      deviceAuthorization: `${authority}/oauth2/v2.0/devicecode`,
      deviceVerification: `${authority}/oauth2/v2.0/deviceauth`,
      jwks: `${authority}/discovery/v2.0/keys`,
    },
    control: { url: `http://127.0.0.1:${String(controlPort)}`, token: controlToken },
    user: (username) => userByName(state, username),
    close: async () => {
      for (const res of hanging) res.destroy();
      hanging.clear();
      server.closeAllConnections();
      controlServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          controlServer.close(() => {
            resolve();
          });
        }),
      ]);
    },
  };
}
