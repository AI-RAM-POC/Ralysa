import { describe, expect, it } from 'vitest';
import { REQUIRED_SCRIPTS } from '../src/contracts/workspace.ts';
import { parseSummary, renderSummary } from '../src/summary.ts';

function task(
  pkg: string,
  dir: string,
  name: string,
  exitCode: number | undefined,
  status = 'MISS',
) {
  return {
    taskId: `${pkg}#${name}`,
    task: name,
    package: pkg,
    directory: dir,
    cache: { status },
    ...(exitCode === undefined ? {} : { execution: { exitCode } }),
  };
}

const allTasks = (
  pkg: string,
  dir: string,
  overrides: Record<string, [number | undefined, string?]> = {},
) =>
  REQUIRED_SCRIPTS.map((name) => {
    const [exitCode, status] = overrides[name] ?? [0, 'MISS'];
    return task(pkg, dir, name, exitCode, status);
  });

const summary = (tasks: unknown[]) =>
  parseSummary({
    execution: {
      command: 'turbo run lint typecheck test build',
      success: 7,
      failed: 1,
      cached: 1,
      attempted: 8,
    },
    tasks,
    user: 'someone@example.invalid',
    scm: { type: 'git', sha: 'abc' },
  });

describe('summary (AC-1: the run log lists each workspace)', () => {
  it('lists every workspace with each task result, sorted by directory', () => {
    const { markdown, findings } = renderSummary(
      summary([
        ...allTasks('@ralysa/web', 'apps/web', { test: [1], build: [undefined] }),
        ...allTasks('@ralysa/agent-host', 'services/agent-host', { lint: [0, 'HIT'] }),
      ]),
      REQUIRED_SCRIPTS,
    );
    expect(findings).toEqual([]);
    expect(markdown).toContain('| Workspace | Directory | lint | typecheck | test | build |');
    expect(markdown).toContain('| @ralysa/web | apps/web | pass | pass | **FAILED** | not run |');
    expect(markdown).toContain(
      '| @ralysa/agent-host | services/agent-host | pass (cached) | pass | pass | pass |',
    );
    expect(markdown.indexOf('apps/web')).toBeLessThan(markdown.indexOf('services/agent-host'));
    expect(markdown).toContain(
      '2 workspaces, 8 tasks attempted, 7 succeeded (1 from the local cache), 1 failed.',
    );
  });

  it('flags a workspace that is missing a required task', () => {
    const tasks = allTasks('@ralysa/web', 'apps/web').filter((t) => t.task !== 'typecheck');
    const { markdown, findings } = renderSummary(summary(tasks), REQUIRED_SCRIPTS);
    expect(findings).toEqual([
      expect.objectContaining({ rule: 'summary/missing-task', path: 'apps/web' }),
    ]);
    expect(markdown).toContain('### Coverage problems');
  });

  it('never echoes the summary user or scm blocks', () => {
    const { markdown } = renderSummary(
      summary(allTasks('@ralysa/web', 'apps/web')),
      REQUIRED_SCRIPTS,
    );
    expect(markdown).not.toContain('someone@example.invalid');
  });
});
