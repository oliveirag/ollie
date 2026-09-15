import type { PrismaClient } from '@prisma/client';

/**
 * The boot-time probe behind the owner/subscriber wall (Phase 4, decision 4).
 *
 * The signal service must connect as a role that cannot read the broker
 * credential. Rather than trust that the deploy's `SIGNAL_DATABASE_URL` names
 * the right role, the service tries to read each owner-only table on startup
 * and refuses to run if any read *succeeds*. Mirrors the owner API refusing
 * to boot tokenless: a misconfigured service that is down is safer than one
 * that is up.
 */
export const OWNER_ONLY_TABLES = [
  'oauth_state',
  'app_settings',
  'devices',
  'executions',
  'signal_events',
  'live_orders',
] as const;

export class WallBreachError extends Error {
  constructor(public readonly table: string) {
    super(
      `refusing to start: this database role can read "${table}". SIGNAL_DATABASE_URL must ` +
        'connect as the ollie_signal role, which is denied every owner-only table.',
    );
    this.name = 'WallBreachError';
  }
}

export async function assertWallHolds(prisma: PrismaClient): Promise<void> {
  for (const table of OWNER_ONLY_TABLES) {
    let readable = false;
    try {
      await prisma.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`);
      readable = true;
    } catch {
      // A permission error is the expected outcome.
    }
    if (readable) throw new WallBreachError(table);
  }
}
