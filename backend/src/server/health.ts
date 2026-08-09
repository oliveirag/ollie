import type { ExecMode } from '@prisma/client';
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
  killSwitch: boolean | null;
  executionMode: ExecMode | null;
  uptimeSeconds: number;
  checkedAt: string;
}

export async function checkHealth(): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const uptimeSeconds = Math.round(process.uptime());
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    const settings = await getAppSettings();
    return {
      status: 'ok',
      database: 'up',
      killSwitch: settings.killSwitch,
      executionMode: settings.executionMode,
      uptimeSeconds,
      checkedAt,
    };
  } catch {
    // The reason is logged by the caller; the body stays free of connection
    // strings and driver internals since this endpoint is reachable publicly.
    return {
      status: 'degraded',
      database: 'down',
      killSwitch: null,
      executionMode: null,
      uptimeSeconds,
      checkedAt,
    };
  }
}
