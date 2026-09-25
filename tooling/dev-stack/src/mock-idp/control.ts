// The mock IdP's test-control API (F-002 design §8.3; SEC-F002-13 e). It listens on 127.0.0.1
// only, on its own port, and every request needs the per-run bearer token. Never part of any
// shipped workspace. JSON in, JSON out; every body is validated with zod.
//
//   GET    /users                          fixture users (no secrets)
//   PATCH  /users/:username                enable, disable, delete in Graph, groups, amr, acrs, ipaddr
//   POST   /users/:username/revoke-sessions   Entra "revoke sessions" (signInSessionsValidFrom = now)
//   POST   /client-secrets                 add an RTS client secret → { secret }
//   DELETE /client-secrets                 { secret } → remove it
//   PUT    /graph-fault                    { mode: none | error | hang, status?, latencyMs? }
//   POST   /tokens                         mint an Entra-shaped access token directly (load tests)
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { MockIdpHandle } from './index.ts';
import { UnknownUserError } from './state.ts';

const UserPatchBody = z.strictObject({
  enabled: z.boolean().optional(),
  deletedInGraph: z.boolean().optional(),
  groups: z.array(z.string().max(256)).max(500).optional(),
  groupClaimOverride: z.array(z.string().max(256)).max(500).nullable().optional(),
  amr: z.array(z.string().max(32)).max(10).optional(),
  acrs: z.array(z.string().max(32)).max(10).nullable().optional(),
  ipaddr: z.string().max(64).nullable().optional(),
  displayName: z.string().max(256).optional(),
});

const GraphFaultBody = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none'), latencyMs: z.int().min(0).max(60_000).optional() }),
  z.strictObject({
    mode: z.literal('error'),
    status: z.int().min(400).max(599),
    latencyMs: z.int().min(0).max(60_000).optional(),
  }),
  z.strictObject({ mode: z.literal('hang') }),
]);

const SecretBody = z.strictObject({ secret: z.string().min(1).max(256) });

const MintBody = z.strictObject({
  username: z.string().max(64),
  claims: z.record(z.string(), z.unknown()).optional(),
  header: z.record(z.string(), z.unknown()).optional(),
  expiresInSeconds: z.int().min(-86_400).max(86_400).optional(),
  signWith: z.enum(['idp', 'foreign']).optional(),
});

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as unknown);
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  idp: MockIdpHandle,
  token: string,
): Promise<void> {
  if (!bearerMatches(req.headers.authorization, token)) {
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  const path = new URL(req.url ?? '/', 'http://control').pathname;
  try {
    if (path === '/users' && req.method === 'GET') {
      send(
        res,
        200,
        [...idp.state.users.values()].map((u) => ({
          username: u.username,
          oid: u.oid,
          displayName: u.displayName,
          upn: u.upn,
          enabled: u.enabled,
          deletedInGraph: u.deletedInGraph,
          groups: u.groups,
        })),
      );
      return;
    }
    const user = /^\/users\/([a-z]+)(\/revoke-sessions)?$/.exec(path);
    if (user !== null && user[2] === undefined && req.method === 'PATCH') {
      const body = UserPatchBody.parse(await readJson(req));
      const updated = idp.patchUser(user[1] ?? '', body);
      send(res, 200, { username: updated.username, oid: updated.oid });
      return;
    }
    if (user !== null && user[2] !== undefined && req.method === 'POST') {
      const at = idp.revokeSessions(user[1] ?? '');
      send(res, 200, { signInSessionsValidFromDateTime: at.toISOString() });
      return;
    }
    if (path === '/client-secrets' && req.method === 'POST') {
      send(res, 201, { secret: idp.addClientSecret() });
      return;
    }
    if (path === '/client-secrets' && req.method === 'DELETE') {
      const { secret } = SecretBody.parse(await readJson(req));
      send(res, idp.removeClientSecret(secret) ? 200 : 404, {});
      return;
    }
    if (path === '/graph-fault' && req.method === 'PUT') {
      idp.setGraphFault(GraphFaultBody.parse(await readJson(req)));
      send(res, 200, {});
      return;
    }
    if (path === '/tokens' && req.method === 'POST') {
      const body = MintBody.parse(await readJson(req));
      send(res, 201, {
        access_token: idp.mintAccessToken(body.username, {
          ...(body.claims === undefined ? {} : { claims: body.claims }),
          ...(body.header === undefined ? {} : { header: body.header }),
          ...(body.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: body.expiresInSeconds }),
          ...(body.signWith === undefined ? {} : { signWith: body.signWith }),
        }),
      });
      return;
    }
    send(res, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      send(res, 400, { error: 'invalid_request' });
    } else if (error instanceof UnknownUserError) {
      send(res, 404, { error: 'unknown_user' });
    } else {
      send(res, 500, { error: 'internal' });
    }
  }
}
