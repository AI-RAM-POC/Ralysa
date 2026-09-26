// TC-F-001-41: every case in guard-bash.fixtures.json gives the expected verdict, and every block
// names the expected rule id (F-001 design §6.3.4). Run with `node --test .claude/hooks/test/`.
//
// Each case runs the real hook as a subprocess, the way Claude Code does: the hook JSON on stdin,
// the verdict in the exit code (0 allow, 2 block) and the reason on stderr. The repository state
// is a temp repo with a local bare `origin`; gh is a stub on PATH that answers from
// gh-scenarios.json, so no case reaches GitHub. User and system git config are isolated.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '..', 'guard-bash.mjs');
const ROOT = resolve(HERE, '..', '..', '..');
const STUBS = join(HERE, 'stubs');
const FIXTURES = JSON.parse(readFileSync(join(HERE, 'guard-bash.fixtures.json'), 'utf8')).cases;
const GH = JSON.parse(readFileSync(join(HERE, 'gh-scenarios.json'), 'utf8'));
const REQUIRED = JSON.parse(readFileSync(join(ROOT, '.github', 'required-checks.json'), 'utf8'));

/** Design §6.3.4 ids T15 must cover: 1-35 and 40-64 (36-39 are T17's). */
export const DESIGN_IDS = [...Array.from({ length: 35 }, (_, i) => i + 1), ...Array.from({ length: 25 }, (_, i) => i + 40)];

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Git config isolation for everything the test and the hook run. */
function baseEnv(home) {
  const globalConfig = join(home, 'gitconfig');
  writeFileSync(globalConfig, '[user]\n\tname = Guard Test\n\temail = guard@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(GIT_|GH_|GITHUB_TOKEN$)/.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${STUBS}:${process.env.PATH ?? ''}`,
  };
}

function sh(cwd, env, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function commitFile(work, env, path, content, message) {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), content);
  sh(work, env, 'git', ['add', path]);
  sh(work, env, 'git', ['commit', '-q', '-m', message]);
}

/**
 * A temp repo in the state a fixture describes. Always: a bare origin with main, a clone-like
 * working repo on main with origin/main fetched.
 */
export function makeRepo(state = {}) {
  const base = tempDir('guard-bash-');
  const env = baseEnv(base);
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  sh(base, env, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(base, env, 'git', ['init', '-q', '-b', 'main', work]);
  commitFile(work, env, 'README.md', '# fixture\n', 'initial');
  sh(work, env, 'git', ['remote', 'add', 'origin', origin]);
  if (state.tag) {
    const { name, annotated, onMain, releaseRecord, onRemote } = state.tag;
    if (releaseRecord) commitFile(work, env, `docs/releases/${name.replace(/-rc\.\d+$/, '')}.md`, `# ${name}\n`, `release record ${name}`);
    if (!onMain) {
      sh(work, env, 'git', ['checkout', '-q', '-b', 'side']);
      commitFile(work, env, 'side.txt', 'side\n', 'side commit');
    }
    sh(work, env, 'git', annotated ? ['tag', '-a', name, '-m', `Release ${name}`] : ['tag', name]);
    if (!onMain) sh(work, env, 'git', ['checkout', '-q', 'main']);
    sh(work, env, 'git', ['push', '-q', 'origin', 'main']);
    if (onRemote) sh(work, env, 'git', ['push', '-q', 'origin', `refs/tags/${name}`]);
  } else {
    sh(work, env, 'git', ['push', '-q', 'origin', 'main']);
  }
  sh(work, env, 'git', ['fetch', '-q', 'origin']);
  for (const [alias, target] of Object.entries(state.aliases ?? {})) sh(work, env, 'git', ['config', `alias.${alias}`, target]);
  for (const [key, value] of Object.entries(state.config ?? {})) sh(work, env, 'git', ['config', key, value]);
  if (state.branch) {
    sh(work, env, 'git', ['checkout', '-q', '-b', state.branch]);
    if (state.upstream) {
      sh(work, env, 'git', ['config', `branch.${state.branch}.remote`, 'origin']);
      sh(work, env, 'git', ['config', `branch.${state.branch}.merge`, `refs/heads/${state.upstream}`]);
    }
  }
  if (state.detached) sh(work, env, 'git', ['checkout', '-q', '--detach']);
  if (state.originUrl) sh(work, env, 'git', ['remote', 'set-url', 'origin', state.originUrl]);
  return { base, work, env };
}

/**
 * Puts a PR on the test origin for a gh scenario: origin/main gets required-checks.json and the
 * scenario's mainFiles; the PR commit is pushed as refs/pull/12/head. Returns the canned gh
 * answers and the head SHA.
 */
export function setupPr(repo, name) {
  const scenario = GH.scenarios[name];
  if (scenario === undefined) throw new Error(`unknown gh scenario ${name}`);
  const { work, env } = repo;
  const mainFiles = {
    '.github/required-checks.json': `${JSON.stringify(REQUIRED)}\n`,
    'packages/ui/src/index.ts': 'export {};\n',
    '.claude/settings.json': '{}\n',
    ...(scenario.mainFiles ?? {}),
  };
  for (const [path, content] of Object.entries(mainFiles)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  sh(work, env, 'git', ['add', '-A']);
  sh(work, env, 'git', ['commit', '-q', '-m', 'main files']);
  sh(work, env, 'git', ['push', '-q', 'origin', 'main']);
  sh(work, env, 'git', ['fetch', '-q', 'origin']);
  const change = scenario.change ?? GH.base.change;
  sh(work, env, 'git', ['checkout', '-q', '-b', 'pr-branch']);
  for (const path of change.modify ?? []) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), `changed ${path}\n`);
  }
  for (const [from, to] of change.rename ?? []) {
    mkdirSync(dirname(join(work, to)), { recursive: true });
    sh(work, env, 'git', ['mv', from, to]);
  }
  for (let n = 0; n < (change.many ?? 0); n++) {
    mkdirSync(join(work, 'many'), { recursive: true });
    writeFileSync(join(work, 'many', `file-${n}.txt`), `${n}\n`);
  }
  sh(work, env, 'git', ['add', '-A']);
  sh(work, env, 'git', ['commit', '-q', '-m', 'the PR']);
  const head = sh(work, env, 'git', ['rev-parse', 'HEAD']);
  const changedFiles = sh(work, env, 'git', ['diff', '--name-only', '-M', 'origin/main...HEAD']).split('\n').filter(Boolean).length;
  sh(work, env, 'git', ['push', '-q', 'origin', 'HEAD:refs/pull/12/head']);
  sh(work, env, 'git', ['checkout', '-q', 'main']);
  for (const [path, content] of Object.entries(scenario.worktreeFiles ?? {})) writeFileSync(join(work, path), content);
  const replaceHead = (value) => JSON.parse(JSON.stringify(value).replaceAll('<head>', head));
  const pr = replaceHead({ ...GH.base.pr, changedFiles, ...(scenario.prPatch ?? {}) });
  let checks = [
    ...REQUIRED.map((check) => ({ name: check, state: 'SUCCESS', bucket: 'pass' })),
    ...GH.base.extraChecks,
  ];
  for (const [check, bucket] of Object.entries(scenario.checksPatch ?? {})) {
    checks = checks.filter((c) => c.name !== check);
    checks.push({ name: check, state: bucket.toUpperCase(), bucket });
  }
  checks = checks.filter((c) => !(scenario.checksRemove ?? []).includes(c.name));
  return { canned: { pr, checks }, head };
}

