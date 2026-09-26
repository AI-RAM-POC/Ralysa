// ci-duration (F-001 design §8.3 "Full PR CI run", T18): the wall-clock duration of the last 30
// completed PR runs of the CI workflow, as p50 and p95, against the budget (p50 ≤ 10 min, p95 ≤
// 15 min). Run weekly by the tech lead or a scheduled workflow; on a breach, shard Playwright or
// apply --affected to e2e only.
//   ralysa-repo ci-duration [--limit <1-100>] [--workflow <file.yml>] [--repo <owner/name>]
// Data comes from `gh run list` (GitHub REST API, `actions: read`), so it uses the caller's `gh`
// login and never sees a token itself. The gh output is external input: it is validated with zod.
// Runs that ran to the end, or were stopped by a job timeout, count (conclusion success, failure
// or timed_out): a timed-out run is exactly the slow pipeline this measures. Cancelled runs are
// left out because the PR concurrency group cancels superseded pushes, and those partial runs
// would pull the percentiles down. The report prints how many runs were left out, by conclusion.
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

export const DEFAULT_LIMIT = 30;
export const DEFAULT_WORKFLOW = 'ci.yml';
/** Budgets in ms (design §8.3): p50 ≤ 10 min, p95 ≤ 15 min over the trailing 30 PR runs. */
export const BUDGET_MS = { p50: 10 * 60_000, p95: 15 * 60_000 } as const;
/** Conclusions of a run that executed to the end or hit a job timeout (review R63-1). */
export const COUNTED_CONCLUSIONS = ['success', 'failure', 'timed_out'] as const;
/** How many runs to ask gh for, so that `limit` runs remain after cancelled ones are dropped. */
const FETCH_LIMIT = 200;

