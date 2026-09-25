// The IdP directory port that sign-in and every refresh check against (F-002 design §3.2.3,
// §5.3, §6.3; AC-6; SEC-F002-08, -09). The Entra implementation is idp/graph-directory.ts
// (accountEnabled, signInSessionsValidFromDateTime and checkMemberGroups for the two configured
// groups, 404, timeouts, circuit breaker).
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
  /**
   * A group's display name, for display only (never matched, §6.3 item 3): a string, `null` when
   * the group has none or no longer exists, `undefined` when it couldn't be read now.
   */
  groupDisplayName?(groupId: string): Promise<string | null | undefined>;
}

/** Without a configured directory every check is `unavailable`, so sign-in and refresh fail closed. */
export const unconfiguredDirectory: IdpDirectory = {
  check: () => Promise.resolve({ kind: 'unavailable', reason: 'directory not configured' }),
};
