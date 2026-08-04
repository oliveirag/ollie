import { PrismaClient } from '@prisma/client';
import { getConfig } from '../config/index.js';

/**
 * One client per process. Prisma pools connections internally; constructing a
 * second client is how a long-running service quietly exhausts Postgres.
 */
let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  client ??= new PrismaClient({ datasourceUrl: getConfig().databaseUrl });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

/** SQLSTATE raised by the immutability triggers (see migration 20260804164305). */
export const IMMUTABILITY_ERRCODE = 'OL001';

export function isImmutabilityViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(IMMUTABILITY_ERRCODE);
}
