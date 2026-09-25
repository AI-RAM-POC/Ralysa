// Mock IdP fixture users and groups (F-002 design §8.3). Every run gets fresh object ids, except
// the access and admin group ids, which the caller passes so they match the control plane's
// `access.access_group_id` and `access.admin_group_id`.
//
// | user    | what it exercises                                                              |
// |---------|--------------------------------------------------------------------------------|
// | alice   | access group: the ordinary signed-in user                                      |
// | bob     | no configured group                                                            |
// | carol   | disabled: the IdP refuses her sign-in, Graph says accountEnabled=false         |
// | dora    | deleted from the directory after sign-in: Graph answers 404 for her            |
// | dana    | admin group only                                                               |
// | erin    | access + admin groups; signs in with FIDO (amr ["fido"], acrs ["c1"])          |
// | fatima  | Arabic display name with harakat; also in an Arabic-named group                |
// | olga    | 250 groups: the token carries overage markers instead of `groups`              |
// | mallory | a group whose display name equals the access group's, with another object id  |
// | sam     | a synced group emitted as an on-prem name (non-GUID) in the token              |
import { randomUUID } from 'node:crypto';

export interface MockGroup {
  id: string;
  displayName: string;
}

export interface MockUser {
  username: string;
  /** Entra object id (`oid`), the immutable id Ralysa maps (D-21). */
  oid: string;
  displayName: string;
  upn: string;
  /** false: sign-in refused, Graph reports accountEnabled=false. */
  enabled: boolean;
  /** true: Graph answers 404 (sign-in still works: the deletion happened after it). */
  deletedInGraph: boolean;
  /** Group object ids the user is a member of (what Graph checks). */
  groups: string[];
  /** When set, the token's `groups` claim carries these values instead (on-prem names). */
  groupClaimOverride?: string[];
  amr: string[];
  acrs?: string[];
  /** Graph signInSessionsValidFromDateTime (session revocation). */
  signInSessionsValidFrom: Date;
  /** Overrides the `ipaddr` claim; otherwise the address that completed the sign-in. */
  ipaddr?: string;
  lastLoginIp?: string;
}

export interface FixtureOptions {
  accessGroupId: string;
  adminGroupId: string;
  /** Account creation time (default: one day ago), so a fresh session is after it. */
  createdAt?: Date;
}

/** An access group name with harakat (fatima's case, and what mallory's look-alike copies). */
export const ACCESS_GROUP_NAME = 'مُسْتَخْدِمُو رالِيسا';
export const ADMIN_GROUP_NAME = 'Ralysa Admins';
export const ARABIC_GROUP_NAME = 'فَرِيقُ المالِيَّة';
export const FATIMA_NAME = 'فاطِمَة الزَّهْراء';
export const OVERAGE_THRESHOLD = 200;
export const OLGA_GROUP_COUNT = 250;

export function buildFixtures(options: FixtureOptions): {
  users: MockUser[];
  groups: MockGroup[];
} {
  const since = options.createdAt ?? new Date(Date.now() - 86_400_000);
  const access = { id: options.accessGroupId, displayName: ACCESS_GROUP_NAME };
  const admin = { id: options.adminGroupId, displayName: ADMIN_GROUP_NAME };
  const arabic = { id: randomUUID(), displayName: ARABIC_GROUP_NAME };
  const lookAlike = { id: randomUUID(), displayName: ACCESS_GROUP_NAME };
  const synced = { id: options.accessGroupId, displayName: ACCESS_GROUP_NAME };
  const olgaGroups = Array.from({ length: OLGA_GROUP_COUNT - 1 }, (_, i) => ({
    id: randomUUID(),
    displayName: `Olga group ${String(i + 1)}`,
  }));

  const user = (username: string, fields: Partial<MockUser> & { groups: string[] }): MockUser => ({
    username,
    oid: randomUUID(),
    displayName: `${username.charAt(0).toUpperCase()}${username.slice(1)}`,
    upn: `${username}@contoso.example`,
    enabled: true,
    deletedInGraph: false,
    amr: ['pwd', 'mfa'],
    signInSessionsValidFrom: since,
    ...fields,
  });

  const users = [
    user('alice', { groups: [access.id] }),
    user('bob', { groups: [] }),
    user('carol', { groups: [access.id], enabled: false }),
    user('dora', { groups: [access.id], deletedInGraph: true }),
    user('dana', { groups: [admin.id] }),
    user('erin', { groups: [access.id, admin.id], amr: ['fido'], acrs: ['c1'] }),
    user('fatima', { groups: [access.id, arabic.id], displayName: FATIMA_NAME }),
    user('olga', { groups: [access.id, ...olgaGroups.map((g) => g.id)] }),
    user('mallory', { groups: [lookAlike.id] }),
    user('sam', { groups: [synced.id], groupClaimOverride: ['CONTOSO\\Ralysa Users'] }),
  ];
  return { users, groups: [access, admin, arabic, lookAlike, ...olgaGroups] };
}
