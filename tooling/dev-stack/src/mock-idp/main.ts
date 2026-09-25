// The mock IdP as a long-running process, for manual runs (F-002 design §8.2, §8.3): the compose
// `mock-idp` service (profile `idp`) runs dist/mock-idp/main.js, and
// `node tooling/dev-stack/src/cli.ts mock-idp` runs it on the host. Tests don't use this: they
// call startMockIdp() in-process.
//
//   main.js                                  start; ids default to control-plane.serve.dev.yaml
//   main.js control <METHOD> <path> [json]   call the test-control API with this run's bearer
//
// The test-control API binds 127.0.0.1 (in a container, the container's own loopback) and its
// per-run bearer is written to a mode-0600 file, never logged [SEC-F002-13 e]. Inside the
// container, use `docker compose … exec mock-idp node tooling/dev-stack/dist/mock-idp/main.js
// control GET /users`.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { startMockIdp } from './index.ts';

/** The ids in deploy/docker/dev/control-plane.serve.dev.yaml, so the dev control plane trusts it. */
export const DEV_IDS = {
  tenantId: '0192a0c0-0000-4000-8000-00000000de01',
  rtsClientId: '0192a0c0-0000-4000-8000-00000000de02',
  cliClientId: '0192a0c0-0000-4000-8000-00000000de03',
  accessGroupId: '0192a0c0-0000-4000-8000-00000000de10',
  adminGroupId: '0192a0c0-0000-4000-8000-00000000de11',
  signinScope: 'api://ralysa-rts-dev/Ralysa.SignIn',
  rtsRedirectUri: 'http://127.0.0.1:4100/oauth2/idp/callback',
} as const;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 0 picks a free port (tests); manual runs keep the fixed defaults. */
const Port = z.coerce.number().int().min(0).max(65_535);

export const MainEnv = z
  .object({
    MOCK_IDP_HOST: z.string().default('127.0.0.1'),
    MOCK_IDP_PORT: Port.default(59_400),
    MOCK_IDP_CONTROL_PORT: Port.default(59_401),
    MOCK_IDP_PUBLIC_BASE_URL: z.url().default('http://127.0.0.1:59400'),
    MOCK_IDP_DEVICE_CODE_TTL_S: z.coerce.number().int().min(1).max(3_600).default(900),
    MOCK_IDP_CONTROL_TOKEN_FILE: z
      .string()
      .default(join(tmpdir(), 'ralysa-mock-idp', 'control-token')),
    /** Set by the compose service: lets the IdP listener bind the container's 0.0.0.0. */
    MOCK_IDP_IN_CONTAINER: z.enum(['0', '1']).default('0'),
  })
  .refine((env) => LOOPBACK.has(new URL(env.MOCK_IDP_PUBLIC_BASE_URL).hostname), {
    message: 'MOCK_IDP_PUBLIC_BASE_URL must be a loopback URL',
  });
export type MainEnv = z.infer<typeof MainEnv>;

/** Docker creates /.dockerenv in every container; the host never has it. */
export const runningInContainer = (): boolean => existsSync('/.dockerenv');

/**
 * The environment, validated. The mock is for this machine only: its issuer is a loopback URL,
 * and it binds loopback unless it runs in the dev container (whose published port is 127.0.0.1
 * only). `MOCK_IDP_IN_CONTAINER=1` alone is not enough: the container must be real.
 */
export function parseMainEnv(raw: unknown, inContainer = runningInContainer()): MainEnv {
  const env = MainEnv.parse(raw);
  if (!LOOPBACK.has(env.MOCK_IDP_HOST) && !(env.MOCK_IDP_IN_CONTAINER === '1' && inContainer)) {
    throw new Error(
      'MOCK_IDP_HOST must be loopback, except in the dev container (MOCK_IDP_IN_CONTAINER=1 and /.dockerenv)',
    );
  }
  return env;
}

/**
 * The bearer's directory must be ours alone: created 0700, or already a real directory (not a
 * symlink) owned by this uid with mode 0700. A shared /tmp on Linux could otherwise let another
 * user pre-create it.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${dir} must be a directory owned by this user with mode 0700`);
  }
}

function writeToken(file: string, token: string): void {
  ensurePrivateDir(dirname(file));
  rmSync(file, { force: true });
  // `wx`: O_EXCL, so a file (or symlink) planted after the rm is refused, not followed.
  writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
}

export interface RunningMockIdp {
  /** The test-control port actually bound (differs from the env when it asked for 0). */
  controlPort: number;
  stop: () => Promise<void>;
}

export async function runMockIdp(env: MainEnv): Promise<RunningMockIdp> {
  const idp = await startMockIdp({
    ...DEV_IDS,
    rtsRedirectUris: [DEV_IDS.rtsRedirectUri],
    host: env.MOCK_IDP_HOST,
    port: env.MOCK_IDP_PORT,
    controlPort: env.MOCK_IDP_CONTROL_PORT,
    publicBaseUrl: env.MOCK_IDP_PUBLIC_BASE_URL,
    deviceCodeTtlSeconds: env.MOCK_IDP_DEVICE_CODE_TTL_S,
  });
  writeToken(env.MOCK_IDP_CONTROL_TOKEN_FILE, idp.control.token);
  console.log(`mock-idp: issuer ${idp.issuer}`);
  console.log(`mock-idp: graph ${idp.graphBaseUrl}`);
  console.log(
    `mock-idp: test-control ${idp.control.url} (bearer in ${env.MOCK_IDP_CONTROL_TOKEN_FILE})`,
  );
  console.log(
    'mock-idp: the RTS client secret is per run; get one with `control POST /client-secrets` and store it at kv/ralysa/control-plane/idp-client-secret',
  );
  return {
    controlPort: Number(new URL(idp.control.url).port),
    stop: async () => {
      rmSync(env.MOCK_IDP_CONTROL_TOKEN_FILE, { force: true });
      await idp.close();
    },
  };
}

export async function controlCommand(env: MainEnv, args: string[]): Promise<number> {
  const [method = '', path = '', body] = args;
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) || !path.startsWith('/')) {
    console.error('usage: main.js control <GET|POST|PUT|PATCH|DELETE> </path> [json]');
    return 2;
  }
  const token = readFileSync(env.MOCK_IDP_CONTROL_TOKEN_FILE, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${String(env.MOCK_IDP_CONTROL_PORT)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  });
  console.log(`${String(response.status)} ${await response.text()}`);
  return response.ok ? 0 : 1;
}

export async function main(argv: string[]): Promise<void> {
  const env = parseMainEnv(process.env);
  if (argv[0] === 'control') {
    process.exitCode = await controlCommand(env, argv.slice(1));
    return;
  }
  const { stop } = await runMockIdp(env);
  const shutdown = () => {
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
