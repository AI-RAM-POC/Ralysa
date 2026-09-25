// `POST /v1/auth/sign-in-failures` (F-002 design §3.4.1, AC-4): the CLI reports IdP-side failures
// of flow A so every attempt is audited. Idempotent per `attempt_id`; rate-limited and
// aggregated server-side [AR-16, SEC-F002-16].
import { z } from 'zod';

export const SignInFailureReport = z.strictObject({
  attempt_id: z.uuid(),
  flow: z.literal('idp_device'),
  error: z.enum([
    'authorization_declined',
    'expired_token',
    'access_denied',
    'bad_verification_code',
    'conditional_access_blocked',
    'other',
  ]),
  /** IdP-neutral [AR-18]: the CLI maps Entra `AADSTS` codes; the contract doesn't know them. */
  idp_error_code: z.string().max(64).optional(),
  device_label: z.string().max(64).optional(),
});
export type SignInFailureReport = z.infer<typeof SignInFailureReport>;