/** Runs the hook on one command. Returns { status, stderr, rule }. */
export function runHook(command, cwd, env, hook = HOOK) {
  const r = spawnSync(process.execPath, [hook], {
    cwd,
    env,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }),
    timeout: 60_000,
  });
  const rule = /\[([A-Za-z0-9-]+)\]/.exec(r.stderr ?? '')?.[1] ?? null;
  return { status: r.status, stderr: r.stderr ?? '', rule };
}

/** The temp repo, env and final command for a fixture ('<head>' becomes the PR head SHA). */
export function prepare(fixture) {
  const repo = makeRepo(fixture.cwdState ?? {});
  const env = { ...repo.env };
  let command = fixture.command ?? '';
  if (fixture.stubs?.gh) {
    const { canned, head } = setupPr(repo, fixture.stubs.gh);
    const file = join(repo.base, 'gh.json');
    writeFileSync(file, JSON.stringify(canned));
    env.GUARD_TEST_GH_FILE = file;
    command = command.replaceAll('<head>', head);
  }
  return { cwd: repo.work, env, command, repo };
}

describe('guard-bash fixtures (TC-F-001-41)', () => {
  test('the fixture list covers the design minimum set', () => {
    const ids = new Set(FIXTURES.map((f) => f.id));
    assert.equal(ids.size, FIXTURES.length, 'fixture ids are unique');
    const missing = DESIGN_IDS.filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], `design §6.3.4 cases missing: ${missing.join(', ')}`);
  });

  for (const fixture of FIXTURES) {
    test(`#${fixture.id} ${fixture.expect} ${fixture.command.split('\n')[0]}`, () => {
      const { cwd, env, command } = prepare(fixture);
      const result = runHook(command, cwd, env);
      if (fixture.expect === 'allow') {
        assert.equal(result.status, 0, `expected allow, got exit ${result.status}: ${result.stderr}`);
        assert.equal(result.stderr, '', 'an allowed command prints nothing');
      } else {
        assert.equal(result.status, 2, `expected block, got exit ${result.status}: ${result.stderr}`);
        assert.equal(result.rule, fixture.rule, `expected rule ${fixture.rule}: ${result.stderr}`);
      }
    });
  }
});

describe('guard-bash hook contract', () => {
  test('other tools pass through', () => {
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/x' } }),
    });
    assert.equal(r.status, 0);
  });

  test('unreadable input blocks', () => {
    const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', input: 'not json' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /\[internal\]/);
  });

  test('the hook still judges when started through a symlinked path', () => {
    const { cwd, env } = prepare({});
    const link = join(tempDir('guard-bash-link-'), 'hooks');
    symlinkSync(dirname(HOOK), link);
    const result = runHook('git push origin main', cwd, env, join(link, 'guard-bash.mjs'));
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.rule, 'G-2');
  });

  test('a command that does not mention git/gh/pnpm is never blocked by a parse error', () => {
    const { cwd, env } = prepare({});
    assert.equal(runHook("echo 'unterminated", cwd, env).status, 0);
    assert.equal(runHook("echo 'unterminated git push origin main", cwd, env).status, 2);
  });
});
