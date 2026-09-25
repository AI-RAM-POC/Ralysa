// `GET /v1/auth/config` (F-002 design §3.4.1): which CLI sign-in flows are enabled and where the
// IdP's device and token endpoints are. Unauthenticated.
import { z } from 'zod';
import { CLI_CLIENT_ID } from '../auth/oauth.js';

export const AuthConfig = z.strictObject({
  issuer: z.url(),
  flows: z.strictObject({ idp_device: z.boolean(), loopback_pkce: z.literal(true) }),
  idp: z.strictObject({
    kind: z.literal('entra'),
    /** From the pinned tenant's discovery document. */
    device_authorization_endpoint: z.url(),
    token_endpoint: z.url(),
    cli_client_id: z.string().max(64),
    /** The RTS API scope only; the CLI never asks for `offline_access`. */
    scope: z.string().max(256),
  }),
  cli_client_id: z.literal(CLI_CLIENT_ID),
});
export type AuthConfig = z.infer<typeof AuthConfig>;
