import type { ExecMode, PrismaClient } from '@prisma/client';
import { getConfig, type Config } from '../config/index.js';
import { getPrisma } from '../db/client.js';
import { getAppSettings } from '../db/settings.js';

/**
 * The health probe's logic, independent of how it is served. Phase 2 moved the
 * transport onto Fastify (see routes/health.ts); the report shape and its
 * status codes are unchanged, because Railway's health check already keys on
 * them.
 */

export interface HealthReport {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  /**
   * Effective answer to "is the pipeline halted?" — true when *either* half is
   * on, matching the gate in `orchestrator/pipeline.ts`. Reporting only the
   * database half (which this did until 2026-08-12) meant a deploy halted by
   * the environment override advertised `killSwitch: false`, and this endpoint
   * is what the runbook tells you to trust about production's actual mode.
   */
  killSwitch: boolean | null;
  /**
   * The environment override. Read from config rather than the database, so it
   * stays truthful even in the degraded branch. Clearing this one needs a
   * redeploy — which is exactly why it is worth telling apart from the other.
   */
  killSwitchEnv: boolean;
  /** The runtime half in `app_settings`; the one the iOS app flips. */
  killSwitchDb: boolean | null;
  executionMode: ExecMode | null;
  uptimeSeconds: number;
  checkedAt: string;
}

export async function checkHealth(
  config: Config = getConfig(),
  prisma: PrismaClient = getPrisma(),
): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const uptimeSeconds = Math.round(process.uptime());
  const killSwitchEnv = config.killSwitchEnv;
  try {
    await prisma.$queryRaw`SELECT 1`;
    const settings = await getAppSettings(prisma);
    return {
      status: 'ok',
      database: 'up',
      killSwitch: killSwitchEnv || settings.killSwitch,
      killSwitchEnv,
      killSwitchDb: settings.killSwitch,
      executionMode: settings.executionMode,
      uptimeSeconds,
      checkedAt,
    };
  } catch {
    // The reason is logged by the caller; the body stays free of connection
    // strings and driver internals since this endpoint is reachable publicly.
    //
    // The effective switch is still knowable in one direction: the environment
    // override alone is enough to halt the pipeline, so `true` is a fact even
    // with the database unreachable. Only a false override leaves the answer
    // genuinely unknown, and that is what null means here.
    return {
      status: 'degraded',
      database: 'down',
      killSwitch: killSwitchEnv ? true : null,
      killSwitchEnv,
      killSwitchDb: null,
      executionMode: null,
      uptimeSeconds,
      checkedAt,
    };
  }
}
