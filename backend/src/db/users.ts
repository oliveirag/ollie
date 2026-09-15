import type { PrismaClient, User } from '@prisma/client';
import { getPrisma } from './client.js';

/**
 * Subscribers, keyed by the Sign in with Apple subject (Phase 4, decision 3).
 *
 * Deliberately no delete: acceptance rows reference users and are append-only.
 * "Forget me" is `eraseEmail` — the identity row stays, keyed to an opaque
 * Apple subject whose email is gone (Phase 4 risk 9).
 */

export interface UpsertSubscriberInput {
  appleUserId: string;
  /** Apple's private relay may withhold it; null is normal. */
  email: string | null;
  /** Recorded only on first sign-in, as the soft-launch audit trail. */
  inviteCode: string | null;
}

export async function findUserByAppleId(
  appleUserId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<User | null> {
  return prisma.user.findUnique({ where: { appleUserId } });
}

export async function createSubscriber(
  input: UpsertSubscriberInput,
  prisma: PrismaClient = getPrisma(),
): Promise<User> {
  return prisma.user.create({
    data: {
      role: 'subscriber',
      appleUserId: input.appleUserId,
      email: input.email,
      inviteCode: input.inviteCode,
    },
  });
}

export async function getUser(
  id: string,
  prisma: PrismaClient = getPrisma(),
): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

/** The one update the service makes to a user row. */
export async function eraseEmail(
  id: string,
  prisma: PrismaClient = getPrisma(),
): Promise<void> {
  await prisma.user.update({ where: { id }, data: { email: null } });
}
