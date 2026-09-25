// `GET /v1/internal/principals/{user_id}` (F-002 design §3.4.2, AC-7): what a service's
// PrincipalResolver gets for a verified user. Service token only.
import { z } from 'zod';
import { GroupView, SessionRole } from './me.js';

export const Principal = z.strictObject({
  user_id: z.uuid(),
  org_id: z.uuid(),
  status: z.enum(['active', 'disabled']),
  roles: z.array(SessionRole),
  groups: z.array(z.strictObject({ idp_group_id: z.uuid(), role: GroupView.shape.role })),
  as_of: z.iso.datetime(),
});
export type Principal = z.infer<typeof Principal>;
