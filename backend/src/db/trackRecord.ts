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
