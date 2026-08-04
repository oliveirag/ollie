import { getConfig } from './config/index.js';
import { disconnectPrisma, getPrisma } from './db/client.js';
import { getAppSettings } from './db/settings.js';
import { logger } from './logger.js';
import { McpBrokerAdapter } from './orchestrator/robinhood/mcpClient.js';
import { startScheduler } from './orchestrator/scheduler.js';
import { createHealthServer } from './server/health.js';

/**
 * Service entry point. Boot order matters: configuration is validated before
 * anything can use a half-parsed value, and the database is proven reachable
 * before the process starts reporting itself healthy or running a pipeline.
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
  const settings = await getAppSettings();
  logger.info(
    { execution_mode: settings.executionMode, kill_switch: settings.killSwitch },
    'database reachable; runtime flags loaded',
  );

  const broker = new McpBrokerAdapter({ logger });
  const scheduler = startScheduler({ broker, config, logger });

  const server = createHealthServer(logger);
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port }, 'health server listening on /healthz');

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Stop scheduling first so nothing new starts while we drain.
    scheduler.stop();
    server.close(() => {
      void broker
        .close()
        .catch(() => undefined)
        .then(() => disconnectPrisma())
        .then(() => process.exit(0));
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
