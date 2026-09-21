import type { AppSettings, ExecMode, PrismaClient } from '@prisma/client';
import { getPrisma } from './client.js';

const SETTINGS_ID = 1;

/**
 * Runtime safety flags. These live in the database rather than the environment
 * so the kill switch survives a restart and so the iOS app can flip it in
 * Phase 2 without a redeploy.
 */
export async function getAppSettings(
  prisma: PrismaClient = getPrisma(),
): Promise<AppSettings> {
  // upsert, not findUnique: a missing row must never be readable as
  // "kill switch off". If it is gone, recreate it in the safe default state.
  return prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID, killSwitch: false, executionMode: 'paper' },
  });
}

export async function setKillSwitch(
  on: boolean,
  prisma: PrismaClient = getPrisma(),
): Promise<AppSettings> {
  await getAppSettings(prisma);
  return prisma.appSettings.update({
    where: { id: SETTINGS_ID },
    data: { killSwitch: on },
  });
}

export async function setExecutionMode(
  mode: ExecMode,
  prisma: PrismaClient = getPrisma(),
): Promise<AppSettings> {
  await getAppSettings(prisma);
  return prisma.appSettings.update({
    where: { id: SETTINGS_ID },
    data: { executionMode: mode },
  });
}

/** Runtime half of the autonomy gate (Phase 5). The deploy half is AUTONOMY_ENABLED. */
export async function setAutonomy(
  on: boolean,
  prisma: PrismaClient = getPrisma(),
): Promise<AppSettings> {
  await getAppSettings(prisma);
  return prisma.appSettings.update({
    where: { id: SETTINGS_ID },
    data: { autonomy: on },
  });
}
