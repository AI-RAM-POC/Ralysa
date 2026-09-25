// Integration-test harness (F-002 design §8.1): finds the running dev stack, or explains why the
// service-backed tests can't run. Unit `test` never imports this.
//
// Without the stack, `devStackOrSkip()` returns undefined and prints one message saying what to
// start, so `test:integration` skips cleanly on a laptop without Docker. In CI (or with
// RALYSA_REQUIRE_DEV_STACK=1) a missing stack is an error instead, so the `integration` job can
// never pass by skipping.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { appRoleCredentials, appRoleLogin, isBootstrapped } from '../bootstrap-vault.ts';
import { readEnvFile } from '../env.ts';
import { type BaoRequest, baoClient } from '../openbao.ts';
import { DEFAULT_ENV_FILE, OPENBAO_ADDR, POSTGRES, PROBE_POLICY, TRANSIT_MOUNT } from '../stack.ts';

export { appRoleLogin } from '../bootstrap-vault.ts';
export { type BaoRequest, type BaoResponse, baoClient, dataOf, expectOk } from '../openbao.ts';
export { CP_KV_PREFIX, KV_MOUNT, OPENBAO_ADDR, TRANSIT_MOUNT } from '../stack.ts';

export interface DevStack {
  postgres: { host: string; port: number; database: string; user: string; password: string };
  openbao: { addr: string; rootToken: string };
}

export type Probe = { ok: true; stack: DevStack } | { ok: false; reason: string };

export const START_HINT =
  'start it with: node tooling/dev-stack/src/cli.ts env && docker compose -f deploy/docker/dev/compose.yaml --env-file deploy/docker/dev/.env up -d --wait && node tooling/dev-stack/src/cli.ts bootstrap';

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

export async function probeDevStack(envFile: string = DEFAULT_ENV_FILE): Promise<Probe> {
  if (!existsSync(envFile)) return { ok: false, reason: `${envFile} does not exist` };
  const env = readEnvFile(envFile);
  if (env.POSTGRES_PASSWORD === undefined || env.BAO_DEV_ROOT_TOKEN_ID === undefined) {
    return { ok: false, reason: `${envFile} is incomplete; regenerate it with env --force` };
  }
  if (!(await tcpReachable(POSTGRES.host, POSTGRES.port, 1500))) {
    return {
      ok: false,
      reason: `Postgres is not reachable on ${POSTGRES.host}:${String(POSTGRES.port)}`,
    };
  }
  const root = baoClient(OPENBAO_ADDR, env.BAO_DEV_ROOT_TOKEN_ID, 3000);
  try {
    const mounts = await root('GET', 'sys/mounts');
    if (mounts.status === 403)
      return { ok: false, reason: 'the OpenBao root token in .env was rejected' };
    if (mounts.status !== 200)
      return { ok: false, reason: `OpenBao answered ${String(mounts.status)}` };
    const data = (mounts.body?.data ?? {}) as Record<string, unknown>;
    if (data[`${TRANSIT_MOUNT}/`] === undefined) {
      return {
        ok: false,
        reason: 'OpenBao is up but not bootstrapped (run the bootstrap command)',
      };
    }
    // A bootstrap that stopped half-way (for example psql failed after the OpenBao part) leaves
    // the Transit mount but no Postgres roles: require the policy and the completion marker.
    if ((await root('GET', `sys/policies/acl/${PROBE_POLICY}`)).status !== 200) {
      return {
        ok: false,
        reason: `OpenBao has no ${PROBE_POLICY} policy (run the bootstrap command)`,
      };
    }
    if (!(await isBootstrapped(root))) {
      return {
        ok: false,
        reason:
          'the last bootstrap did not finish (the Postgres roles step never completed); run the bootstrap command again',
      };
    }
  } catch {
    return { ok: false, reason: `OpenBao is not reachable at ${OPENBAO_ADDR}` };
  }
  return {
    ok: true,
    stack: {
      postgres: { ...POSTGRES, password: env.POSTGRES_PASSWORD },
      openbao: { addr: OPENBAO_ADDR, rootToken: env.BAO_DEV_ROOT_TOKEN_ID },
    },
  };
}

export function devStackRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env.RALYSA_REQUIRE_DEV_STACK === '1' || env.CI === '1' || env.CI === 'true';
}

let announced = false;

/** The stack, or undefined (after one explanatory message) when tests should skip. */
export async function devStackOrSkip(
  options: { envFile?: string; env?: Record<string, string | undefined> } = {},
): Promise<DevStack | undefined> {
  const probe = await probeDevStack(options.envFile);
  if (probe.ok) return probe.stack;
  if (devStackRequired(options.env)) {
    throw new Error(
      `dev stack required (CI or RALYSA_REQUIRE_DEV_STACK=1): ${probe.reason}; ${START_HINT}`,
    );
  }
  if (!announced) {
    announced = true;
    console.warn(
      `[dev-stack] integration tests skipped: ${probe.reason}. To run them, ${START_HINT}`,
    );
  }
  return undefined;
}

export function rootBao(stack: DevStack): BaoRequest {
  return baoClient(stack.openbao.addr, stack.openbao.rootToken);
}

/** A client token for an entry-point or service AppRole (fresh single-use secret_id). */
export async function roleBao(
  stack: DevStack,
  role: string,
): Promise<{ token: string; bao: BaoRequest }> {
  const token = await appRoleLogin(rootBao(stack), baoClient(stack.openbao.addr), role);
  return { token, bao: baoClient(stack.openbao.addr, token) };
}

/** role_id and a fresh single-use secret_id for an AppRole, for adapters that log in themselves. */
export function roleCredentials(
  stack: DevStack,
  role: string,
): Promise<{ roleId: string; secretId: string }> {
  return appRoleCredentials(rootBao(stack), role);
}

/** A unique, lowercase name for per-test OpenBao keys and paths, so test files run in parallel. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}
