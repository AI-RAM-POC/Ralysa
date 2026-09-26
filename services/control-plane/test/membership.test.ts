// The role rules behind `Principal.roles` and `session_roles` (F-002 design §6.1; rev 10, #47,
// SEC-F002-42): directory roles come from group roles; a session keeps only the roles its
// memberships still back, and never gains one.
import { describe, expect, it } from 'vitest';
import { directoryRoles, intersectRoles } from '../src/directory/membership.js';

describe('directory roles and session roles (#47)', () => {
  it('directory roles follow the group roles; ungoverned groups give none', () => {
    expect(directoryRoles([])).toEqual([]);
    expect(directoryRoles([null])).toEqual([]);
    expect(directoryRoles(['access', null])).toEqual(['user']);
    expect(directoryRoles(['platform_admin'])).toEqual(['platform_admin']);
    expect(directoryRoles(['platform_admin', 'access'])).toEqual(['user', 'platform_admin']);
  });

  it('a device-code session of an admin holds no platform_admin, whatever the memberships', () => {
    expect(intersectRoles(['user'], ['access', 'platform_admin'])).toEqual(['user']);
  });

  it('a strong session keeps platform_admin only while the admin membership lasts', () => {
    expect(intersectRoles(['user', 'platform_admin'], ['access', 'platform_admin'])).toEqual([
      'user',
      'platform_admin',
    ]);
    expect(intersectRoles(['user', 'platform_admin'], ['access'])).toEqual(['user']);
    expect(intersectRoles(['platform_admin'], [])).toEqual([]);
  });
});
