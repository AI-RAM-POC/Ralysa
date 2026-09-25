// `GET /v1/me` (F-002 design §3.4.2, AC-1, AC-15). Display names are returned byte-identical to
// what the IdP sent (UTF-8, not normalised).
import { z } from 'zod';

export const SessionRole = z.enum(['user', 'platform_admin']);
export type SessionRole = z.infer<typeof SessionRole>;

export const GroupView = z.strictObject({
  id: z.uuid(),
  /** The IdP's immutable object id; the only thing access decisions match on (SR-06). */
  idp_group_id: z.uuid(),
  display_name: z.string().nullable(),
  role: z.enum(['access', 'platform_admin']).nullable(),
});
export type GroupView = z.infer<typeof GroupView>;

export const Me = z.strictObject({
  id: z.uuid(),
  org_id: z.uuid(),
  idp_subject: z.string(),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
  locale: z.string(),
  status: z.enum(['active', 'disabled']),
  /** Roles of the calling session, decided at sign-in (§6.1). */
  roles: z.array(SessionRole),
  groups: z.array(GroupView),
});
export type Me = z.infer<typeof Me>;
