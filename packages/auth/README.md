# auth

`@ralysa/auth`: OIDC/SSO helpers. The token verifier every Ralysa service uses (JWKS cache,
revocation feed, principal resolver, service-token source) and the isomorphic client flows the CLI
wraps (F-002 design §3.6). Isomorphic: no DOM and no Node built-ins.

Scaffolded in F-002-T01; the API lands in F-002-T11. There are no environment variables.
