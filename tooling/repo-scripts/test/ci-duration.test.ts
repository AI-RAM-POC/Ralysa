import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUDGET_MS,
  ciDuration,
  ciDurationReport,
  formatDuration,
  formatExcluded,
  formatReport,
  ghRunListArgs,
  type GhRun,
  parseOptions,
  parseRuns,
  percentile,
  runDurations,
} from '../src/ci-duration.ts';

// Synthetic `gh run list --json` output, newest first: 30 counted runs of 20 s × k (k = 1..30,
// shuffled; one of them a failure), 3 cancelled 30 s runs in between, then 2 older 60 min runs
// that fall outside the last 30. No network: gh is never started in these tests.
const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'ci-duration-runs.json'),
  'utf8',
);

function run(id: number, conclusion: string, seconds: number): GhRun {
  const start = Date.UTC(2026, 8, 26, 12, 0, 0) - id * 3_600_000;
  return {
    databaseId: id,
    conclusion,
    headBranch: `feat/F-000-${String(id)}`,
    startedAt: new Date(start).toISOString(),
    updatedAt: new Date(start + seconds * 1000).toISOString(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('percentile (nearest rank)', () => {
  it('returns one of the inputs, ignoring input order', () => {
    const values = [50, 10, 40, 20, 30];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile(values, 100)).toBe(50);
    expect(percentile(values, 1)).toBe(10);
  });

  it('p50 of an even count is the lower middle; p95 of 30 is the 29th', () => {
    const thirty = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile(thirty, 50)).toBe(15);
    expect(percentile(thirty, 95)).toBe(29);
  });

  it('handles a single value and refuses an empty list or a bad p', () => {
    expect(percentile([7], 95)).toBe(7);
    expect(() => percentile([], 50)).toThrow(/empty/);
    expect(() => percentile([1], 0)).toThrow(/percentile/);
    expect(() => percentile([1], 101)).toThrow(/percentile/);
  });
});

describe('ci-duration report (fixture)', () => {
  const runs = parseRuns(FIXTURE);

  it('counts finished runs (success, failure, timed_out) and keeps the newest 30', () => {
    const durations = runDurations(runs);
    expect(runs).toHaveLength(35);
    expect(durations).toHaveLength(30);
    expect(durations.every((d) => d.conclusion !== 'cancelled')).toBe(true);
    expect(durations.some((d) => d.conclusion === 'failure')).toBe(true);
    expect(durations.some((d) => d.branch.includes('old'))).toBe(false);
    expect(durations.map((d) => d.ms).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => (i + 1) * 20_000),
    );
  });

  it('p50 = 5m 00s and p95 = 9m 40s, within budget', () => {
    const report = ciDurationReport(runs);
    expect(report.p50).toBe(300_000);
    expect(report.p95).toBe(580_000);
    expect(report.withinBudget).toBe(true);
    expect(formatReport(report)).toBe(
      [
        'CI wall clock over the last 30 completed PR runs',
        '  p50 5m 00s  (budget 10m 00s: ok)',
        '  p95 9m 40s  (budget 15m 00s: ok)',
        '  excluded: cancelled 3',
      ].join('\n'),
    );
    expect(report.excluded).toEqual({ cancelled: 3 });
  });

  it('a smaller --limit takes the newest runs only', () => {
    const report = ciDurationReport(runs, 3);
    // Newest three counted runs: k = 17, 3, 29 → 340 s, 60 s, 580 s.
    expect(report.runs.map((d) => d.ms)).toEqual([340_000, 60_000, 580_000]);
    expect(report.p50).toBe(340_000);
    // The first cancelled run is older than the third counted one, so none is in this window.
    expect(report.excluded).toEqual({});
    expect(formatReport(report, 3)).toContain('  excluded: none');
  });
});

describe('conclusions (review R63-1)', () => {
  it('counts a timed_out run: it is the slow pipeline the budget is about', () => {
    const report = ciDurationReport([run(1, 'success', 60), run(2, 'timed_out', 20 * 60)]);
    expect(report.runs.map((d) => d.conclusion)).toEqual(['success', 'timed_out']);
    expect(report.p95).toBe(20 * 60_000);
    expect(report.withinBudget).toBe(false);
    expect(report.excluded).toEqual({});
  });

  it('prints the runs left out inside the window, by conclusion, and ignores older ones', () => {
    const runs = [
      run(1, 'cancelled', 30),
      run(2, 'success', 60),
      run(3, 'skipped', 0),
      run(4, 'cancelled', 30),
      run(5, 'action_required', 0),
      run(6, 'failure', 120),
      run(7, 'cancelled', 30), // older than the second counted run: outside a limit of 2
    ];
    const report = ciDurationReport(runs, 2);
    expect(report.runs.map((d) => d.id)).toEqual([2, 6]);
    expect(report.excluded).toEqual({ cancelled: 2, skipped: 1, action_required: 1 });
    expect(formatReport(report, 2)).toContain(
      '  excluded: action_required 1, cancelled 2, skipped 1',
    );
  });

  it('formatExcluded sorts by conclusion and says none when empty', () => {
    expect(formatExcluded({})).toBe('none');
    expect(formatExcluded({ stale: 1, cancelled: 4 })).toBe('cancelled 4, stale 1');
  });
});

