import {
  Prisma,
  type PositionStatus,
  type PrismaClient,
  type TrackRecord,
} from '@prisma/client';
import { getPrisma } from './client.js';

export interface AppendTrackRecordInput {
  signalId: string;
  /** Decimal strings throughout; these numbers are the published performance. */
  entryPrice: string;
  exitPrice?: string | null;
  realizedPnl?: string | null;
  unrealizedPnl?: string | null;
  /** The quote an `unrealizedPnl` was computed against; travels with it. */
  markPrice?: string | null;
  /** The sell signal that closed this lot. Null on open and mark rows. */
  closedBySignalId?: string | null;
  status: PositionStatus;
  recordedAt?: Date;
}

/**
 * Append a track-record row. There is no update counterpart by design: a
 * position's later state is a new row with a later `recorded_at`, so the whole
 * history of a claim stays inspectable (PRD §4.4).
 */
export async function appendTrackRecord(
  input: AppendTrackRecordInput,
  prisma: PrismaClient = getPrisma(),
): Promise<TrackRecord> {
  return prisma.trackRecord.create({
    data: {
      signalId: input.signalId,
      entryPrice: new Prisma.Decimal(input.entryPrice),
      exitPrice: input.exitPrice == null ? null : new Prisma.Decimal(input.exitPrice),
      realizedPnl: input.realizedPnl == null ? null : new Prisma.Decimal(input.realizedPnl),
      unrealizedPnl:
        input.unrealizedPnl == null ? null : new Prisma.Decimal(input.unrealizedPnl),
      markPrice: input.markPrice == null ? null : new Prisma.Decimal(input.markPrice),
      closedBySignalId: input.closedBySignalId ?? null,
      status: input.status,
      recordedAt: input.recordedAt ?? new Date(),
    },
  });
}

export async function listTrackRecord(
  signalId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<TrackRecord[]> {
  return prisma.trackRecord.findMany({ where: { signalId }, orderBy: { recordedAt: 'asc' } });
}

export interface OpenLot {
  signalId: string;
  symbol: string;
  side: string;
  quantity: string;
  entryPrice: string;
  recordedAt: Date;
}

/**
 * Every signal whose *latest* track-record row is still open, with the signal
 * detail the dashboard needs to render it.
 *
 * `DISTINCT ON` rather than a per-signal query: the table is append-only, so
 * "the current state of a position" is always the newest row for that signal,
 * and a correction written as a new row must not resurrect the state it
 * replaced. Doing that in SQL also keeps this one round trip instead of one
 * per open position.
 */
export async function listOpenLots(prisma: PrismaClient = getPrisma()): Promise<OpenLot[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      signal_id: string;
      symbol: string;
      side: string;
      quantity: Prisma.Decimal;
      entry_price: Prisma.Decimal;
      recorded_at: Date;
      status: string;
    }>
  >`
    SELECT DISTINCT ON (tr.signal_id)
      tr.signal_id, tr.entry_price, tr.recorded_at, tr.status::text AS status,
      s.symbol, s.side::text AS side, s.quantity
    FROM track_record tr
    JOIN signals s ON s.id = tr.signal_id
    ORDER BY tr.signal_id, tr.recorded_at DESC, tr.id DESC
  `;

  // Filtered here, not in a WHERE clause. `WHERE status = 'open'` would run
  // before DISTINCT ON and so would pick the newest *open* row even when a
  // newer *closed* row exists — resurrecting a position Phase 3 had closed.
  // Take the newest row per signal first, then keep the ones still open.
  return rows
    .filter((row) => row.status === 'open')
    .map((row) => ({
      signalId: row.signal_id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity.toString(),
      entryPrice: row.entry_price.toString(),
      recordedAt: row.recorded_at,
    }));
}

/** Latest row per signal is the current view; earlier rows are history. */
export async function latestTrackRecord(
  signalId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<TrackRecord | null> {
  return prisma.trackRecord.findFirst({
    where: { signalId },
    orderBy: { recordedAt: 'desc' },
  });
}

/** The open lots for one symbol. Same latest-row-then-filter rule as above. */
export async function openLotsForSymbol(
  symbol: string,
  prisma: PrismaClient = getPrisma(),
): Promise<OpenLot[]> {
  const lots = await listOpenLots(prisma);
  return lots.filter((lot) => lot.symbol === symbol);
}

export interface CloseLotsInput {
  /** Entry signals whose lots this exit consumes, oldest first. */
  signalIds: readonly string[];
  exitPrice: string;
  /** The sell signal being approved. */
  closedBySignalId: string;
  recordedAt?: Date;
}

/**
 * Close one or more lots in a single transaction.
 *
 * All-or-nothing on purpose. These rows can never be deleted, so a half-applied
 * close is permanent: some lots closed, some still open, and a realized PnL
 * that describes neither state. Better to refuse the whole batch and leave the
 * signal decidable — the same doctrine as the decision route's pre-flight.
 */
export async function closeLots(
  input: CloseLotsInput,
  prisma: PrismaClient = getPrisma(),
): Promise<TrackRecord[]> {
  const exitPrice = new Prisma.Decimal(input.exitPrice);
  const recordedAt = input.recordedAt ?? new Date();

  return prisma.$transaction(async (tx) => {
    const closed: TrackRecord[] = [];
    for (const signalId of input.signalIds) {
      const latest = await tx.trackRecord.findFirst({
        where: { signalId },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      });
      if (!latest || latest.status !== 'open') {
        // Throwing rolls back the rows already appended in this transaction.
        throw new Error(
          `signal ${signalId} has no open lot to close (status: ${latest?.status ?? 'no rows'})`,
        );
      }

      const signal = await tx.signal.findUniqueOrThrow({ where: { id: signalId } });
      const quantity = new Prisma.Decimal(signal.quantity);
      const realizedPnl = exitPrice.minus(latest.entryPrice).times(quantity);

      closed.push(
        await tx.trackRecord.create({
          data: {
            signalId,
            entryPrice: latest.entryPrice,
            exitPrice,
            realizedPnl,
            closedBySignalId: input.closedBySignalId,
            status: 'closed',
            recordedAt,
          },
        }),
      );
    }
    return closed;
  });
}

/**
 * Whether a lot already has a mark row for the UTC day containing `when`.
 *
 * The guard that keeps the mark job idempotent: a restart, a manual run, or an
 * overlapping firing must not append a second mark for the same day, because
 * the curve sums that day's marks and a duplicate would double-count a lot.
 */
export async function hasMarkForDay(
  signalId: string,
  when: Date,
  prisma: PrismaClient = getPrisma(),
): Promise<boolean> {
  const start = new Date(
    Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const existing = await prisma.trackRecord.findFirst({
    where: {
      signalId,
      markPrice: { not: null },
      recordedAt: { gte: start, lt: end },
    },
    select: { id: true },
  });
  return existing !== null;
}
