// `GET /v1/internal/governance` (F-002 design §3.2.6, §3.4.3): what every PEP polls every 5 s.
// A poll counts as confirmation only if `issued_at` is within 30 s of the PEP clock and `epoch`
// is not lower than the last one seen [SEC-F002-18]; `packages/auth` enforces both.
import { z } from 'zod';

export const KillSwitchScope = z.enum(['tenant', 'department', 'pack', 'agent']);
export type KillSwitchScope = z.infer<typeof KillSwitchScope>;

export const GovernanceState = z.strictObject({
  /** Bumps on any change; never decreases. */
  epoch: z.int(),
  /** Database clock. */
  issued_at: z.iso.datetime(),
  cursor: z.string().max(256),
  revoked_sessions: z.array(z.strictObject({ sid: z.uuid(), revoked_at: z.iso.datetime() })),
  users_revoked_before: z.array(
    z.strictObject({ user_id: z.uuid(), revoked_before: z.iso.datetime() }),
  ),
  kill_switches: z.array(
    z.strictObject({
      scope: KillSwitchScope,
      scope_id: z.string().max(200).nullable(),
      active: z.boolean(),
    }),
  ),
});
export type GovernanceState = z.infer<typeof GovernanceState>;

/** Freshness rules for the feed (§3.2.6, identity-and-policy §5.6 G-1). */
export const GOVERNANCE_FEED = {
  pollMs: 5_000,
  /** A response older than this (PEP clock) is not a confirmation. */
  maxIssuedAtSkewMs: 30_000,
  /** With no confirmation for longer than this, every token is rejected (`governance_stale`). */
  staleAfterMs: 60_000,
  /** The window a feed without `since` covers: max configurable access TTL + 5 min. */
  defaultWindowSeconds: 60 * 60 + 5 * 60,
} as const;
