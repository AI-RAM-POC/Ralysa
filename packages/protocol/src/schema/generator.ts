// The one zod → JSON Schema generator for every Ralysa contract (F-002 design §3.5, §3.10;
// ADR-0004 decision 5). F-003 registers the Agent Protocol schemas in SCHEMA_REGISTRY.
// `pnpm --filter @ralysa/protocol check:generated` writes src/schema/generated/*.json; CI fails on
// drift, and a unit test compares the committed files with this output.
//
// Generation uses `unrepresentable: 'throw'`, so a transform or any other construct that has no
// JSON Schema form fails here, and `findCustomChecks` fails on `.refine()`/`.superRefine()`, which
// zod would otherwise drop silently: the contracts stay plain shapes, and the schema is the wire.
import { z } from 'zod';
import { AuditEvent, AuditEventInput } from '../audit/envelope.js';
import {
  AccessTokenHeader,
  ServiceAccessTokenClaims,
  UserAccessTokenClaims,
} from '../auth/claims.js';
import {
  AuthorizationServerMetadata,
  AuthorizeQuery,
  OAuthError,
  RevokeRequest,
  TokenRequest,
  TokenResponse,
} from '../auth/oauth.js';
import { Problem } from '../common/errors.js';
import {
  AuditQuery,
  AuditQueryResponse,
  ClientEventsRequest,
  ClientEventsResponse,
  ClientEventsUnavailable,
  ServiceEventsRequest,
  ServiceEventsResponse,
  TokenRejectedReportDetails,
} from '../control-plane/audit-api.js';
import { AuthConfig } from '../control-plane/auth-config.js';
import { GovernanceState } from '../control-plane/governance.js';
import { Me } from '../control-plane/me.js';
import { Principal } from '../control-plane/principals.js';
import { SignInFailureReport } from '../control-plane/sign-in-failures.js';

export interface RegisteredSchema {
  /** File name under src/schema/generated/, `<name>.v<major>.json`. */
  file: string;
  title: string;
  schema: z.ZodType;
  /** Requests are generated for their input form, responses and stored records for output. */
  io: 'input' | 'output';
}

export const SCHEMA_REGISTRY: readonly RegisteredSchema[] = [
  // Audit (AUDIT_SCHEMA_VERSION 1)
  { file: 'audit-event.v1.json', title: 'AuditEvent', schema: AuditEvent, io: 'output' },
  {
    file: 'audit-event-input.v1.json',
    title: 'AuditEventInput',
    schema: AuditEventInput,
    io: 'input',
  },
  // Tokens (typ at+jwt)
  {
    file: 'access-token-header.v1.json',
    title: 'AccessTokenHeader',
    schema: AccessTokenHeader,
    io: 'output',
  },
  {
    file: 'user-access-token-claims.v1.json',
    title: 'UserAccessTokenClaims',
    schema: UserAccessTokenClaims,
    io: 'output',
  },
  {
    file: 'service-access-token-claims.v1.json',
    title: 'ServiceAccessTokenClaims',
    schema: ServiceAccessTokenClaims,
    io: 'output',
  },
  // OAuth
  {
    file: 'oauth-authorize-query.v1.json',
    title: 'AuthorizeQuery',
    schema: AuthorizeQuery,
    io: 'input',
  },
  { file: 'oauth-token-request.v1.json', title: 'TokenRequest', schema: TokenRequest, io: 'input' },
  {
    file: 'oauth-token-response.v1.json',
    title: 'TokenResponse',
    schema: TokenResponse,
    io: 'output',
  },
  {
    file: 'oauth-revoke-request.v1.json',
    title: 'RevokeRequest',
    schema: RevokeRequest,
    io: 'input',
  },
  { file: 'oauth-error.v1.json', title: 'OAuthError', schema: OAuthError, io: 'output' },
  {
    file: 'oauth-authorization-server-metadata.v1.json',
    title: 'AuthorizationServerMetadata',
    schema: AuthorizationServerMetadata,
    io: 'output',
  },
  // Control plane /v1
  { file: 'problem.v1.json', title: 'Problem', schema: Problem, io: 'output' },
  { file: 'auth-config.v1.json', title: 'AuthConfig', schema: AuthConfig, io: 'output' },
  {
    file: 'sign-in-failure-report.v1.json',
    title: 'SignInFailureReport',
    schema: SignInFailureReport,
    io: 'input',
  },
  { file: 'me.v1.json', title: 'Me', schema: Me, io: 'output' },
  { file: 'principal.v1.json', title: 'Principal', schema: Principal, io: 'output' },
  {
    file: 'governance-state.v1.json',
    title: 'GovernanceState',
    schema: GovernanceState,
    io: 'output',
  },
  {
    file: 'audit-service-events-request.v1.json',
    title: 'ServiceEventsRequest',
    schema: ServiceEventsRequest,
    io: 'input',
  },
  {
    file: 'audit-service-events-response.v1.json',
    title: 'ServiceEventsResponse',
    schema: ServiceEventsResponse,
    io: 'output',
  },
  {
    file: 'audit-token-rejected-report-details.v1.json',
    title: 'TokenRejectedReportDetails',
    schema: TokenRejectedReportDetails,
    io: 'input',
  },
  {
    file: 'audit-client-events-unavailable.v1.json',
    title: 'ClientEventsUnavailable',
    schema: ClientEventsUnavailable,
    io: 'output',
  },
  {
    file: 'audit-client-events-request.v1.json',
    title: 'ClientEventsRequest',
    schema: ClientEventsRequest,
    io: 'input',
  },
  {
    file: 'audit-client-events-response.v1.json',
    title: 'ClientEventsResponse',
    schema: ClientEventsResponse,
    io: 'output',
  },
  { file: 'audit-query.v1.json', title: 'AuditQuery', schema: AuditQuery, io: 'input' },
  {
    file: 'audit-query-response.v1.json',
    title: 'AuditQueryResponse',
    schema: AuditQueryResponse,
    io: 'output',
  },
];

