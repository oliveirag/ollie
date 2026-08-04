import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import { getPrisma } from '../db/client.js';
import { getAppSettings } from '../db/settings.js';

/**
 * The whole HTTP surface for Phases 0-1: a health endpoint for the platform.
 * The REST API the iOS app talks to arrives in Phase 2, generated against
 * docs/openapi.yaml — deliberately not started here so there is no half-built
 * API to accidentally depend on.
 */

export interface HealthReport {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  killSwitch: boolean | null;
  executionMode: string | null;
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

export function createHealthServer(logger: Logger): Server {
  return createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/healthz') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    void checkHealth().then((report) => {
      if (report.status !== 'ok') {
        logger.error({ report }, 'health check degraded');
      }
      res.writeHead(report.status === 'ok' ? 200 : 503, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify(report));
    });
  });
}
