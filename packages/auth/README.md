# auth

`@ralysa/auth`: OIDC/SSO helpers. The token verifier every Ralysa service uses (JWKS cache,
revocation feed, principal resolver, service-token source) and the isomorphic client flows the CLI
wraps (F-002 design §3.6). Isomorphic: no DOM and no Node built-ins.

Scaffolded in F-002-T01; the API lands in F-002-T11. There are no environment variables.

## Contract for integrators: one refresher per device (SEC-F002-17)

Exactly one process per device refreshes a user's session: the CLI (F-005) or the Desktop main
process. Every other local consumer, the Agent Host (F-003) included, asks that process for access
tokens through the `TokenProvider` over IPC. RTS treats a second refresher as refresh-token reuse:
the losing request gets `invalid_grant` with `ralysa_error.code = reuse_detected`, and the whole
session is revoked. The full rules are in the control-plane README, under Sessions and grants.
