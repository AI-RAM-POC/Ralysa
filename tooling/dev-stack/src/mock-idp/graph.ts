// Microsoft Graph stub (F-002 design §6.3, §8.3): the three calls RTS makes, with Entra's error
// shape, app-token authentication, and fault and latency toggles.
//   GET  /v1.0/users/{id}                    accountEnabled, signInSessionsValidFromDateTime; 404
//   POST /v1.0/users/{id}/checkMemberGroups  {groupIds ≤ 20} → the ones the user is in; 404
//   POST /v1.0/users/{id}/getMemberObjects   every group (the overage `_claim_sources` target)
//   GET  /v1.0/groups/{id}                   id, displayName; 404
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { MockUser } from './fixtures.ts';
import { type MockIdpState, userByOid } from './state.ts';

export interface GraphContext {
  state: MockIdpState;
  /** True when the bearer is an app token this mock issued for Graph. */
  verifyAppToken: (token: string) => Promise<boolean>;
  /** Responses held by the `hang` fault, ended when the mock closes. */
  hanging: Set<ServerResponse>;
}

const CheckMemberGroups = z.strictObject({ groupIds: z.array(z.string().max(64)).min(1).max(20) });

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const graphError = (res: ServerResponse, status: number, code: string, message: string): void => {
  send(res, status, { error: { code, message } });
};

const notFound = (res: ServerResponse, id: string): void => {
  graphError(
    res,
    404,
    'Request_ResourceNotFound',
    `Resource '${id}' does not exist or one of its queried reference-property objects are not present.`,
  );
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function findUser(state: MockIdpState, id: string): MockUser | undefined {
  const byOid = userByOid(state, id);
  if (byOid !== undefined) return byOid;
  for (const user of state.users.values()) if (user.upn === id) return user;
  return undefined;
}

export async function handleGraph(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: GraphContext,
): Promise<void> {
  const fault = ctx.state.graphFault;
  if (fault.mode === 'hang') {
    ctx.hanging.add(res);
    res.on('close', () => ctx.hanging.delete(res));
    return;
  }
  if (fault.latencyMs !== undefined && fault.latencyMs > 0) await sleep(fault.latencyMs);
  if (fault.mode === 'error') {
    graphError(res, fault.status, 'serviceNotAvailable', 'Injected fault');
    return;
  }

  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (bearer === undefined || !(await ctx.verifyAppToken(bearer))) {
    graphError(res, 401, 'InvalidAuthenticationToken', 'Access token validation failure.');
    return;
  }

  const user = /^\/v1\.0\/users\/([^/]+)(\/checkMemberGroups|\/getMemberObjects)?$/.exec(path);
  if (user !== null) {
    const id = decodeURIComponent(user[1] ?? '');
    const found = findUser(ctx.state, id);
    if (found === undefined || found.deletedInGraph) {
      notFound(res, id);
      return;
    }
    const action = user[2];
    if (action === undefined && req.method === 'GET') {
      send(res, 200, {
        id: found.oid,
        displayName: found.displayName,
        userPrincipalName: found.upn,
        accountEnabled: found.enabled,
        signInSessionsValidFromDateTime: found.signInSessionsValidFrom.toISOString(),
      });
      return;
    }
    if (action === '/checkMemberGroups' && req.method === 'POST') {
      const body = CheckMemberGroups.safeParse(await readJson(req).catch(() => undefined));
      if (!body.success) {
        graphError(res, 400, 'Request_BadRequest', 'groupIds: 1 to 20 ids required.');
        return;
      }
      send(res, 200, { value: body.data.groupIds.filter((g) => found.groups.includes(g)) });
      return;
    }
    if (action === '/getMemberObjects' && req.method === 'POST') {
      send(res, 200, { value: [...found.groups] });
      return;
    }
  }

  const group = /^\/v1\.0\/groups\/([^/]+)$/.exec(path);
  if (group !== null && req.method === 'GET') {
    const id = decodeURIComponent(group[1] ?? '');
    const found = ctx.state.groups.get(id);
    if (found === undefined) {
      notFound(res, id);
      return;
    }
    send(res, 200, { id: found.id, displayName: found.displayName });
    return;
  }
  graphError(res, 400, 'BadRequest', 'Unsupported request.');
}
