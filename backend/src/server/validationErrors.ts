import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

/**
 * A 400 that says what was wrong. Fastify's default validation reply carries
 * the reason in `message`, which the shared `Error` response schema does not
 * declare, so the serializer stripped it and both apps answered a bad request
 * with a bare `{"error":"Bad Request"}`. This puts the reason in `detail`,
 * which the schema does declare. Every other error goes to Fastify's default
 * handler unchanged.
 */
export function installValidationErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error) || error.validation) {
      return reply.code(400).send({ error: 'bad_request', detail: error.message });
    }
    // Plugins may throw a plain object (the rate limiter throws its 429 body).
    // Send it with its own status; hand real errors to the parent handler.
    if (!(error instanceof Error)) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send(error);
    }
    return reply.send(error);
  });
}
