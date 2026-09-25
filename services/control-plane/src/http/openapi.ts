// The OpenAPI 3.1 document (openapi/control-plane.v1.json), generated from ROUTES and the protocol
// zod schemas with z.toJSONSchema (the one generator family, §3.10). `check:generated` rewrites
// the committed file; a unit test compares them.
import { CONTROL_PLANE_API_VERSION } from '@ralysa/protocol/control-plane';
import { z } from 'zod';
import { ROUTES, type RouteContract } from './contracts.js';

const toSchema = (schema: z.ZodType): Record<string, unknown> => {
  const out: Record<string, unknown> = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'throw',
    reused: 'inline',
  });
  delete out.$schema; // the document sets jsonSchemaDialect once
  return out;
};

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of Object.values(ROUTES) as RouteContract[]) {
    const responses: Record<string, unknown> = {};
    for (const [status, response] of Object.entries(route.responses)) {
      responses[status] = {
        description: response.description,
        content: {
          [response.contentType ?? 'application/json']: { schema: toSchema(response.schema) },
        },
      };
    }
    const path = route.url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    const operations = (paths[path] ??= {});
    operations[route.method.toLowerCase()] = {
      summary: route.summary,
      tags: route.tags,
      // OAuth clients authenticate in the body (public client id or private_key_jwt), not bearer.
      security: route.auth === 'none' || route.auth === 'client' ? [] : [{ bearer: [] }],
      ...(route.parameters === undefined
        ? {}
        : {
            parameters: route.parameters.map((p) => ({
              name: p.name,
              in: p.in,
              required: p.required,
              description: p.description,
              schema: toSchema(p.schema),
            })),
          }),
      ...(route.request === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: { [route.request.contentType]: { schema: toSchema(route.request.schema) } },
            },
          }),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ralysa control plane',
      version: CONTROL_PLANE_API_VERSION,
      description:
        'Generated from services/control-plane/src/http/contracts.ts. No route accepts a user-held shared secret (AC-3).',
    },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export const openApiText = (): string => `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
