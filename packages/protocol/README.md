# protocol

`@ralysa/protocol`: shared, typed contracts (zod), isomorphic (no DOM, no Node built-ins).

| Subpath | Contents | Owner |
|---|---|---|
| `@ralysa/protocol/common` | Shared primitives: `TraceId`, `SpanId`, `Sha256Hex`, `Region`, shared error codes, `traceparent` | F-002 |
| `@ralysa/protocol/audit` | Audit envelope, event catalogue, client allow-list, reserved `details` keys, JCS hashing | F-002 |
| `@ralysa/protocol/auth` | Access-token claims and headers, OAuth request/response/error types, sign-in reasons and i18n keys | F-002 |
| `@ralysa/protocol/control-plane` | Control-plane REST types (`/v1`) | F-002 |
| `@ralysa/protocol/agent` | Typed Agent Protocol client/server schema | F-003 |

Each contract family carries its own version constant (F-002 design §3.10, [AR-18]).
