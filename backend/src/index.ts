import { getConfig } from './config/index.js';
import { disconnectPrisma, getPrisma } from './db/client.js';
import { getAppSettings } from './db/settings.js';
import { bootstrapOAuthState } from './db/oauthState.js';
import { logger } from './logger.js';
import { McpBrokerAdapter } from './orchestrator/robinhood/mcpClient.js';
import { buildNotifier } from './orchestrator/push/notify.js';
import { startScheduler } from './orchestrator/scheduler.js';
import { buildApp } from './server/app.js';

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

  // Move a first-boot credential out of the environment before the scheduler
  // can reach the broker. A no-op once the database holds a token.
  await bootstrapOAuthState(config);

  const broker = new McpBrokerAdapter({ logger });
  const notifier = buildNotifier(config, logger);
  const scheduler = startScheduler({ broker, config, logger, notifier });

  // Throws when OWNER_API_TOKEN is unset, taking the whole service down. That
  // is the intended failure: the approval and kill-switch surface must not be
  // reachable without a credential, and a process that starts anyway would
  // hide the misconfiguration behind a healthy /healthz.
  const app = await buildApp({ config, logger, broker });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info({ port: config.port }, 'owner API listening on /healthz and /v1');

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Stop scheduling first so nothing new starts while we drain. Fastify's
    // close awaits in-flight requests, which matters here: one of them may be
    // an approval midway through writing a fill.
    scheduler.stop();
    void app
      .close()
      .then(() => broker.close())
      .catch(() => undefined)
      .then(() => disconnectPrisma())
      .then(() => process.exit(0));

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
