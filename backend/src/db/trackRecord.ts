import {
  Prisma,
  type PositionStatus,
  type PrismaClient,
  type TrackRecord,
} from '@prisma/client';
import type { TrackRecordRow } from '../orchestrator/trackRecordStats.js';
import { getPrisma, isFullClient, type Db } from './client.js';

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
  /** Lot size when it differs from the signal's quantity (a partial live fill). */
  quantity?: string | null;
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
  prisma: Db = getPrisma(),
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
      quantity: input.quantity == null ? null : new Prisma.Decimal(input.quantity),
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
  /** The row's own size when a live fill set one, else the signal's. */
  quantity: string;
  /** True when the row carries its own size (a partial live fill). */
  quantityOverridden: boolean;
  entryPrice: string;
  /** The newest row's time: the latest mark once the lot has been marked. */
  recordedAt: Date;
  /** The lot's first row: when it was actually opened. */
  openedAt: Date;
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
export async function listOpenLots(
  prisma: Db = getPrisma(),
  options: { publishedOnly?: boolean } = {},
): Promise<OpenLot[]> {
  // Filtering by the signal is safe ahead of DISTINCT ON: it keeps or drops
  // every row of a lot together, unlike a filter on the row's own status.
  const publishedFilter = options.publishedOnly ? Prisma.sql`WHERE s.published` : Prisma.empty;
  const rows = await prisma.$queryRaw<
    Array<{
      signal_id: string;
      symbol: string;
      side: string;
      quantity: Prisma.Decimal;
      quantity_overridden: boolean;
      entry_price: Prisma.Decimal;
      recorded_at: Date;
      opened_at: Date;
      status: string;
    }>
  >`
    SELECT DISTINCT ON (tr.signal_id)
      tr.signal_id, tr.entry_price, tr.recorded_at, tr.status::text AS status,
      MIN(tr.recorded_at) OVER (PARTITION BY tr.signal_id) AS opened_at,
      s.symbol, s.side::text AS side,
      COALESCE(tr.quantity, s.quantity) AS quantity,
      (tr.quantity IS NOT NULL) AS quantity_overridden
    FROM track_record tr
    JOIN signals s ON s.id = tr.signal_id
    ${publishedFilter}
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
      quantityOverridden: row.quantity_overridden,
      entryPrice: row.entry_price.toString(),
      recordedAt: row.recorded_at,
      openedAt: row.opened_at,
    }));
}

/**
 * The newest mark row for a lot, or null if it has never been marked. What a
 * subscriber sees as an open position's value (Phase 4, decision 7): the
 * record's own daily answer, auditable via `mark_price`, never a live quote.
 */
export async function latestMarkForLot(
  signalId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<TrackRecord | null> {
  return prisma.trackRecord.findFirst({
    where: { signalId, markPrice: { not: null } },
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * Realized PnL over every closed lot, as a two-place decimal string. Uses the
 * latest row per signal, the same rule as `listOpenLots`, so a correction
 * appended later supersedes rather than double-counts.
 */
export async function totalRealizedPnl(prisma: PrismaClient = getPrisma()): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
    SELECT SUM(latest.realized_pnl) AS total
    FROM (
      SELECT DISTINCT ON (tr.signal_id) tr.status::text AS status, tr.realized_pnl
      FROM track_record tr
      ORDER BY tr.signal_id, tr.recorded_at DESC, tr.id DESC
    ) latest
    WHERE latest.status = 'closed'
  `;
  return new Prisma.Decimal(rows[0]?.total ?? 0).toFixed(2);
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
  prisma: Db = getPrisma(),
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
 * Close one or more lots in a single transaction: the caller's, when it
 * passes one, or a new one.
 *
 * All-or-nothing on purpose. These rows can never be deleted, so a half-applied
 * close is permanent: some lots closed, some still open, and a realized PnL
 * that describes neither state. Better to refuse the whole batch and leave the
 * signal decidable — the same doctrine as the decision route's pre-flight.
 */
export async function closeLots(
  input: CloseLotsInput,
  prisma: Db = getPrisma(),
): Promise<TrackRecord[]> {
  const exitPrice = new Prisma.Decimal(input.exitPrice);
  const recordedAt = input.recordedAt ?? new Date();

  const run = async (tx: Prisma.TransactionClient): Promise<TrackRecord[]> => {
    // Every lot's newest row and its signal's size, read in two queries for the
    // whole batch rather than two per lot. Still inside the transaction, so the
    // state checked is the state the closes are written against.
    const latestRows = await tx.trackRecord.findMany({
      where: { signalId: { in: [...input.signalIds] } },
      orderBy: [{ signalId: 'asc' }, { recordedAt: 'desc' }, { id: 'desc' }],
      distinct: ['signalId'],
    });
    const latestBySignal = new Map(latestRows.map((row) => [row.signalId, row]));
    const signals = await tx.signal.findMany({
      where: { id: { in: [...input.signalIds] } },
      select: { id: true, quantity: true },
    });
    const signalQuantity = new Map(signals.map((signal) => [signal.id, signal.quantity]));

    const closed: TrackRecord[] = [];
    for (const signalId of input.signalIds) {
      const latest = latestBySignal.get(signalId);
      if (!latest || latest.status !== 'open') {
        // Throwing rolls back the rows already appended in this transaction.
        throw new Error(
          `signal ${signalId} has no open lot to close (status: ${latest?.status ?? 'no rows'})`,
        );
      }

      const ownQuantity = signalQuantity.get(signalId);
      if (!ownQuantity) throw new Error(`signal ${signalId} does not exist`);
      // The lot's own size when a live fill set one; the signal's otherwise.
      const quantity = new Prisma.Decimal(latest.quantity ?? ownQuantity);
      const realizedPnl = exitPrice.minus(latest.entryPrice).times(quantity);

      closed.push(
        await tx.trackRecord.create({
          data: {
            signalId,
            entryPrice: latest.entryPrice,
            exitPrice,
            realizedPnl,
            closedBySignalId: input.closedBySignalId,
            quantity: latest.quantity,
            status: 'closed',
            recordedAt,
          },
        }),
      );
    }
    return closed;
  };

  // Inside a caller's transaction already (the fill and its settlement), the
  // rows join that one; otherwise this opens its own.
  return isFullClient(prisma) ? prisma.$transaction(run) : run(prisma);
}

function utcDayBounds(when: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * The ids of every lot that already has a mark row for the UTC day containing
 * `when`, in one query. The mark job reads this once per firing rather than
 * asking lot by lot.
 *
 * The guard that keeps the mark job idempotent: a restart, a manual run, or an
 * overlapping firing must not append a second mark for the same day, because
 * the curve sums that day's marks and a duplicate would double-count a lot.
 */
export async function lotsMarkedOnDay(
  when: Date,
  prisma: PrismaClient = getPrisma(),
): Promise<Set<string>> {
  const { start, end } = utcDayBounds(when);
  const rows = await prisma.trackRecord.findMany({
    where: { markPrice: { not: null }, recordedAt: { gte: start, lt: end } },
    select: { signalId: true },
    distinct: ['signalId'],
  });
  return new Set(rows.map((row) => row.signalId));
}

/**
 * Every track-record row with the entry lot size it belongs to, oldest first.
 *
 * Quantity lives on the signal, not the row, and the return math needs both.
 * The whole table is read because the aggregates are computed from the full
 * history — the caps allow three signals a day, so a year is hundreds of rows
 * and one scan.
 */
export async function listAllTrackRecordRows(
  prisma: PrismaClient = getPrisma(),
  options: { publishedOnly?: boolean } = {},
): Promise<TrackRecordStatsRow[]> {
  const rows = await prisma.trackRecord.findMany({
    ...(options.publishedOnly ? { where: { signal: { published: true } } } : {}),
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    include: { signal: { select: { quantity: true, symbol: true } } },
  });

  return rows.map((row) => ({
    signalId: row.signalId,
    symbol: row.signal.symbol,
    status: row.status,
    entryPrice: row.entryPrice.toString(),
    quantity: (row.quantity ?? row.signal.quantity).toString(),
    exitPrice: row.exitPrice?.toString() ?? null,
    realizedPnl: row.realizedPnl?.toString() ?? null,
    unrealizedPnl: row.unrealizedPnl?.toString() ?? null,
    markPrice: row.markPrice?.toString() ?? null,
    recordedAt: row.recordedAt,
  }));
}

/** The stats input, plus the symbol the subscriber positions list needs. */
export type TrackRecordStatsRow = TrackRecordRow & { symbol: string };
