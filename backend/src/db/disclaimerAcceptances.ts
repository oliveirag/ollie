import type { DisclaimerAcceptance, PrismaClient } from '@prisma/client';
import { getPrisma } from './client.js';

/**
 * Append-only consent records (Phase 4, decision 6). There is no update or
 * delete here and the database would refuse one anyway. A subscriber who
 * accepts twice has two rows; the newest for the current version is what
 * the token mint checks.
 */

export async function recordAcceptance(
  input: { userId: string; disclaimerVersion: string; acceptedAt?: Date },
  prisma: PrismaClient = getPrisma(),
): Promise<DisclaimerAcceptance> {
  return prisma.disclaimerAcceptance.create({
    data: {
      userId: input.userId,
      disclaimerVersion: input.disclaimerVersion,
      acceptedAt: input.acceptedAt ?? new Date(),
    },
  });
}

/** Whether this user has accepted exactly this version of the text. */
export async function hasAccepted(
  userId: string,
  disclaimerVersion: string,
  prisma: PrismaClient = getPrisma(),
): Promise<boolean> {
  const count = await prisma.disclaimerAcceptance.count({
    where: { userId, disclaimerVersion },
  });
  return count > 0;
}

export async function listAcceptances(
  userId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<DisclaimerAcceptance[]> {
  return prisma.disclaimerAcceptance.findMany({
    where: { userId },
    orderBy: { acceptedAt: 'asc' },
  });
}
