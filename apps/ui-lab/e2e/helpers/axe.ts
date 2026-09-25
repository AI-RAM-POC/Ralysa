// The axe helper (F-001 design §8.2 "Axe"; AC-10, TC-F-001-20/21). WCAG 2.0/2.1 A and AA rules;
// a test fails on any violation of impact serious or critical. Every violation, whatever its
// impact, is attached to the report as JSON, so moderate findings (e.g. the gallery's nested
// AppShell landmarks, T10-5) stay visible without failing the gate.
import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;
export const BLOCKING_IMPACTS: readonly string[] = ['serious', 'critical'];

export interface Violation {
  id: string;
  impact: string | null;
  help: string;
  targets: string[];
}

export interface AxeScan {
  all: Violation[];
  blocking: Violation[];
}

/** Runs axe on the page, attaches every violation as `axe-<name>.json`, and splits out the blocking ones. */
export async function scanAxe(page: Page, testInfo: TestInfo, name: string): Promise<AxeScan> {
  const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
  const all: Violation[] = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    targets: v.nodes.map((node) => node.target.join(' ')),
  }));
  await testInfo.attach(`axe-${name}.json`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: 'application/json',
  });
  return { all, blocking: all.filter((v) => BLOCKING_IMPACTS.includes(v.impact ?? '')) };
}

/** A readable one-line-per-violation summary for assertion messages. */
export function describeViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `${v.impact ?? '?'} ${v.id}: ${v.help} (${v.targets.slice(0, 3).join(', ')})`)
    .join('\n');
}
