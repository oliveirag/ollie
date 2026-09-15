import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Config } from '../../config/index.js';
import {
  getAppSettings,
  setAutonomy,
  setExecutionMode,
  setKillSwitch,
} from '../../db/settings.js';
import { ErrorSchema, SettingsSchema, SettingsUpdateSchema } from '../schemas.js';

/**
 * The kill switch and mode toggle (PRD §4.3).
 *
 * These live in `app_settings` rather than the environment precisely so this
 * endpoint can exist: the owner flips the switch from their phone and it takes
 * effect on the next pipeline run and the next execution, with no redeploy.
 * `KILL_SWITCH` in the environment is the separate, deploy-level override —
 * either one being on halts the pipeline, and this endpoint cannot clear it.
 */

export interface SettingsRouteOptions {
  config: Config;
}

export const registerSettingsRoutes: FastifyPluginAsyncZod<SettingsRouteOptions> = async (
  app,
  opts,
) => {
  const { config } = opts;

  app.get(
    '/settings',
    {
      schema: {
        operationId: 'getSettings',
        summary: 'Runtime safety flags',
        tags: ['settings'],
        security: [{ ownerToken: [] }],
        response: {
          200: SettingsSchema,
          401: ErrorSchema.describe('Missing or invalid owner token'),
        },
      },
    },
    async () => {
      const settings = await getAppSettings();
      return {
        kill_switch: settings.killSwitch,
        execution_mode: settings.executionMode,
        live_trading_enabled: config.liveTradingEnabled,
        autonomy: settings.autonomy,
        autonomy_enabled: config.autonomyEnabled,
        autonomy_veto_minutes: config.autonomyVetoMinutes,
      };
    },
  );

  app.put(
    '/settings',
    {
      schema: {
        operationId: 'updateSettings',
        summary: 'Flip the kill switch or the execution mode',
        description:
          'Switching `execution_mode` to live while `LIVE_TRADING_ENABLED` is false returns ' +
          '409. The toggle exists and is visibly locked, mirroring the executor\'s own double ' +
          'gate at the API edge — one gate flips at runtime, the other needs a deploy, so ' +
          'neither a bug nor a stray config change opens the path alone.',
        tags: ['settings'],
        security: [{ ownerToken: [] }],
        body: SettingsUpdateSchema,
        response: {
          200: SettingsSchema,
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid owner token'),
          409: ErrorSchema.describe(
            'Live mode requested while LIVE_TRADING_ENABLED is false, or autonomy while ' +
              'AUTONOMY_ENABLED is false',
          ),
        },
      },
    },
    async (request, reply) => {
      const {
        kill_switch: killSwitch,
        execution_mode: executionMode,
        autonomy,
      } = request.body;

      // Same shape as the live gate: the runtime half cannot open while the
      // deploy half is shut.
      if (autonomy === true && !config.autonomyEnabled) {
        return reply.code(409).send({
          error: 'autonomy_not_enabled',
          detail:
            'AUTONOMY_ENABLED is not set in the environment; autonomy needs a deploy, not a toggle',
        });
      }

      if (executionMode === 'live' && !config.liveTradingEnabled) {
        return reply.code(409).send({
          error: 'live_mode_not_enabled',
          detail:
            'LIVE_TRADING_ENABLED is not set in the environment; live mode needs a deploy, ' +
            'not a toggle',
        });
      }

      // Kill switch first. If both change in one request and the second write
      // fails, the safe half is the one that already landed.
      if (killSwitch !== undefined) {
        await setKillSwitch(killSwitch);
        request.log.warn({ kill_switch: killSwitch }, 'kill switch changed via owner API');
      }
      if (executionMode !== undefined) {
        await setExecutionMode(executionMode);
        request.log.warn({ execution_mode: executionMode }, 'execution mode changed via owner API');
      }
      if (autonomy !== undefined) {
        await setAutonomy(autonomy);
        request.log.warn({ autonomy }, 'autonomy changed via owner API');
      }

      const settings = await getAppSettings();
      return reply.code(200).send({
        kill_switch: settings.killSwitch,
        execution_mode: settings.executionMode,
        live_trading_enabled: config.liveTradingEnabled,
        autonomy: settings.autonomy,
        autonomy_enabled: config.autonomyEnabled,
        autonomy_veto_minutes: config.autonomyVetoMinutes,
      });
    },
  );
};
