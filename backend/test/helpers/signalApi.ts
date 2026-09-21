import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildConfig, type Config } from '../../src/config/index.js';
import { buildSignalApp, type SignalAppDeps } from '../../src/signal-server/app.js';
import { stubSiwaVerifier } from '../../src/signal-server/siwa.js';
import { signalPrisma } from './db.js';

/**
 * Build the signal service against the test database, connected as the
 * `ollie_signal` role — the same role production uses, so a route that needs
 * a table the role cannot read fails here first.
 */

export const TEST_INVITE_CODES = ['FRIENDS-1', 'FRIENDS-2'];
export const TEST_PUBLIC_URL = 'https://signal.test';

/** The same stub the dev server runs with SIWA_STUB=true. */
export const stubSiwa = stubSiwaVerifier;

export function fakeIdentityToken(sub: string, email?: string): string {
  return `fake:${JSON.stringify({ sub, ...(email ? { email } : {}) })}`;
}

export function signalTestConfig(overrides: Partial<Config> = {}): Config {
  const base = buildConfig();
  return {
    ...base,
    signalService: {
      ...base.signalService,
      inviteCodes: TEST_INVITE_CODES,
      publicUrl: TEST_PUBLIC_URL,
    },
    ...overrides,
  };
}

export async function buildTestSignalApp(
  overrides: Partial<Omit<SignalAppDeps, 'prisma'>> = {},
): Promise<FastifyInstance> {
  return buildSignalApp({
    config: signalTestConfig(),
    logger: pino({ level: 'silent' }),
    prisma: signalPrisma(),
    siwa: stubSiwa,
    ...overrides,
  });
}

/** Sign in as `sub` (first time with an invite code) and return the app token. */
export async function signIn(
  app: FastifyInstance,
  sub: string,
  inviteCode: string | undefined = TEST_INVITE_CODES[0],
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/session',
    payload: { identity_token: fakeIdentityToken(sub), invite_code: inviteCode },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { token: string }).token;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
