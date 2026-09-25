// The oidc-provider configuration that makes the mock look like an Entra v2 tenant (F-002 design
// §8.3). Mounted under /<tenant>, with Entra's endpoint paths:
//   /<tenant>/v2.0/.well-known/openid-configuration  (aliased; issuer /<tenant>/v2.0)
//   /<tenant>/oauth2/v2.0/{authorize,token,devicecode,deviceauth}
//   /<tenant>/discovery/v2.0/keys
// Clients: the CLI (public, device code only) and RTS (confidential: authorization code with PKCE
// and client credentials for Graph). RTS's secret is checked against the state's set of valid
// secrets, so two can be valid at once while one rotates.
//
// Access tokens are JWTs signed RS256 with a per-run key, header {typ: JWT, alg, kid}, and an
// Entra-shaped payload (claims.ts). The sign-in page asks for a fixture username only: there is
// no password field, and MFA is implied by the fixture's `amr`.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, {
  type Configuration,
  type KoaContextWithOIDC,
  type JWK,
  errors,
} from 'oidc-provider';
import {
  GRAPH_RESOURCE,
  appAccessClaims,
  groupClaims,
  pairwiseSub,
  userAccessClaims,
} from './claims.ts';
import { type MockIdpState, secretMatches, userByName, userByOid } from './state.ts';

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface ProviderSetup {
  issuer: string;
  tenantId: string;
  rtsClientId: string;
  cliClientId: string;
  rtsRedirectUris: string[];
  /** The RTS API scope, e.g. `api://ralysa-rts/Ralysa.SignIn`. */
  signinScope: string;
  deviceCodeTtlSeconds: number;
  /** The `interval` the device authorization response reports (Entra: 5). */
  deviceCodeIntervalSeconds: number;
  signingJwk: JWK;
  graphBaseUrl: string;
  state: MockIdpState;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;

/** `api://ralysa-rts/Ralysa.SignIn` → resource `api://ralysa-rts`, scope value `Ralysa.SignIn`. */
export function splitScope(signinScope: string): { resource: string; scp: string } {
  const at = signinScope.lastIndexOf('/');
  return { resource: signinScope.slice(0, at), scp: signinScope.slice(at + 1) };
}

export function createProvider(setup: ProviderSetup): Provider {
  const { state, tenantId, rtsClientId, issuer, graphBaseUrl } = setup;
  const { resource: rtsResource, scp } = splitScope(setup.signinScope);
  const graphScope = `${GRAPH_RESOURCE}/.default`;

  const configuration: Configuration = {
    clients: [
      {
        client_id: setup.cliClientId,
        client_name: 'Ralysa CLI',
        token_endpoint_auth_method: 'none',
        grant_types: [DEVICE_CODE_GRANT],
        response_types: [],
        redirect_uris: [],
      },
      {
        client_id: rtsClientId,
        client_name: 'Ralysa RTS',
        // Never handed out: compareClientSecret below checks the state's valid secrets instead.
        client_secret: randomBytes(32).toString('base64url'),
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'client_credentials'],
        response_types: ['code'],
        redirect_uris: setup.rtsRedirectUris,
      },
    ],
    jwks: { keys: [setup.signingJwk] },
    cookies: { keys: [randomBytes(32).toString('base64url')] },
    findAccount: (_ctx, sub) => {
      const user = userByOid(state, sub);
      if (user === undefined) return undefined;
      return {
        accountId: sub,
        claims: () => ({
          sub: pairwiseSub(user.oid, rtsClientId),
          oid: user.oid,
          tid: tenantId,
          ver: '2.0',
          name: user.displayName,
          preferred_username: user.upn,
          email: user.upn,
          ...groupClaims(user, graphBaseUrl),
        }),
      };
    },
    claims: {
      openid: ['sub', 'oid', 'tid', 'ver', 'groups', '_claim_names', '_claim_sources'],
      profile: ['name', 'preferred_username'],
      email: ['email'],
    },
    scopes: ['openid', 'profile', 'email'],
    conformIdTokenClaims: false,
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      revocation: { enabled: false },
      introspection: { enabled: false },
      clientCredentials: { enabled: true },
      deviceFlow: {
        enabled: true,
        userCodeInputSource: (ctx, form, _out, err) => {
          ctx.body = page(
            'Enter code',
            `${err === undefined ? '' : '<p id="error">The code is not valid.</p>'}${form}<button type="submit" form="op.deviceInputForm">Next</button>`,
          );
        },
        userCodeConfirmSource: (ctx, form, _client, _deviceInfo, userCode) => {
          ctx.body = page(
            'Confirm',
            `<p>Code <code>${escapeHtml(userCode)}</code></p>${form}<button type="submit" form="op.deviceConfirmForm">Continue</button>`,
          );
        },
        successSource: (ctx) => {
          ctx.body = page('Signed in', '<p id="device-success">You can close this window.</p>');
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: (ctx) => {
          const scope = ctx.oidc.params?.scope;
          const requested = typeof scope === 'string' ? scope : '';
          if (requested.split(' ').includes(graphScope)) return GRAPH_RESOURCE;
          if (requested.split(' ').includes(setup.signinScope)) return rtsResource;
          return undefined;
        },
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator, client) => {
          if (indicator === rtsResource) {
            return {
              scope: setup.signinScope,
              audience: rtsClientId,
              accessTokenTTL: 3600,
              accessTokenFormat: 'jwt',
              jwt: { sign: { alg: 'RS256' } },
            };
          }
          if (indicator === GRAPH_RESOURCE && client.clientId === rtsClientId) {
            return {
              scope: graphScope,
              audience: GRAPH_RESOURCE,
              accessTokenTTL: 3600,
              accessTokenFormat: 'jwt',
              jwt: { sign: { alg: 'RS256' } },
            };
          }
          throw new errors.InvalidTarget();
        },
      },
    },
    pkce: { required: () => true },
    ttl: {
      AccessToken: 3600,
      ClientCredentials: 3600,
      IdToken: 3600,
      AuthorizationCode: 60,
      DeviceCode: setup.deviceCodeTtlSeconds,
      Interaction: 600,
      Session: 3600,
      Grant: 3600,
    },
    interactions: { url: (_ctx, interaction) => `/${tenantId}/interaction/${interaction.uid}` },
    formats: {
      customizers: {
        jwt: (_ctx, token, parts) => {
          const { iat, exp } = parts.payload as { iat: number; exp: number };
          const accountId = 'accountId' in token ? token.accountId : undefined;
          if (typeof accountId === 'string') {
            const user = userByOid(state, accountId);
            if (user === undefined) throw new Error('mock IdP: token for an unknown account');
            parts.payload = userAccessClaims(user, {
              issuer,
              tenantId,
              audience: rtsClientId,
              azp: token.clientId ?? '',
              scp,
              iat,
              exp,
              graphBaseUrl,
            });
          } else {
            parts.payload = appAccessClaims({
              issuer,
              tenantId,
              audience: GRAPH_RESOURCE,
              clientId: token.clientId ?? '',
              iat,
              exp,
            });
          }
          // Entra access tokens are typ JWT, not RFC 9068's at+jwt (RTS checks this, §3.2.5).
          parts.header = { typ: 'JWT' };
          return parts;
        },
      },
    },
    routes: {
      authorization: '/oauth2/v2.0/authorize',
      token: '/oauth2/v2.0/token',
      device_authorization: '/oauth2/v2.0/devicecode',
      code_verification: '/oauth2/v2.0/deviceauth',
      jwks: '/discovery/v2.0/keys',
      end_session: '/oauth2/v2.0/logout',
    },
    renderError: (ctx, out) => {
      ctx.type = 'html';
      ctx.body = page(
        'Error',
        `<p id="error">${escapeHtml(out.error)}</p><p id="error_description">${escapeHtml(out.error_description ?? '')}</p>`,
      );
    },
    clientBasedCORS: () => false,
  };

  const provider = new Provider(issuer, configuration);
  // Entra's device authorization response: `interval` and `message`, and no
  // `verification_uri_complete` (RFC 8628 §3.2 makes it optional; Entra never sends it, so a
  // client must not depend on it).
  provider.use(async (ctx, next) => {
    await next();
    const oidc = (ctx as Partial<KoaContextWithOIDC>).oidc;
    if (oidc?.route !== 'device_authorization' || ctx.status !== 200) return;
    const body = { ...(ctx.body as Record<string, unknown>) };
    delete body.verification_uri_complete;
    ctx.body = {
      ...body,
      interval: setup.deviceCodeIntervalSeconds,
      message: `To sign in, use a web browser to open the page ${String(body.verification_uri)} and enter the code ${String(body.user_code)} to authenticate.`,
    };
  });
  // RTS's secret is checked against every currently valid secret (two during a rotation). The
  // CLI is a public client (`none`), so no other client ever reaches this.
  provider.Client.prototype.compareClientSecret = function compareClientSecret(
    this: InstanceType<typeof provider.Client>,
    actual: string,
  ) {
    return this.clientId === rtsClientId && secretMatches(state, actual);
  };
  return provider;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const html = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

