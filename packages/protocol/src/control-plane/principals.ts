// `GET /v1/internal/principals/{user_id}[?sid=]` (F-002 design §3.4.2, §6.1, AC-7; rev 10, #47,
// SEC-F002-42): what a service's PrincipalResolver gets for a verified user. Service token only.
//
// Two kinds of roles, and only one of them authorizes a privileged action:
// - `roles` are DIRECTORY roles: derived from the user's current memberships of the configured
//   groups (as last confirmed by Graph at a sign-in or refresh). They say what the user could be
//   granted, not what this request holds. They are never enough on their own for
//   `platform_admin`: an admin who signed in by device code holds no admin role (SEC-F002-06).
// - `session_roles` (present only when `?sid=` was given) are the roles of THAT session, decided
//   at sign-in by the strong-flow rule, narrowed at every refresh, and intersected with the
//   current memberships at request time. PEPs use them for every privileged decision.
import { z } from 'zod';
import { GroupView, SessionRole } from './me.js';

export const Principal = z.strictObject({
  user_id: z.uuid(),
  org_id: z.uuid(),
  status: z.enum(['active', 'disabled']),
  /** Directory roles (current memberships). Never enough on their own for `platform_admin`. */
  roles: z.array(SessionRole),
  groups: z.array(z.strictObject({ idp_group_id: z.uuid(), role: GroupView.shape.role })),
  as_of: z.iso.datetime(),
  /** The `sid` asked about; present exactly when the request carried `?sid=` (rev 10). */
  session_id: z.uuid().optional(),
  /**
   * The session's roles ∩ the current memberships (rev 10). Present exactly when the request
   * carried `?sid=`; an unknown, revoked, expired or another user's session is refused (403),
   * never answered with roles.
   */
  session_roles: z.array(SessionRole).optional(),
});
export type Principal = z.infer<typeof Principal>;
