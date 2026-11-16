import { Prisma, PrismaClient } from '@prisma/client';
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

/**
 * A client or an open interactive transaction. Writes that must land together
 * (an execution and the lots it settles) take this, so the caller can hand
 * them one transaction and a crash between them leaves neither.
 */
export type Db = PrismaClient | Prisma.TransactionClient;

/** True for a full client, false inside a transaction (which cannot nest). */
export function isFullClient(db: Db): db is PrismaClient {
  return '$transaction' in db;
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
