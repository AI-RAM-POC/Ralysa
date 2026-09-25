// Integration test for the static config gate through the real entry points (code review N1
// follow-up): `node src/cli.ts check-workspaces`, `node src/cli.ts repo-check` and
// `node src/pre-install-gate.ts`, run against a temp repo whose pnpm-workspace.yaml declares a
// pnpm plugin config dependency.
//
// Sentinels: fake `pnpm`, `npm`, `npx`, `pnpx` and `corepack` executables come first on PATH and
// write a marker file if anything calls them, and the registry variables point at a closed local
// port. The checks must fail cleanly with the finding, and the marker must not exist.
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFixtureRepo } from './fixture-repo.ts';
import { cleanEnv, copyRepo, REAL_ROOT } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const SRC = join(REAL_ROOT, 'tooling', 'repo-scripts', 'src');
const EVIL_YAML = `packages:
  - "apps/*"
  - "packages/*"
  - "services/*"
  - "tooling/*"
strictDepBuilds: true
configDependencies:
  pnpm-plugin-evil: "1.0.0+sha512-${'A'.repeat(86)}=="
`;

function sentinel(): { env: NodeJS.ProcessEnv; marker: string } {
  const dir = makeTempDir('ralysa-shims-');
  const marker = join(dir, 'CALLED');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const tool of ['pnpm', 'npm', 'npx', 'pnpx', 'corepack']) {
    const shim = join(dir, 'bin', tool);
    writeFileSync(shim, `#!/bin/sh\necho "${tool} $*" >> "${marker}"\nexit 97\n`);
    chmodSync(shim, 0o755);
  }
  const unreachable = 'http://127.0.0.1:9/';
  const env = cleanEnv({
    PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
    npm_config_registry: unreachable,
    pnpm_config_registry: unreachable,
    COREPACK_NPM_REGISTRY: unreachable,
  });
  return { env, marker };
}

