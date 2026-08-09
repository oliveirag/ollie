import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT } from '../src/logger.js';

/**
 * Redaction is defense in depth, and it only matters if it is actually
 * configured for the paths a credential travels on.
 *
 * Fastify's default request serializer logs method, url, host, and remote
 * address — not headers — so today the owner token never reaches a log line
 * on its own. That is a property of a Fastify default, not a decision this
 * repo made, and it evaporates the moment someone sets a custom serializer to
 * debug a header. These tests pin the config that would catch it.
 */
function logThrough(payload: unknown): string {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const log = pino(
    { level: 'info', redact: { paths: [...REDACT.paths], censor: REDACT.censor } },
    sink,
  );
  log.info(payload as object, 'test line');
  return lines.join('\n');
}

describe('logger redaction', () => {
  const SECRET = 'super-secret-owner-token';

  it('redacts an Authorization header logged under req', () => {
    const output = logThrough({ req: { headers: { authorization: `Bearer ${SECRET}` } } });

    expect(output).not.toContain(SECRET);
    expect(output).toContain('[redacted]');
  });

  it('redacts a bare headers.authorization', () => {
    const output = logThrough({ headers: { authorization: `Bearer ${SECRET}` } });

    expect(output).not.toContain(SECRET);
  });

  it('redacts broker and model credentials at the top level and one level down', () => {
    const output = logThrough({
      authToken: SECRET,
      apiKey: SECRET,
      robinhood: { authToken: SECRET },
      anthropic: { apiKey: SECRET },
    });

    expect(output).not.toContain(SECRET);
  });

  it('leaves market data and decisions alone', () => {
    // The counterpart to the rule above: PRD §11 wants every strategy input
    // and output logged, so over-broad redaction would be its own failure.
    const output = logThrough({ symbol: 'AAPL', rsi14: 27.3, side: 'buy', quantity: '2' });

    expect(output).toContain('AAPL');
    expect(output).toContain('27.3');
    expect(output).not.toContain('[redacted]');
  });
});
