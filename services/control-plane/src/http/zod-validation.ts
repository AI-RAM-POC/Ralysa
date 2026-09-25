// Fastify validation and serialization through zod (F-002 design §2.1): route schemas are the
// protocol contracts themselves, so what is validated is exactly what is published (OpenAPI is
// generated from the same objects). Validation errors never echo input.
import type { FastifyInstance, FastifySchemaCompiler } from 'fastify';
import type { FastifySerializerCompiler } from 'fastify/types/schema.js';
import type { ZodType } from 'zod';

const isZod = (schema: unknown): schema is ZodType =>
  typeof schema === 'object' && schema !== null && 'safeParse' in schema;

function validate(schema: unknown, data: unknown): { value: unknown } | { error: Error } {
  if (!isZod(schema)) return { value: data };
  const result = schema.safeParse(data);
  if (result.success) return { value: result.data };
  const error = new Error(
    `invalid ${result.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`,
  ) as Error & { validation: unknown[]; statusCode: number };
  error.statusCode = 400;
  error.validation = result.error.issues.map((i) => ({ path: i.path, code: i.code }));
  return { error };
}

export const zodValidatorCompiler: FastifySchemaCompiler<unknown> =
  ({ schema }) =>
  (data: unknown) =>
    validate(schema, data);

/** Responses are checked against their contract before they leave (a bug fails closed). */
export const zodSerializerCompiler: FastifySerializerCompiler<unknown> =
  ({ schema }) =>
  (data) => {
    if (!isZod(schema)) return JSON.stringify(data);
    const result = schema.safeParse(data);
    if (!result.success) throw new Error('response does not match its contract');
    return JSON.stringify(result.data);
  };

export function registerZod(app: FastifyInstance): void {
  app.setValidatorCompiler(zodValidatorCompiler);
  app.setSerializerCompiler(zodSerializerCompiler);
}
