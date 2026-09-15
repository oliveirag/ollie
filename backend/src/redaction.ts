/**
 * PRD §11: every strategy input and output is logged, so redaction has to be
 * narrow — only secrets, never market data or decisions.
 *
 * `req.headers.authorization` is load-bearing since Phase 2: Fastify logs
 * request headers on every call, and that header carries the owner token —
 * and, since Phase 4, subscriber tokens on the signal service. Shared by both
 * processes' loggers so neither can drift to a lookalike that passes the test
 * while production leaks.
 */
export const REDACT = {
  paths: [
    'authToken',
    'apiKey',
    '*.authToken',
    '*.apiKey',
    'headers.authorization',
    'req.headers.authorization',
    // Never logged on purpose, but a request body that carried one by
    // mistake must not become a plaintext credential in Railway's logs.
    'identity_token',
    '*.identity_token',
    'token',
    '*.token',
  ],
  censor: '[redacted]',
} as const;
