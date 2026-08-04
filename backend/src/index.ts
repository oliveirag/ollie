import { getConfig } from './config/index.js';
import { disconnectPrisma, getPrisma } from './db/client.js';
import { logger } from './logger.js';
import { createHealthServer } from './server/health.js';

/**
 * Service entry point. Boot order matters: configuration is validated before
 * anything can use a half-parsed value, and the database is proven reachable
 * before the process starts reporting itself healthy.
 */
async function main(): Promise<void> {
  const config = getConfig();

  logger.info(
    {
      node_env: config.nodeEnv,
      symbols: config.symbolAllowlist,
      pipeline_cron: config.pipelineCron,
      timezone: config.timezone,
      kill_switch_env: config.killSwitchEnv,
      live_trading_enabled: config.liveTradingEnabled,
    },
    'ollie orchestrator starting',
  );

  await getPrisma().$queryRaw`SELECT 1`;
  logger.info('database reachable');

  const server = createHealthServer(logger);
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port }, 'health server listening on /healthz');

  // Phase 1.6 starts the pipeline and expiry schedulers here.

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void disconnectPrisma().then(() => process.exit(0));
    });
    // Railway sends SIGTERM and waits; if a request or a run is wedged, exit
    // anyway rather than being killed mid-write with no log line explaining it.
    setTimeout(() => {
      logger.warn('shutdown timed out, exiting');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'orchestrator failed to start');
  void disconnectPrisma().finally(() => process.exit(1));
});
