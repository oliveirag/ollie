import type { PrismaClient, User } from '@prisma/client';
import { getPrisma } from './client.js';

/**
 * Subscribers, keyed by the Sign in with Apple subject (Phase 4, decision 3).
 *
 * Deliberately no delete: acceptance rows reference users and are append-only.
 * Account deletion is `deleteSubscriberAccount`, which tombstones the row
 * through a narrow database function instead: the Apple subject becomes
 * opaque, email and invite code are cleared, every token is revoked.
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

/**
 * Delete a subscriber's account (App Store guideline 5.1.1(v)). Runs
 * `ollie_delete_subscriber`, the one operation the signal role has for this,
 * in a single statement so the tombstone and the token revocations land
 * together. Returns false when there was nothing to delete: an unknown id, the
 * owner, or an account already deleted.
 */
export async function deleteSubscriberAccount(
  id: string,
  prisma: PrismaClient = getPrisma(),
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ deleted: boolean }>>`
    SELECT ollie_delete_subscriber(${id}::uuid) AS deleted
  `;
  return rows[0]?.deleted === true;
}
