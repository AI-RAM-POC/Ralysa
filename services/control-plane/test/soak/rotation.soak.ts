// TC-F-002-16 (AC-10 soak, F-002-T13): the TC-F-002-15 scenario at production timings for 10
// minutes: key_poll_s = 30, activation_delay_s = 120, the IdP secret polled every 60 s by both
// replicas, at least 1 operation a second. The operator removes the old IdP secret only once every
// replica reports the new version (the runbook). 0 failures; new values in use within 5 minutes.
//
// Run with `pnpm --filter @ralysa/control-plane test:soak` against the dev stack, or through the
// `soak` workflow (workflow_dispatch). The report (counts, timings, kids, versions; no token or
// secret) is written to RALYSA_SOAK_REPORT (default test-results/rotation-soak.json).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import { describe, expect, it } from 'vitest';
import { type ScenarioReport, runRotationScenario } from './rotation-harness.js';

const stack = await devStackOrSkip();
const KEY_POLL_S = 30;
const ACTIVATION_DELAY_S = 120;
const SECRET_POLL_S = 60;
/** AC-10: new credentials in use within 5 minutes of a rotation. */
const AC10_BOUND_MS = 5 * 60 * 1000;
const DURATION_MS = Number(process.env.RALYSA_SOAK_DURATION_MS ?? 10 * 60 * 1000);

describe.skipIf(stack === undefined)('rotation soak (F-002-T13, TC-F-002-16)', () => {
  it(
    'TC-F-002-16: 10 minutes at production timings, ≥ 1 rps, 0 failures, new values in use ≤ 5 min',
    async () => {
      const startedAt = new Date().toISOString();
      const report: ScenarioReport = await runRotationScenario({
        stack: stack!,
        durationMs: DURATION_MS,
        rps: 2,
        keyRotateAtMs: 60_000,
        secretRotateAtMs: 120_000,
        keyPollS: KEY_POLL_S,
        activationDelayS: ACTIVATION_DELAY_S,
        secretPollS: [SECRET_POLL_S, SECRET_POLL_S],
        removeOldSecretWhen: 'all_replicas',
        progress: (line) => {
          console.log(`[TC-16] ${line}`);
        },
      });
      const out = resolve(process.env.RALYSA_SOAK_REPORT ?? 'test-results/rotation-soak.json');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        `${JSON.stringify({ test: 'TC-F-002-16', startedAt, timings: { key_poll_s: KEY_POLL_S, activation_delay_s: ACTIVATION_DELAY_S, client_secret_poll_s: SECRET_POLL_S }, ...report }, null, 2)}\n`,
      );
      console.log(`[TC-16] report written to ${out}`);
      console.log(
        `[TC-16] report ${JSON.stringify({ ...report, failures: report.failures.length })}`,
      );

      expect(report.failures).toEqual([]);
      const total = Object.values(report.operations).reduce((x, y) => x + y, 0);
      expect(total).toBeGreaterThanOrEqual(DURATION_MS / 1000); // ≥ 1 rps
      for (const count of Object.values(report.operations)) expect(count).toBeGreaterThan(0);

      const { signingKey, idpSecret } = report;
      expect(signingKey.newKidInUseAfterMs).toBeDefined();
      expect(signingKey.newKidInUseAfterMs).toBeGreaterThanOrEqual(
        ACTIVATION_DELAY_S * 1000 - 1000,
      );
      expect(signingKey.newKidInUseAfterMs).toBeLessThanOrEqual(AC10_BOUND_MS);
      expect(signingKey.oldKidTokensVerifiedAtEnd.ok).toBe(
        signingKey.oldKidTokensVerifiedAtEnd.total,
      );
      expect(signingKey.oldKidTokensVerifiedAtEnd.total).toBeGreaterThan(0);
      expect(signingKey.jwksKidsAtEnd).toEqual(
        expect.arrayContaining([signingKey.kidBefore, signingKey.kidAfter]),
      );
      expect(idpSecret.events).toEqual([
        { version: idpSecret.versionBefore, phase: 'observed' },
        { version: idpSecret.versionAfter, phase: 'observed' },
      ]);
      expect(idpSecret.newVersionInUseAfterMs.a).toBeLessThanOrEqual(AC10_BOUND_MS);
      expect(idpSecret.newVersionInUseAfterMs.b).toBeLessThanOrEqual(AC10_BOUND_MS);
      // The runbook order (remove the old secret after every replica has the new one) needs no
      // invalid_client recovery.
      expect(idpSecret.invalidClientRetries).toEqual({ a: 0, b: 0 });
    },
    DURATION_MS + 5 * 60 * 1000,
  );
});