const GhRun = z.looseObject({
  databaseId: z.number().int(),
  conclusion: z.string(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  headBranch: z.string(),
});
const GhRunList = z.array(GhRun);
export type GhRun = z.infer<typeof GhRun>;

export interface RunDuration {
  id: number;
  branch: string;
  conclusion: string;
  ms: number;
}

export interface CiDurationReport {
  runs: RunDuration[];
  /** Runs left out inside the measured window (newer than the oldest counted run), by conclusion. */
  excluded: Record<string, number>;
  p50: number;
  p95: number;
  withinBudget: boolean;
}

export function parseRuns(json: string): GhRun[] {
  return GhRunList.parse(JSON.parse(json) as unknown);
}

/**
 * Nearest-rank percentile: the smallest value with at least p% of the values at or below it.
 * Always one of the inputs, so a p95 of 30 runs is the 29th-fastest run.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of an empty list');
  if (!(p > 0 && p <= 100)) throw new Error(`percentile must be in (0, 100], got ${String(p)}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] as number;
}

/**
 * Walks the runs newest first (gh's order) until `limit` counted runs are found. Returns those
 * with their wall-clock durations, and the runs passed over on the way, counted by conclusion.
 */
export function selectRuns(
  runs: readonly GhRun[],
  limit = DEFAULT_LIMIT,
): { durations: RunDuration[]; excluded: Record<string, number> } {
  const counted: readonly string[] = COUNTED_CONCLUSIONS;
  const durations: RunDuration[] = [];
  const excluded: Record<string, number> = {};
  for (const run of runs) {
    if (durations.length === limit) break;
    if (!counted.includes(run.conclusion)) {
      excluded[run.conclusion] = (excluded[run.conclusion] ?? 0) + 1;
      continue;
    }
    const ms = Date.parse(run.updatedAt) - Date.parse(run.startedAt);
    if (ms < 0) throw new Error(`run ${String(run.databaseId)} ends before it starts`);
    durations.push({ id: run.databaseId, branch: run.headBranch, conclusion: run.conclusion, ms });
  }
  return { durations, excluded };
}

/** The newest `limit` counted runs, with their wall-clock durations. */
export function runDurations(runs: readonly GhRun[], limit = DEFAULT_LIMIT): RunDuration[] {
  return selectRuns(runs, limit).durations;
}

export function ciDurationReport(runs: readonly GhRun[], limit = DEFAULT_LIMIT): CiDurationReport {
  const { durations, excluded } = selectRuns(runs, limit);
  if (durations.length === 0) throw new Error('no completed PR runs to measure');
  const values = durations.map((run) => run.ms);
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  return {
    runs: durations,
    excluded,
    p50,
    p95,
    withinBudget: p50 <= BUDGET_MS.p50 && p95 <= BUDGET_MS.p95,
  };
}

/** `cancelled 3, skipped 1` (sorted by conclusion), or `none`. */
export function formatExcluded(excluded: Readonly<Record<string, number>>): string {
  const entries = Object.entries(excluded).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'none';
  return entries.map(([conclusion, count]) => `${conclusion} ${String(count)}`).join(', ');
}

/** `12m 05s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function formatReport(report: CiDurationReport, limit = DEFAULT_LIMIT): string {
  const verdict = (value: number, budget: number) => (value <= budget ? 'ok' : 'OVER BUDGET');
  const lines = [
    `CI wall clock over the last ${String(report.runs.length)} completed PR runs` +
      (report.runs.length < limit ? ` (fewer than ${String(limit)} available)` : ''),
    `  p50 ${formatDuration(report.p50)}  (budget ${formatDuration(BUDGET_MS.p50)}: ${verdict(report.p50, BUDGET_MS.p50)})`,
    `  p95 ${formatDuration(report.p95)}  (budget ${formatDuration(BUDGET_MS.p95)}: ${verdict(report.p95, BUDGET_MS.p95)})`,
    `  excluded: ${formatExcluded(report.excluded)}`,
  ];
  if (!report.withinBudget) {
    lines.push('Over budget: shard Playwright, or apply --affected to e2e only (design §8.3).');
  }
  return lines.join('\n');
}

export interface CiDurationOptions {
  limit: number;
  workflow: string;
  repo?: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

/** Parses the CLI flags. Throws on anything unexpected, so no free text reaches gh's argv. */
export function parseOptions(args: readonly string[]): CiDurationOptions {
  const options: CiDurationOptions = { limit: DEFAULT_LIMIT, workflow: DEFAULT_WORKFLOW };
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i], args[i + 1]];
    if (value === undefined) throw new Error(`missing value for ${String(name)}`);
    if (name === '--limit') {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 100)
        throw new Error('--limit must be an integer from 1 to 100');
      options.limit = Number(value);
    } else if (name === '--workflow') {
      if (!WORKFLOW_RE.test(value)) throw new Error('--workflow must be a workflow file name');
      options.workflow = value;
    } else if (name === '--repo') {
      if (!REPO_RE.test(value)) throw new Error('--repo must be <owner>/<name>');
      options.repo = value;
    } else {
      throw new Error(`unknown option ${String(name)}`);
    }
  }
  return options;
}

/** The `gh run list` argv (no shell): completed pull_request runs of one workflow, newest first. */
export function ghRunListArgs(options: CiDurationOptions): string[] {
  return [
    'run',
    'list',
    '--workflow',
    options.workflow,
    '--event',
    'pull_request',
    '--status',
    'completed',
    '--limit',
    String(FETCH_LIMIT),
    '--json',
    'databaseId,conclusion,startedAt,updatedAt,headBranch',
    ...(options.repo === undefined ? [] : ['--repo', options.repo]),
  ];
}

export type GhRunner = (args: string[]) => string;

export const runGh: GhRunner = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** Prints the report; returns the exit code (1 when over budget). */
export function ciDuration(args: readonly string[], gh: GhRunner = runGh): number {
  const options = parseOptions(args);
  const report = ciDurationReport(parseRuns(gh(ghRunListArgs(options))), options.limit);
  console.log(formatReport(report, options.limit));
  return report.withinBudget ? 0 : 1;
}
