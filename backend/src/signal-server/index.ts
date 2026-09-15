import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildConfig } from '../config/index.js';
import { buildLogger } from '../logger.js';
import { buildSignalApp } from './app.js';
import { buildSiwaVerifier } from './siwa.js';
import { assertWallHolds } from './wall.js';

/**
 * Signal service entry point (`npm run start:signal`). A second Railway
 * service from the same image, with none of the orchestrator's secrets in its
 * environment and a database role that cannot read them either.
 *
 * Boot order: configuration, then the database as the restricted role, then
 * the wall probe — refuse to run as a role that can read the broker
 * credential — and only then listen.
 */

class MissingSignalDatabaseError extends Error {
  constructor() {
    super(
      'SIGNAL_DATABASE_URL is not set; the signal service refuses to start. It must be a ' +
        'connection string for the ollie_signal role.',
    );
    this.name = 'MissingSignalDatabaseError';
  }
}

async function main(): Promise<void> {
  const signalUrl = process.env.SIGNAL_DATABASE_URL;
  if (!signalUrl) throw new MissingSignalDatabaseError();

  // The shared config schema requires DATABASE_URL; this process has only the
  // restricted URL and must never be handed the orchestrator's. Satisfy the
  // schema with the restricted one so nothing downstream can reach a broader
  // connection through it.
  const config = buildConfig({ ...process.env, DATABASE_URL: signalUrl });
  const logger = buildLogger('ollie-signal', config.logLevel);

  logger.info(
    {
      node_env: config.nodeEnv,
      port: config.signalService.port,
      invite_codes: config.signalService.inviteCodes.length,
      public_url: config.signalService.publicUrl,
      apple_audience: config.signalService.appleAudience,
    },
    'ollie signal service starting',
  );

  const prisma = new PrismaClient({ datasourceUrl: signalUrl });
  await prisma.$queryRaw`SELECT 1`;
  await assertWallHolds(prisma);
  logger.info('database reachable as a role that cannot read the owner tables');

  const app = await buildSignalApp({
    config,
    logger,
    prisma,
    siwa: buildSiwaVerifier({ audience: config.signalService.appleAudience }),
  });
  await app.listen({ port: config.signalService.port, host: '0.0.0.0' });
  logger.info({ port: config.signalService.port }, 'signal service listening on /healthz, /v1 and /mcp');

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    void app
      .close()
      .catch(() => undefined)
      .then(() => prisma.$disconnect())
      .then(() => process.exit(0));
    setTimeout(() => {
      logger.warn('shutdown timed out, exiting');
      process.exit(1);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Not the shared logger: it may be the config that failed.
  console.error('signal service failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
