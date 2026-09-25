// summary (F-001 design §8.2 `quality`): renders a Turbo run summary (.turbo/runs/<id>.json from
// `turbo run … --summarize`) as a workspace × task table for $GITHUB_STEP_SUMMARY, so the run log
// lists every workspace with its result (AC-1). It also fails if any workspace is missing one of
// the required tasks, because Turbo silently skips a package that lacks a script.
// Only `execution` and `tasks` are read: the summary's `user` and `scm` blocks are never echoed.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Finding } from './lib/repo.ts';
import { readJson } from './lib/repo.ts';

const TurboRunSummary = z.looseObject({
  execution: z.looseObject({
    command: z.string(),
    success: z.number(),
    failed: z.number(),
    cached: z.number(),
    attempted: z.number(),
    exitCode: z.number().nullable().optional(),
  }),
  tasks: z.array(
    z.looseObject({
      taskId: z.string(),
      task: z.string(),
      package: z.string(),
      directory: z.string().optional(),
      cache: z.looseObject({ status: z.string() }).optional(),
      execution: z
        .looseObject({ exitCode: z.number().nullable().optional(), error: z.unknown().optional() })
        .optional(),
    }),
  ),
});

export type TurboRunSummary = z.infer<typeof TurboRunSummary>;
export type TaskState = 'pass' | 'cached' | 'failed' | 'not run';

export function parseSummary(value: unknown): TurboRunSummary {
  return TurboRunSummary.parse(value);
}

/** The newest summary file in `<root>/.turbo/runs`. */
export function latestSummaryFile(root: string): string {
  const dir = join(root, '.turbo', 'runs');
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => join(dir, file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const [latest] = files;
  if (latest === undefined)
    throw new Error(`no Turbo run summaries in ${dir}; run turbo with --summarize`);
  return latest;
}

function stateOf(task: TurboRunSummary['tasks'][number]): TaskState {
  const exitCode = task.execution?.exitCode;
  if (task.execution === undefined || exitCode === undefined || exitCode === null) return 'not run';
  if (exitCode !== 0) return 'failed';
  return task.cache?.status === 'HIT' ? 'cached' : 'pass';
}

const LABEL: Record<TaskState, string> = {
  pass: 'pass',
  cached: 'pass (cached)',
  failed: '**FAILED**',
  'not run': 'not run',
};

export interface RenderedSummary {
  markdown: string;
  findings: Finding[];
}

export function renderSummary(
  summary: TurboRunSummary,
  requiredTasks: readonly string[],
): RenderedSummary {
  const taskNames = [...new Set([...requiredTasks, ...summary.tasks.map((t) => t.task)])];
  const rows = new Map<string, { directory: string; states: Map<string, TaskState> }>();
  for (const task of summary.tasks) {
    if (task.package === '//') continue; // root tasks aren't workspaces
    const row = rows.get(task.package) ?? { directory: task.directory ?? '', states: new Map() };
    row.states.set(task.task, stateOf(task));
    rows.set(task.package, row);
  }

  const findings: Finding[] = [];
  const sorted = [...rows.entries()].sort(([, a], [, b]) => a.directory.localeCompare(b.directory));
  for (const [name, row] of sorted) {
    for (const task of requiredTasks) {
      if (!row.states.has(task)) {
        findings.push({
          rule: 'summary/missing-task',
          path: row.directory || name,
          message: `${name} has no "${task}" task in this run, so it wasn't checked (AC-1)`,
        });
      }
    }
  }

  // Counted from the task states rather than execution.success, which Turbo reports as 0 when
  // every task is replayed from the cache.
  const { execution } = summary;
  const states = summary.tasks.filter((t) => t.package !== '//').map(stateOf);
  const count = (...wanted: TaskState[]): number => states.filter((s) => wanted.includes(s)).length;
  const lines = [
    '## Workspace results',
    '',
    `\`${execution.command}\`: ${String(rows.size)} workspaces, ${String(states.length)} tasks, ` +
      `${String(count('pass', 'cached'))} succeeded (${String(count('cached'))} from the local cache), ` +
      `${String(count('failed'))} failed, ${String(count('not run'))} not run.`,
    '',
    `| Workspace | Directory | ${taskNames.join(' | ')} |`,
    `|---|---|${taskNames.map(() => '---').join('|')}|`,
    ...sorted.map(
      ([name, row]) =>
        `| ${name} | ${row.directory} | ${taskNames.map((task) => (row.states.has(task) ? LABEL[row.states.get(task) ?? 'not run'] : '–')).join(' | ')} |`,
    ),
    '',
  ];
  if (findings.length > 0) {
    lines.push('### Coverage problems', '', ...findings.map((f) => `- ${f.message}`), '');
  }
  return { markdown: lines.join('\n'), findings };
}

export function summaryFromFile(file: string, requiredTasks: readonly string[]): RenderedSummary {
  return renderSummary(parseSummary(readJson(file)), requiredTasks);
}