// zod internals read by findCustomChecks (zod 4: every schema and check carries `_zod.def`).
interface ZodInternals {
  _zod: { def: Record<string, unknown> & { checks?: ZodInternals[]; check?: string } };
}
const isZod = (value: unknown): value is ZodInternals =>
  typeof value === 'object' && value !== null && '_zod' in value;

/**
 * Paths inside `schema` that carry a custom check (`.refine()`, `.superRefine()`, `.check()` with
 * a function). zod's JSON Schema output drops these silently, even with `unrepresentable: 'throw'`,
 * so the generated contract would accept what the zod schema refuses: the wire shape and the
 * schema would disagree. Contracts must express every rule in a representable form (regex,
 * length, enum, literal, discriminated union) instead.
 */
export function findCustomChecks(schema: unknown, path = '$'): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, at: string): void => {
    if (!isZod(node) || seen.has(node)) return;
    seen.add(node);
    const def = node._zod.def;
    for (const check of def.checks ?? []) {
      if (check._zod.def.check === 'custom') found.push(at);
    }
    for (const [key, value] of Object.entries(def)) {
      if (key === 'checks') continue;
      if (key === 'getter' && typeof value === 'function') {
        visit((value as () => unknown)(), at);
      } else if (isZod(value)) {
        visit(value, `${at}.${key}`);
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => {
          visit(item, `${at}.${key}[${String(index)}]`);
        });
      } else if (key === 'shape' && typeof value === 'object' && value !== null) {
        for (const [name, member] of Object.entries(value)) visit(member, `${at}.${name}`);
      }
    }
  };
  visit(schema, path);
  return found;
}

export function toJsonSchema(entry: RegisteredSchema): Record<string, unknown> {
  const custom = findCustomChecks(entry.schema, entry.title);
  if (custom.length > 0) {
    throw new Error(
      `${entry.title}: custom refinements have no JSON Schema form and would be dropped from the contract: ${custom.join(', ')}`,
    );
  }
  const generated = z.toJSONSchema(entry.schema, {
    target: 'draft-2020-12',
    io: entry.io,
    unrepresentable: 'throw',
    cycles: 'ref',
    reused: 'inline',
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: `urn:ralysa:schema:${entry.file.replace(/\.json$/, '')}`,
    title: entry.title,
    ...rest,
  };
}

/** File name → file content, in registry order. */
export function generateSchemas(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of SCHEMA_REGISTRY) {
    if (files.has(entry.file)) throw new Error(`duplicate schema file ${entry.file}`);
    files.set(entry.file, `${JSON.stringify(toJsonSchema(entry), null, 2)}\n`);
  }
  return files;
}