const loginPage = (tenantId: string, uid: string, error?: string): string =>
  page(
    'Sign in',
    `${error === undefined ? '' : `<p id="error">${escapeHtml(error)}</p>`}<form method="post" action="/${tenantId}/interaction/${escapeHtml(uid)}/login" data-mock-idp="login"><label>Username <input name="username" autocomplete="username" required></label><button type="submit">Sign in</button></form>`,
  );

const clientIp = (req: IncomingMessage): string => {
  const ip = req.socket.remoteAddress ?? '127.0.0.1';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
};

/**
 * The login and consent interaction. Login takes a fixture username only. A disabled user is
 * refused with `access_denied` (AADSTS50057). Consent is implied: whatever the client asked for is
 * granted, as an admin-consented Entra app would be.
 */
export async function handleInteraction(
  req: IncomingMessage,
  res: ServerResponse,
  provider: Provider,
  setup: Pick<ProviderSetup, 'tenantId' | 'state'>,
  rest: string,
): Promise<void> {
  const match = /^\/interaction\/([A-Za-z0-9_-]+)(\/login)?$/.exec(rest);
  if (match === null) {
    html(res, 404, page('Not found', '<p id="error">not_found</p>'));
    return;
  }
  const uid = match[1] ?? '';
  const details = await provider.interactionDetails(req, res);
  if (details.uid !== uid) {
    html(res, 400, page('Error', '<p id="error">interaction mismatch</p>'));
    return;
  }

  if (match[2] === '/login' && req.method === 'POST') {
    const username = (await readForm(req)).get('username') ?? '';
    let user;
    try {
      user = userByName(setup.state, username);
    } catch {
      html(res, 400, loginPage(setup.tenantId, uid, 'Unknown user.'));
      return;
    }
    if (!user.enabled) {
      await provider.interactionFinished(req, res, {
        error: 'access_denied',
        error_description: 'AADSTS50057: The user account is disabled.',
      });
      return;
    }
    user.lastLoginIp = clientIp(req);
    await provider.interactionFinished(
      req,
      res,
      { login: { accountId: user.oid, amr: [...user.amr], remember: false } },
      { mergeWithLastSubmission: false },
    );
    return;
  }

  if (req.method !== 'GET') {
    html(res, 405, page('Error', '<p id="error">method_not_allowed</p>'));
    return;
  }
  if (details.prompt.name === 'login') {
    html(res, 200, loginPage(setup.tenantId, uid));
    return;
  }
  // Consent: grant what is missing.
  const accountId = details.session?.accountId;
  const clientId = String(details.params.client_id);
  const grant =
    details.grantId === undefined
      ? new provider.Grant({ accountId, clientId })
      : ((await provider.Grant.find(details.grantId)) ??
        new provider.Grant({ accountId, clientId }));
  const missing = details.prompt.details as {
    missingOIDCScope?: string[];
    missingOIDCClaims?: string[];
    missingResourceScopes?: Record<string, string[]>;
  };
  if (missing.missingOIDCScope !== undefined)
    grant.addOIDCScope(missing.missingOIDCScope.join(' '));
  if (missing.missingOIDCClaims !== undefined) grant.addOIDCClaims(missing.missingOIDCClaims);
  for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
    grant.addResourceScope(indicator, scopes.join(' '));
  }
  const grantId = await grant.save();
  await provider.interactionFinished(
    req,
    res,
    { consent: details.grantId === undefined ? { grantId } : {} },
    { mergeWithLastSubmission: true },
  );
}

export type { KoaContextWithOIDC };
