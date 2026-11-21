import {
  Prisma,
  type ExecMode,
  type PrismaClient,
  type Signal,
  type SignalSide,
  type SignalStatus,
  type SignalType,
} from '@prisma/client';
import { getPrisma } from './client.js';

/**
 * The entire write surface over `signals`. There is deliberately no generic
 * update helper: the immutability triggers would reject one anyway, and an
 * exported `updateSignal` invites callers to try.
 */

export interface InsertSignalInput {
  symbol: string;
  side: SignalSide;
  signalType: SignalType;
  /** Decimal string. Never a float — see "Money is decimal strings" in backend/README.md. */
  quantity: string;
  thesis: string | null;
  thesisSource: 'llm' | 'fallback_template';
  /**
   * These land in jsonb columns. They are typed `unknown` rather than
   * `Prisma.InputJsonValue` because the review snapshot wraps a broker response
   * whose shape is not ours to declare — narrowing it here would force a cast
   * at every call site instead of the single documented one below.
   */
  indicators: unknown;
  reviewSnapshot: unknown;
  executionMode: ExecMode;
  dedupeKey: string;
  /** Phase 5: set while autonomy is on; the sweep may approve after this. */
  autoDecideAt?: Date | null;
}

export type DecidedStatus = Extract<SignalStatus, 'approved' | 'rejected' | 'expired'>;

/** A signal with this dedupe key already exists; the caller proposed a duplicate. */
export class DuplicateSignalError extends Error {
  constructor(public readonly dedupeKey: string) {
    super(`a signal already exists for dedupe key ${dedupeKey}`);
    this.name = 'DuplicateSignalError';
  }
}

/** The signal was already decided, or does not exist. Decisions happen once. */
export class SignalNotPendingError extends Error {
  constructor(public readonly signalId: string) {
    super(`signal ${signalId} is not pending`);
    this.name = 'SignalNotPendingError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function insertSignal(
  input: InsertSignalInput,
  prisma: PrismaClient = getPrisma(),
): Promise<Signal> {
  try {
    return await prisma.signal.create({
      data: {
        symbol: input.symbol,
        side: input.side,
        signalType: input.signalType,
        quantity: new Prisma.Decimal(input.quantity),
        thesis: input.thesis,
        thesisSource: input.thesisSource,
        // The one place jsonb payloads cross into Prisma's JSON types.
        indicators: input.indicators as Prisma.InputJsonValue,
        reviewSnapshot: input.reviewSnapshot as Prisma.InputJsonValue,
        executionMode: input.executionMode,
        dedupeKey: input.dedupeKey,
        autoDecideAt: input.autoDecideAt ?? null,
      },
    });
  } catch (error) {
    // The unique index is the race-proof half of dedupe: two runs overlapping
    // on the same bar both pass the in-process check, and exactly one lands.
    if (isUniqueViolation(error)) throw new DuplicateSignalError(input.dedupeKey);
    throw error;
  }
}

/**
 * Move a pending signal to a terminal status and record why, writing the
 * `signal_events` audit row in the same transaction. The `status: 'pending'`
 * predicate is the concurrency guard: two concurrent approvals contend on the
 * same row and the loser sees zero rows updated.
 */
export async function transitionSignal(
  signalId: string,
  to: DecidedStatus,
  reason: string,
  options: { now?: Date; prisma?: PrismaClient } = {},
): Promise<Signal> {
  const prisma = options.prisma ?? getPrisma();
  const decidedAt = options.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.signal.updateMany({
      where: { id: signalId, status: 'pending' },
      data: { status: to, decidedAt, decideReason: reason },
    });
    if (updated.count === 0) throw new SignalNotPendingError(signalId);

    await tx.signalEvent.create({
      data: { signalId, fromStatus: 'pending', toStatus: to, reason },
    });

    return tx.signal.findUniqueOrThrow({ where: { id: signalId } });
  });
}

/** The signal was already published, or does not exist. Publication happens once. */
export class SignalAlreadyPublishedError extends Error {
  constructor(public readonly signalId: string) {
    super(`signal ${signalId} is already published or does not exist`);
    this.name = 'SignalAlreadyPublishedError';
  }
}

