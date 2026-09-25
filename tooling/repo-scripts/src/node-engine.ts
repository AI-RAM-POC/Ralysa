// node-engine (F-001 design §8.2, AR-4 b): does a Node version satisfy the root package.json
// `engines.node`? The CI `ui-e2e` job runs in the Playwright image, which brings its own Node; if
// an image bump ever moves it out of range, the job stops at `check-node-engine.ts` instead of
// failing somewhere obscure, and the E2E global setup repeats the check locally.
// Dependency-free (runs before pnpm). Supports the comparator forms the repo uses
// (">=24.12 <25", ">=24", "24.x"); anything else is an error, not a pass.

type Version = [number, number, number];

function parse(text: string): Version {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`not a version: ${JSON.stringify(text)}`);
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

type Check = (v: Version) => boolean;

/** One comparator: `>=24.12`, `<25`, `=24.1.0`, or an x-range (`24.x`, bare `24`). */
function comparatorCheck(comparator: string): Check {
  const xRange = /^v?(\d+)(?:\.x)?$/.exec(comparator);
  if (xRange) return (v) => v[0] === Number(xRange[1]);
  const op = /^(>=|<=|>|<|=)(v?\d+(?:\.\d+){0,2})$/.exec(comparator);
  if (!op) throw new Error(`unsupported engines comparator: ${JSON.stringify(comparator)}`);
  const bound = parse(op[2] ?? '');
  switch (op[1]) {
    case '>=':
      return (v) => compare(v, bound) >= 0;
    case '>':
      return (v) => compare(v, bound) > 0;
    case '<=':
      return (v) => compare(v, bound) <= 0;
    case '<':
      return (v) => compare(v, bound) < 0;
    default:
      return (v) => compare(v, bound) === 0;
  }
}

/**
 * True when `version` (e.g. "v24.20.0") satisfies every comparator in `range`. Every comparator is
 * parsed before any is evaluated, so an unsupported one always throws.
 */
export function satisfiesEngine(version: string, range: string): boolean {
  const v = parse(version);
  const comparators = range
    .trim()
    .split(/\s+/)
    .filter((c) => c !== '');
  if (comparators.length === 0) throw new Error('empty engines range');
  const checks = comparators.map(comparatorCheck);
  return checks.every((check) => check(v));
}
