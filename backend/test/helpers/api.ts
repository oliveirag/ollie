import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildConfig, type Config } from '../../src/config/index.js';
import type { BrokerAdapter } from '../../src/orchestrator/robinhood/client.js';
import { MockBrokerAdapter } from '../../src/orchestrator/robinhood/mockClient.js';
import { buildApp } from '../../src/server/app.js';

export const TEST_OWNER_TOKEN = process.env.OWNER_API_TOKEN!;

/**
 * Silent regardless of LOG_LEVEL. `.env` sets a level and test/setup.ts only
 * fills one in when absent, so a developer's LOG_LEVEL=info would otherwise
 * bury every assertion under Fastify's per-request logging.
 */
const testLogger = pino({ level: 'silent' });

/**
 * Build the API against the test database. Config is built from the current
 * environment rather than taken from `getConfig()` so a test can vary one
 * setting without poisoning the process-wide cache for every file after it.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...buildConfig(), ...overrides };
}

export async function buildTestApp(
  overrides: Partial<Config> = {},
  broker: BrokerAdapter = new MockBrokerAdapter(),
): Promise<FastifyInstance> {
  return buildApp({ config: testConfig(overrides), logger: testLogger, broker });
}

export function authHeader(token: string = TEST_OWNER_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
