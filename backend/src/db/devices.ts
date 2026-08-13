import type { Device, PrismaClient } from '@prisma/client';
import { getPrisma } from './client.js';

/**
 * APNs device tokens. Unlike signals, this table is ordinary mutable state:
 * tokens rotate, devices are wiped, and a stale row is garbage rather than
 * history worth keeping.
 */

export async function upsertDevice(
  input: { apnsToken: string; environment: 'sandbox' | 'production' },
  prisma: PrismaClient = getPrisma(),
): Promise<Device> {
  return prisma.device.upsert({
    where: { apnsToken: input.apnsToken },
    update: { environment: input.environment, lastSeenAt: new Date() },
    create: { apnsToken: input.apnsToken, environment: input.environment },
  });
}

export async function listDevices(prisma: PrismaClient = getPrisma()): Promise<Device[]> {
  return prisma.device.findMany({ orderBy: { lastSeenAt: 'desc' } });
}

/** Called when APNs reports a token as gone. Idempotent. */
export async function deleteDevice(
  apnsToken: string,
  prisma: PrismaClient = getPrisma(),
): Promise<void> {
  await prisma.device.deleteMany({ where: { apnsToken } });
}