describe('budget', () => {
  it('flags p95 over 15 min even when p50 is fine', () => {
    const runs = [
      ...Array.from({ length: 28 }, (_, i) => run(i, 'success', 300)),
      run(28, 'success', 16 * 60),
      run(29, 'failure', 17 * 60),
    ];
    const report = ciDurationReport(runs);
    expect(report.p50).toBe(300_000);
    expect(report.p95).toBe(16 * 60_000);
    expect(report.withinBudget).toBe(false);
    const text = formatReport(report);
    expect(text).toContain('p95 16m 00s  (budget 15m 00s: OVER BUDGET)');
    expect(text).toContain('shard Playwright');
  });

  it('flags p50 over 10 min', () => {
    const report = ciDurationReport(
      Array.from({ length: 5 }, (_, i) => run(i, 'success', 11 * 60)),
    );
    expect(report.withinBudget).toBe(false);
    expect(report.p50).toBeGreaterThan(BUDGET_MS.p50);
  });

  it('exactly on the budget is within it', () => {
    const runs = [run(1, 'success', 10 * 60), run(2, 'success', 15 * 60)];
    expect(ciDurationReport(runs).withinBudget).toBe(true);
  });

  it('says so when fewer runs than the limit exist', () => {
    const report = ciDurationReport([run(1, 'success', 60), run(2, 'cancelled', 1)]);
    expect(report.runs).toHaveLength(1);
    expect(formatReport(report)).toContain('last 1 completed PR runs (fewer than 30 available)');
  });

  it('fails with no counted runs, or a run that ends before it starts', () => {
    expect(() => ciDurationReport([run(1, 'cancelled', 60)])).toThrow(/no completed PR runs/);
    const backwards = { ...run(1, 'success', 60), updatedAt: '2020-01-01T00:00:00Z' };
    expect(() => ciDurationReport([backwards])).toThrow(/ends before it starts/);
  });
});

describe('input validation', () => {
  it('rejects malformed gh output', () => {
    expect(() => parseRuns('{}')).toThrow();
    expect(() => parseRuns('[{"databaseId":1,"conclusion":"success"}]')).toThrow();
    expect(() =>
      parseRuns(
        '[{"databaseId":1,"conclusion":"success","headBranch":"x","startedAt":"yesterday","updatedAt":"2026-09-26T00:00:00Z"}]',
      ),
    ).toThrow();
  });

  it('parses the flags and refuses anything else', () => {
    expect(parseOptions([])).toEqual({ limit: 30, workflow: 'ci.yml' });
    expect(
      parseOptions(['--limit', '10', '--repo', 'AI-RAM-POC/Ralysa', '--workflow', 'soak.yml']),
    ).toEqual({ limit: 10, workflow: 'soak.yml', repo: 'AI-RAM-POC/Ralysa' });
    for (const bad of [
      ['--limit', '0'],
      ['--limit', '101'],
      ['--limit', '3.5'],
      ['--limit'],
      ['--repo', 'owner/name;rm'],
      ['--repo', '--jq'],
      ['--workflow', '../x.yml'],
      ['--json', 'x'],
    ]) {
      expect(() => parseOptions(bad), bad.join(' ')).toThrow();
    }
  });

  it('builds the gh argv: completed pull_request runs of one workflow', () => {
    expect(ghRunListArgs({ limit: 30, workflow: 'ci.yml', repo: 'o/r' })).toEqual([
      'run',
      'list',
      '--workflow',
      'ci.yml',
      '--event',
      'pull_request',
      '--status',
      'completed',
      '--limit',
      '200',
      '--json',
      'databaseId,conclusion,startedAt,updatedAt,headBranch',
      '--repo',
      'o/r',
    ]);
  });
});

describe('ciDuration (fake gh)', () => {
  it('prints the report and exits 0 within budget, 1 over it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const calls: string[][] = [];
    const exit = ciDuration([], (args) => {
      calls.push(args);
      return FIXTURE;
    });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual(['run', 'list', '--workflow', 'ci.yml']);
    expect(log.mock.calls[0]?.[0]).toContain('p95 9m 40s');

    const slow = JSON.stringify([run(1, 'success', 20 * 60)]);
    expect(ciDuration([], () => slow)).toBe(1);
  });
});

describe('formatDuration', () => {
  it('rounds to seconds with two-digit seconds', () => {
    expect(formatDuration(0)).toBe('0m 00s');
    expect(formatDuration(65_400)).toBe('1m 05s');
    expect(formatDuration(599_600)).toBe('10m 00s');
  });
});