function run(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('static config gate through the real CLI (no pnpm, no network)', () => {
  it('positive control: the sentinel does record a pnpm call', () => {
    const { env, marker } = sentinel();
    const result = spawnSync('pnpm', ['--version'], { env, encoding: 'utf8' });
    expect(result.status).toBe(97);
    expect(existsSync(marker)).toBe(true);
  });

  it('the orchestrator attack: configDependencies appended to the real pnpm-workspace.yaml', () => {
    const copy = copyRepo('ralysa-attack-');
    appendFileSync(
      join(copy, 'pnpm-workspace.yaml'),
      `\nconfigDependencies:\n  pnpm-plugin-evil: "1.0.0+sha512-AAAA"\n`,
    );
    const { env, marker } = sentinel();
    const { status, output } = run(join(SRC, 'cli.ts'), ['check-workspaces'], copy, env);
    expect(status, output).toBe(1);
    expect(output).toContain('configDependencies.pnpm-plugin-evil = "1.0.0+sha512-AAAA"');
    expect(output).not.toMatch(/\n\s+at .+:\d+:\d+/);
    expect(existsSync(marker)).toBe(false);
  });

  it('check-workspaces fails cleanly on a pnpm plugin config dependency', () => {
    const repo = makeFixtureRepo({ workspaceYaml: EVIL_YAML });
    const { env, marker } = sentinel();
    const { status, output } = run(join(SRC, 'cli.ts'), ['check-workspaces'], repo.root, env);
    expect(status, output).toBe(1);
    expect(output).toContain('[pnpm/config-dependencies] pnpm-workspace.yaml');
    expect(output).toContain('pnpm-plugin-evil');
    expect(output).toContain('pnpm plugin name');
    expect(output).not.toMatch(/\n\s+at .+:\d+:\d+/); // no stack trace: a clean exit, not a crash
    expect(existsSync(marker), 'a pnpm/npm/corepack shim was called').toBe(false);
  });

  it('repo-check stops after the config gate', () => {
    const repo = makeFixtureRepo({ workspaceYaml: EVIL_YAML });
    const { env, marker } = sentinel();
    const { status, output } = run(join(SRC, 'cli.ts'), ['repo-check'], repo.root, env);
    expect(status, output).toBe(1);
    expect(output).toContain('✗ config-gate');
    expect(output).toContain('Stopping');
    expect(output).not.toContain('check-tsrefs');
    expect(existsSync(marker)).toBe(false);
  });

  it('a clean repo passes check-workspaces without pnpm on PATH ever being called', () => {
    const repo = makeFixtureRepo();
    const { env, marker } = sentinel();
    const { status, output } = run(join(SRC, 'cli.ts'), ['check-workspaces'], repo.root, env);
    expect(status, output).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  describe('pre-install-gate.ts needs no installed packages', () => {
    // A copy of src/ in a temp folder with no node_modules above it: any import of a package
    // (yaml, zod, typescript, @ralysa/*) would fail with ERR_MODULE_NOT_FOUND.
    const isolated = makeTempDir('ralysa-gate-src-');
    cpSync(SRC, join(isolated, 'src'), { recursive: true });
    const gate = join(isolated, 'src', 'pre-install-gate.ts');

    it('fails on the plugin config dependency', () => {
      const repo = makeFixtureRepo({ workspaceYaml: EVIL_YAML });
      const { env, marker } = sentinel();
      const { status, output } = run(gate, [], repo.root, env);
      expect(status, output).toBe(1);
      expect(output).toContain('pnpm-plugin-evil');
      expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(existsSync(marker)).toBe(false);
    });

    it('passes a clean repo', () => {
      const repo = makeFixtureRepo();
      const { env, marker } = sentinel();
      const { status, output } = run(gate, [], repo.root, env);
      expect(status, output).toBe(0);
      expect(output).toContain('✓ pre-install config gate');
      expect(existsSync(marker)).toBe(false);
    });

    it('passes the real repository', () => {
      const { env } = sentinel();
      const { status, output } = run(gate, [], REAL_ROOT, env);
      expect(status, output).toBe(0);
    });

    // Code review R3-1: the reviewer's lone-CR probes, through the real entry point.
    it.each([
      [
        'configDependencies',
        `packages:\n  - "tooling/*"\n# reviewed\rconfigDependencies:\r  pnpm-plugin-zzzprobe: '1.0.0+sha512-AAAA'\n`,
      ],
      ['pnpmfile', 'packages:\n  - "tooling/*"\n# note\rpnpmfile: probe.cjs\n'],
    ])('fails closed on a lone CR hiding %s', (_name, yaml) => {
      const repo = makeFixtureRepo({ workspaceYaml: yaml });
      repo.write('probe.cjs', "require('fs').writeFileSync(__dirname + '/PNPMFILE_RAN', '1');\n");
      const { env, marker } = sentinel();
      const { status, output } = run(gate, [], repo.root, env);
      expect(status, output).toBe(1);
      expect(output).toContain('[gate/lone-cr] pnpm-workspace.yaml');
      expect(output).not.toMatch(/\n\s+at .+:\d+:\d+/);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(repo.root, 'PNPMFILE_RAN'))).toBe(false);
    });

    it('fails closed on a lone CR in .npmrc', () => {
      const repo = makeFixtureRepo();
      repo.write('.npmrc', 'registry=http://127.0.0.1:9/\n# note\rpnpmfile=probe.cjs\n');
      const { env } = sentinel();
      const { status, output } = run(gate, [], repo.root, env);
      expect(status, output).toBe(1);
      expect(output).toContain('[gate/lone-cr] .npmrc');
      expect(output).toContain('[pnpm/pnpmfile]');
    });

    // Code review R3-2: pnpm reads settings from npm_config_* / pnpm_config_* too.
    it.each([
      ['pnpm_config_pnpmfile', 'probe.cjs'],
      ['npm_config_pnpmfile', 'probe.cjs'],
      ['NPM_CONFIG_GLOBAL_PNPMFILE', '/tmp/x.cjs'],
      ['pnpm_config_global-pnpmfile', '/tmp/x.cjs'],
      ['pnpm_config_config_dependencies', '{}'],
      ['npm_config_config-dependencies', '{}'],
      ['NPM_CONFIG_WORKSPACE_DIR', '/tmp/elsewhere'],
      ['PNPM_CONFIG_WORKSPACE_DIR', '/tmp/elsewhere'],
      ['pnpm_config_workspace_dir', '/tmp/elsewhere'],
    ])('fails on the environment variable %s', (name, value) => {
      const repo = makeFixtureRepo();
      const { env, marker } = sentinel();
      const { status, output } = run(gate, [], repo.root, { ...env, [name]: value });
      expect(status, output).toBe(1);
      expect(output).toContain(`[gate/env-config] env ${name}`);
      expect(existsSync(marker)).toBe(false);
    });

    it('passes with the variables pnpm itself exports to scripts', () => {
      const repo = makeFixtureRepo();
      const { env } = sentinel();
      const pnpmOwn = {
        npm_config_user_agent: 'pnpm/11.27.1 npm/? node/v24.21.0 darwin arm64',
        pnpm_config_verify_deps_before_run: 'install',
        npm_config_registry: 'http://127.0.0.1:9/',
      };
      const { status, output } = run(gate, [], repo.root, { ...env, ...pnpmOwn });
      expect(status, output).toBe(0);
    });

    it('fails closed on YAML it does not understand', () => {
      const repo = makeFixtureRepo({
        workspaceYaml:
          'packages: &p\n  - "tooling/*"\nbase: &cfg\n  pnpm-plugin-evil: "1.0.0"\nconfigDependencies: *cfg\n',
      });
      const { env } = sentinel();
      const { status, output } = run(gate, [], repo.root, env);
      expect(status, output).toBe(1);
      expect(output).toContain('gate/unsupported-yaml');
    });
  });
});
