# protocol

`@ralysa/protocol`: shared, typed contracts (zod), isomorphic (no DOM, no Node built-ins).

| Subpath | Contents | Owner |
|---|---|---|
| `@ralysa/protocol/common` | Shared primitives: `TraceId`, `SpanId`, `Sha256Hex`, `Region`, shared error codes, `traceparent` | F-002 |
| `@ralysa/protocol/audit` | Audit envelope, event catalogue, client allow-list, reserved `details` keys, JCS hashing | F-002 |
| `@ralysa/protocol/auth` | Access-token claims and headers, OAuth request/response/error types, sign-in reasons and i18n keys | F-002 |
| `@ralysa/protocol/control-plane` | Control-plane REST types (`/v1`) | F-002 |
| `@ralysa/protocol/agent` | Typed Agent Protocol client/server schema | F-003 |

Each contract family carries its own version constant (F-002 design §3.10, [AR-18]): `AUDIT_SCHEMA_VERSION`, `CONTROL_PLANE_API_VERSION` with the `/v1` prefix, and the token `typ` (`at+jwt`).

## Rules for contracts

- Plain zod shapes only: no transforms and no refinement that changes the wire shape. Rules zod can't express in a schema are functions next to it (`iJsonViolations()`, `outcomeAllowed()`, `findReservedKeys()`).
- The audit canonical form is frozen: RFC 8785 JCS over the stored envelope with null or absent fields omitted, `details` hashed as stored (`audit/jcs.ts`). A new envelope field is a nullable column, never a `schema_version` bump. `test/jcs.test.ts` pins a golden event hash and chain hash.
- Isomorphic: WebCrypto and `TextEncoder` are reached through `src/platform.ts` with structural types, because the isomorphic tsconfig base has neither DOM nor Node types.

## JSON Schema

`src/schema/generator.ts` is the one zod → JSON Schema generator (F-003 registers the Agent Protocol schemas there). `pnpm --filter @ralysa/protocol check:generated` builds the package and rewrites `src/schema/generated/*.json`; CI fails on any drift, and `test/schema.test.ts` compares the committed files with the generator output. The files are exported as `@ralysa/protocol/schema/<name>.v1.json`.

There are no environment variables.
