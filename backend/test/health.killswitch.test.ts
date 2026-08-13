import { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, type Config } from '../src/config/index.js';
import { setKillSwitch } from '../src/db/settings.js';
import { checkHealth } from '../src/server/health.js';
import { resetDatabase, testPrisma } from './helpers/db.js';

/**
 * The kill switch has two independent halves, and until 2026-08-12 this report
 * showed only one of them. A production deploy halted by the environment
 * override answered `killSwitch: false`, which is the opposite of true for the
 * question the endpoint exists to answer.
 *
 * These pin all four combinations plus the degraded case, because the failure
 * mode is silent: every field is present and well-typed, just wrong.
 */
function configWith(killSwitchEnv: boolean): Config {
  return { ...buildConfig(), killSwitchEnv };
}

describe('healthz kill switch reporting', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('reports not-halted when neither half is on', async () => {
    await setKillSwitch(false, testPrisma());

    const report = await checkHealth(configWith(false), testPrisma());

    expect(report).toMatchObject({
      killSwitch: false,
      killSwitchEnv: false,
      killSwitchDb: false,
    });
  });

  it('reports halted when only the database half is on', async () => {
    await setKillSwitch(true, testPrisma());

    const report = await checkHealth(configWith(false), testPrisma());

    expect(report).toMatchObject({
      killSwitch: true,
      killSwitchEnv: false,
      killSwitchDb: true,
    });
  });

  it('reports halted when only the environment override is on', async () => {
    // The regression this whole change exists for: the database half is off, so
    // the old report said false while the pipeline was in fact halted.
    await setKillSwitch(false, testPrisma());

    const report = await checkHealth(configWith(true), testPrisma());

    expect(report).toMatchObject({
      killSwitch: true,
      killSwitchEnv: true,
      killSwitchDb: false,
    });
  });

  it('distinguishes the halves when both are on', async () => {
    await setKillSwitch(true, testPrisma());

    const report = await checkHealth(configWith(true), testPrisma());

    // Both, not just the effective answer — clearing this needs a redeploy AND
    // an API call, and a report that collapsed them would hide half the work.
    expect(report).toMatchObject({
      killSwitch: true,
      killSwitchEnv: true,
      killSwitchDb: true,
    });
  });

  describe('with the database unreachable', () => {
    const dead = new PrismaClient({
      datasources: { db: { url: 'postgresql://nobody@127.0.0.1:1/nope' } },
    });

    it('still reports the environment override, and the effective answer with it', async () => {
      const report = await checkHealth(configWith(true), dead);

      // killSwitchEnv comes from config, not a query, so a database outage
      // cannot take it down with it. And a true override halts the pipeline on
      // its own, so the effective answer stays knowable.
      expect(report).toMatchObject({
        status: 'degraded',
        database: 'down',
        killSwitch: true,
        killSwitchEnv: true,
        killSwitchDb: null,
      });
    });

    it('admits the effective answer is unknown when the override is off', async () => {
      const report = await checkHealth(configWith(false), dead);

      // Null, not false. The database half could be on and we cannot see it —
      // reporting false here would be the same class of lie this change fixes.
      expect(report).toMatchObject({
        status: 'degraded',
        killSwitch: null,
        killSwitchEnv: false,
        killSwitchDb: null,
      });
    });
  });
});