/**
 * The one-way publication flip (Phase 4, decision 1). Called by the decision
 * route once the approving fill's execution row exists, and by the
 * reconciliation sweep for anything that route failed to flip. The
 * `published: false` predicate makes the two callers safe to overlap: exactly
 * one of them lands the update and the other sees zero rows.
 */
export async function publishSignal(
  signalId: string,
  options: { now?: Date; prisma?: PrismaClient } = {},
): Promise<Signal> {
  const prisma = options.prisma ?? getPrisma();
  const publishedAt = options.now ?? new Date();
  const updated = await prisma.signal.updateMany({
    where: { id: signalId, published: false },
    data: { published: true, publishedAt },
  });
  if (updated.count === 0) throw new SignalAlreadyPublishedError(signalId);
  return prisma.signal.findUniqueOrThrow({ where: { id: signalId } });
}

/**
 * Approved signals whose fill exists but whose publication flip never landed:
 * the crash window between the executor returning and the route publishing.
 * The sweep closes it. Oldest first, so a backlog publishes in fill order.
 */
export async function listFilledUnpublishedSignals(
  prisma: PrismaClient = getPrisma(),
): Promise<Signal[]> {
  return prisma.signal.findMany({
    where: { status: 'approved', published: false, executions: { some: {} } },
    orderBy: { decidedAt: 'asc' },
  });
}

/**
 * The columns of `signals` the subscriber service's role is granted (see the
 * signal_role_published_only migration). Selecting anything else as that role
 * is a permission error, so the subscriber reads name them explicitly.
 */
export const PUBLISHED_SIGNAL_SELECT = {
  id: true,
  createdAt: true,
  symbol: true,
  side: true,
  signalType: true,
  quantity: true,
  thesis: true,
  thesisSource: true,
  indicators: true,
  published: true,
  publishedAt: true,
} as const satisfies Prisma.SignalSelect;

/** A published signal as the subscriber role can read it, plus its review estimate. */
export type PublishedSignalRow = Prisma.SignalGetPayload<{ select: typeof PUBLISHED_SIGNAL_SELECT }> & {
  /** From the published_signal_estimates view; null when the snapshot has none. */
  estimatedPrice: string | null;
};

/** Keyset position in the feed: strictly older than this (published_at, id). */
export interface FeedCursor {
  publishedAt: Date;
  /** Breaks ties when a sweep published several signals at one instant. */
  id?: string;
}

async function withEstimates(
  rows: Array<Prisma.SignalGetPayload<{ select: typeof PUBLISHED_SIGNAL_SELECT }>>,
  prisma: PrismaClient,
): Promise<PublishedSignalRow[]> {
  if (rows.length === 0) return [];
  const estimates = await prisma.$queryRaw<Array<{ signal_id: string; estimated_price: string | null }>>`
    SELECT signal_id::text AS signal_id, estimated_price
    FROM published_signal_estimates
    WHERE signal_id = ANY(${rows.map((row) => row.id)}::uuid[])
  `;
  const byId = new Map(estimates.map((row) => [row.signal_id, row.estimated_price]));
  return rows.map((row) => ({ ...row, estimatedPrice: byId.get(row.id) ?? null }));
}

/**
 * The subscriber feed's read: published signals, newest publication first,
 * keyset-paginated on (`published_at`, `id`) so a page stays stable while new
 * signals land ahead of it, and so signals one sweep published at the same
 * instant are not skipped at a page boundary. `before` is exclusive.
 */
