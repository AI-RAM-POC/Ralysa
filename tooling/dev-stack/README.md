# dev-stack

`@ralysa/dev-stack`: the local development and test stack for the control plane (F-002 design
§8.2, §8.3). `kind: "tooling"`, `shipped: false`.

**Never shipped.** No `shipped: true` workspace may depend on `@ralysa/dev-stack` or on
`oidc-provider`, directly or through another workspace's production dependencies
(`check-workspaces` rule `deps/dev-only-in-shipped`, SEC-F002-13, [AR-12]).

Scaffolded in F-002-T01; the `.env` generator, bootstrap and harness land in F-002-T02, the mock
IdP in F-002-T09.
