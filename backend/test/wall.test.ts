import { describe, expect, it } from 'vitest';
import { OWNER_ONLY_TABLES, WallBreachError, assertWallHolds } from '../src/signal-server/wall.js';
import { signalPrisma, testPrisma } from './helpers/db.js';

/**
 * The boot-time probe. Connected as `ollie_signal` it passes; connected as
 * the orchestrator's role it refuses, naming the first table it could read.
 * The second case is the misconfiguration the probe exists to catch: a
 * deploy that pasted the wrong DATABASE_URL into the subscriber service.
 */
describe('assertWallHolds', () => {
  it('passes for the ollie_signal role', async () => {
    await expect(assertWallHolds(signalPrisma())).resolves.toBeUndefined();
  });

  it('refuses a role that can read an owner-only table', async () => {
    await expect(assertWallHolds(testPrisma())).rejects.toThrow(WallBreachError);
    await expect(assertWallHolds(testPrisma())).rejects.toThrow(OWNER_ONLY_TABLES[0]);
  });
});