export async function listPublishedSignals(
  options: { limit: number; before?: FeedCursor; since?: Date },
  prisma: PrismaClient = getPrisma(),
): Promise<PublishedSignalRow[]> {
  const { before, since } = options;
  const beforeClause: Prisma.SignalWhereInput | null = before
    ? before.id
      ? {
          OR: [
            { publishedAt: { lt: before.publishedAt } },
            { publishedAt: before.publishedAt, id: { lt: before.id } },
          ],
        }
      : { publishedAt: { lt: before.publishedAt } }
    : null;
  const rows = await prisma.signal.findMany({
    where: {
      published: true,
      AND: [
        ...(beforeClause ? [beforeClause] : []),
        ...(since ? [{ publishedAt: { gte: since } }] : []),
      ],
    },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    take: options.limit,
    select: PUBLISHED_SIGNAL_SELECT,
  });
  return withEstimates(rows, prisma);
}

/** One published signal, or null — an unpublished id reads as absent on purpose. */
export async function getPublishedSignal(
  signalId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<PublishedSignalRow | null> {
  const row = await prisma.signal.findFirst({
    where: { id: signalId, published: true },
    select: PUBLISHED_SIGNAL_SELECT,
  });
  if (!row) return null;
  const [withEstimate] = await withEstimates([row], prisma);
  return withEstimate ?? null;
}

export async function getSignal(
  signalId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<Signal | null> {
  return prisma.signal.findUnique({ where: { id: signalId } });
}

export async function listPendingSignals(
  prisma: PrismaClient = getPrisma(),
): Promise<Signal[]> {
  return prisma.signal.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' } });
}

/**
 * Signals that have reached a terminal status, newest first — the app's
 * history view. Capped because the owner scrolls a recent window, not the
 * whole archive; the track record (Phase 3) is where the full history lives.
 */
export async function listDecidedSignals(
  limit = 50,
  prisma: PrismaClient = getPrisma(),
): Promise<Signal[]> {
  return prisma.signal.findMany({
    where: { status: { in: ['approved', 'rejected', 'expired'] } },
    orderBy: { decidedAt: 'desc' },
    take: limit,
  });
}

/** Pending signals whose veto window has closed, oldest first (Phase 5). */
export async function listAutoDecidableSignals(
  now: Date,
  prisma: PrismaClient = getPrisma(),
): Promise<Signal[]> {
  return prisma.signal.findMany({
    where: { status: 'pending', autoDecideAt: { not: null, lte: now } },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * When the record went live: the first live-mode signal's publication. Read
 * from `signals`, which both database roles can see, so the owner's and the
 * subscriber's answer come from the same row. Null while the record is paper.
 */
export async function firstLivePublishedAt(
  prisma: PrismaClient = getPrisma(),
): Promise<Date | null> {
  const first = await prisma.signal.findFirst({
    where: { executionMode: 'live', published: true },
    orderBy: { publishedAt: 'asc' },
    select: { publishedAt: true },
  });
  return first?.publishedAt ?? null;
}

/**
 * Pending signals created before `cutoff`, oldest first. The expiry sweep
 * passes the floor window's cutoff and then applies each signal's exact
 * deadline (orchestrator/expiry.ts).
 */
export async function listExpiredPendingSignals(
  cutoff: Date,
  prisma: PrismaClient = getPrisma(),
): Promise<Signal[]> {
  return prisma.signal.findMany({
    where: { status: 'pending', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
  });
}

/** Which of these dedupe keys are already taken. Cheap pre-filter before insert. */
export async function findExistingDedupeKeys(
  keys: readonly string[],
  prisma: PrismaClient = getPrisma(),
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await prisma.signal.findMany({
    where: { dedupeKey: { in: [...keys] } },
    select: { dedupeKey: true },
  });
  return new Set(rows.map((r) => r.dedupeKey));
}

/**
 * Signals proposed since `since`, used for the max-daily-trades cap. Rejected
 * and expired signals still count: the cap limits how much the strategy asks
 * of the owner per day, not how much the owner says yes to.
 */
export async function countSignalsSince(
  since: Date,
  prisma: PrismaClient = getPrisma(),
): Promise<number> {
  return prisma.signal.count({ where: { createdAt: { gte: since } } });
}

export async function listSignalEvents(
  signalId: string,
  prisma: PrismaClient = getPrisma(),
) {
  return prisma.signalEvent.findMany({
    where: { signalId },
    orderBy: { createdAt: 'asc' },
  });
}
