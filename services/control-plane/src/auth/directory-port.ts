// The IdP directory port refresh re-checks against (F-002 design §3.2.3, §5.3; AC-6). T10's
// Graph implementation (accountEnabled, signInSessionsValidFromDateTime, checkMemberGroups for
// the two configured groups, 404, timeouts, circuit breaker) sits behind it.
export type DirectoryCheck =
  | {
      kind: 'ok';
      inAccessGroup: boolean;
      inAdminGroup: boolean;
      /** Entra signInSessionsValidFromDateTime; sessions created before it are revoked. */
      sessionsValidFrom: Date | null;
    }
  | { kind: 'disabled' }
  | { kind: 'deleted' }
  | { kind: 'unavailable'; reason: string };

export interface IdpDirectory {
  check(user: { idpSubject: string; tenantId: string }): Promise<DirectoryCheck>;
}

/** Until T10 wires Graph: every re-check is `unavailable`, so refresh fails closed. */
export const unconfiguredDirectory: IdpDirectory = {
  check: () => Promise.resolve({ kind: 'unavailable', reason: 'directory not configured' }),
};
