// TC-F-002-15 (AC-10, compressed for CI; F-002-T13): 5 operations a second for 60 s over two
// control-plane replicas (flow-A exchanges, refreshes, flow-B sign-ins end to end, fake-gateway and
// control-plane verifications), with the Transit signing key rotated at 15 s and the IdP client
// secret at 20 s by the operator identity, key_poll_s = 2 and activation_delay_s = 6. Replica A
// polls the secret every 2 s, replica B every 60 s, so B still holds the old secret when the IdP
// drops it and must recover through the invalid_client re-read (design §5.7).
//   - 0 failed operations;
//   - the new kid is in use within 2 × key_poll_s + activation_delay_s, and tokens with the old kid
//     still verify at the end (they validate until exp) while JWKS lists both kids;
//   - secret.rotated: published and activated once for the new key version, observed once per IdP
//     secret version across both replicas;
//   - replica A adopts the new secret within its poll; replica B through invalid_client.
// TC-F-002-20 (AC-14) for the rotation flow: the same run keeps both replicas' log lines (pino at
// info, as serve logs) and the next test scans them for token shapes and the run's IdP secrets.
// The harness is test/soak/rotation-harness.ts (also the 10-minute soak, TC-F-002-16).
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import { describe, expect, it } from 'vitest';
import { type ScenarioReport, runRotationScenario } from '../soak/rotation-harness.js';

const stack = await devStackOrSkip();
const KEY_POLL_S = 2;
const ACTIVATION_DELAY_S = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const logLines: string[] = [];
const secretValues: string[] = [];

const countBy = (events: { version: number; phase: string }[]) => {
  const counts = new Map<string, number>();
  for (const e of events) {
    const key = `${String(e.version)}:${e.phase}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

describe.skipIf(stack === undefined)('rotation under load (F-002-T13, TC-F-002-15)', () => {
  it('TC-F-002-15: key and IdP secret rotated under 5 rps with 0 failed requests', async () => {
    const report: ScenarioReport = await runRotationScenario({
      stack: stack!,
      durationMs: 60_000,
      rps: 5,
      keyRotateAtMs: 15_000,
      secretRotateAtMs: 20_000,
      keyPollS: KEY_POLL_S,
      activationDelayS: ACTIVATION_DELAY_S,
      secretPollS: [2, 60],
      removeOldSecretWhen: 'observed',
      logLines,
      onSecretValue: (value) => {
        secretValues.push(value);
      },
      progress: (line) => {
        console.log(`[TC-15] ${line}`);
      },
    });
    // Counts, timings, kids and versions only (no token or secret): the CI log's evidence.
    console.log(
      `[TC-15] report ${JSON.stringify({ ...report, failures: report.failures.length })}`,
    );

    // 0 failed requests, and every kind of operation ran on the way.
    expect(report.failures).toEqual([]);
    for (const count of Object.values(report.operations)) expect(count).toBeGreaterThan(10);
    const total = Object.values(report.operations).reduce((x, y) => x + y, 0);
    expect(total).toBeGreaterThanOrEqual(280);

    // Signing key: the new kid within the configured bound; old-kid tokens still verify.
    const { signingKey } = report;
    expect(signingKey.newKidInUseAfterMs).toBeDefined();
    expect(signingKey.newKidInUseAfterMs).toBeGreaterThanOrEqual(ACTIVATION_DELAY_S * 1000 - 1000);
    expect(signingKey.newKidInUseAfterMs).toBeLessThanOrEqual(
      (2 * KEY_POLL_S + ACTIVATION_DELAY_S) * 1000 + 2_000,
    );
    expect(signingKey.oldKidTokensVerifiedAtEnd.total).toBeGreaterThan(0);
    expect(signingKey.oldKidTokensVerifiedAtEnd.ok).toBe(
      signingKey.oldKidTokensVerifiedAtEnd.total,
    );
    expect(signingKey.jwksKidsAtEnd).toEqual(
      expect.arrayContaining([signingKey.kidBefore, signingKey.kidAfter]),
    );
    // Once per phase per version, across two replicas.
    const keyEvents = countBy(signingKey.events);
    const newVersion = Number(signingKey.kidAfter.split('.v')[1]);
    expect(keyEvents.get(`${String(newVersion)}:published`)).toBe(1);
    expect(keyEvents.get(`${String(newVersion)}:activated`)).toBe(1);
    expect([...keyEvents.values()].every((n) => n === 1)).toBe(true);

    // IdP secret: observed once per version; A by its poll, B through invalid_client.
    const { idpSecret } = report;
    expect(idpSecret.versionAfter).toBe(idpSecret.versionBefore + 1);
    expect(idpSecret.events).toEqual([
      { version: idpSecret.versionBefore, phase: 'observed' },
      { version: idpSecret.versionAfter, phase: 'observed' },
    ]);
    expect(idpSecret.oldRemovedAtMs).toBeDefined();
    expect(idpSecret.newVersionInUseAfterMs.a).toBeLessThanOrEqual(2_000 + 1_500);
    expect(idpSecret.invalidClientRetries.b).toBeGreaterThanOrEqual(1);
    expect(idpSecret.invalidClientRetries.a).toBe(0);
    expect(idpSecret.invalidClientNoRetry).toEqual({ a: 0, b: 0 });
    expect(idpSecret.newVersionInUseAfterMs.b).toBeDefined();
    expect(idpSecret.newVersionInUseAfterMs.b).toBeLessThan(60_000);

    // Nothing logged at error; warn only for the expected invalid_client recovery.
    const unexpected = Object.keys(report.warnings).filter(
      (key) => !/^b:warn:idp_invalid_client$/.test(key),
    );
    expect(unexpected).toEqual([]);
  }, 180_000);

  it("TC-F-002-20 (rotation logs): the two replicas' logs during TC-15 hold no token or secret; users are UUIDs", () => {
    expect(logLines.length, 'run together with TC-F-002-15').toBeGreaterThan(0);
    // The rotation itself was logged, so the scan below saw it.
    const text = logLines.join('');
    for (const msg of ['signing_key_active', 'idp_client_secret_observed', 'idp_invalid_client']) {
      expect(text).toContain(`"msg":"${msg}"`);
    }
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.eyJ/);
    expect(text).not.toMatch(/rly_rt_[A-Za-z0-9_-]{8}/);
    expect(text).not.toMatch(/rly_ac_[A-Za-z0-9_-]{8}/);
    expect(text).not.toMatch(/[?&](?:code|state|code_verifier|session_state)=/);
    expect(text).not.toMatch(/@contoso\.example/);
    expect(text).not.toMatch(/\b(?:hvs|hvb|hvr|s|b|r)\.[A-Za-z0-9]{24,}\b/);
    expect(secretValues.length).toBeGreaterThanOrEqual(2);
    for (const value of secretValues) {
      expect(text.includes(value), 'an IdP client secret is in the log').toBe(false);
    }
    for (const line of logLines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      for (const key of ['user_id', 'actor_user_id', 'sub']) {
        if (record[key] !== undefined) expect(record[key]).toMatch(UUID);
      }
      expect(record).not.toHaveProperty('email');
      expect(record).not.toHaveProperty('display_name');
    }
  });
});
