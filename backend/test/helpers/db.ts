import { PrismaClient } from '@prisma/client';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ollie:ollie@localhost:5432/ollie_test';

let prisma: PrismaClient | null = null;

export function testPrisma(): PrismaClient {
  prisma ??= new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  return prisma;
}

/**
 * TRUNCATE, not DELETE: the immutability triggers are row-level and refuse
 * every delete, which is the point of them. TRUNCATE is statement-level and so
 * bypasses them — the one deliberate escape hatch, available only to test setup
 * because nothing in `src/` issues it.
 */
export async function resetDatabase(): Promise<void> {
  const db = testPrisma();
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "track_record", "executions", "signal_events", "signals" RESTART IDENTITY CASCADE',
  );
  await db.appSettings.upsert({
    where: { id: 1 },
    update: { killSwitch: false, executionMode: 'paper' },
    create: { id: 1, killSwitch: false, executionMode: 'paper' },
  });
}

export async function closeTestPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

let counter = 0;

/** Unique dedupe key per call, so tests never collide with each other. */
export function uniqueDedupeKey(prefix = 'test'): string {
  counter += 1;
  return `${prefix}:${process.pid}:${Date.now()}:${counter}`;
}
