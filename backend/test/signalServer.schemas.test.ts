import { Prisma, type TrackRecord } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { toRecordRow } from '../src/signal-server/schemas.js';

/** A closed lot: every nullable column populated. */
function closedRow(): TrackRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    signalId: '22222222-2222-4222-8222-222222222222',
    entryPrice: new Prisma.Decimal('100.50'),
    exitPrice: new Prisma.Decimal('110.25'),
    realizedPnl: new Prisma.Decimal('9.75'),
    unrealizedPnl: null,
    markPrice: null,
    closedBySignalId: '33333333-3333-4333-8333-333333333333',
    quantity: new Prisma.Decimal('4'),
    status: 'closed',
    recordedAt: new Date('2026-09-01T13:40:00.000Z'),
  };
}

/** A mark on an open lot: no exit, no realized PnL, no closing signal. */
function openMarkRow(): TrackRecord {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    signalId: '22222222-2222-4222-8222-222222222222',
    entryPrice: new Prisma.Decimal('100.50'),
    exitPrice: null,
    realizedPnl: null,
    unrealizedPnl: new Prisma.Decimal('-2.10'),
    markPrice: new Prisma.Decimal('98.40'),
    closedBySignalId: null,
    quantity: null,
    status: 'open',
    recordedAt: new Date('2026-09-02T13:40:00.000Z'),
  };
}

describe('toRecordRow', () => {
  it('stringifies every decimal and passes the status and ids through', () => {
    expect(toRecordRow(closedRow())).toEqual({
      status: 'closed',
      entry_price: '100.5',
      exit_price: '110.25',
      realized_pnl: '9.75',
      unrealized_pnl: null,
      mark_price: null,
      closed_by_signal_id: '33333333-3333-4333-8333-333333333333',
      recorded_at: '2026-09-01T13:40:00.000Z',
    });
  });

  it('reads an open lot’s mark row as nulls rather than coercing them to zero', () => {
    expect(toRecordRow(openMarkRow())).toEqual({
      status: 'open',
      entry_price: '100.5',
      exit_price: null,
      realized_pnl: null,
      unrealized_pnl: '-2.1',
      mark_price: '98.4',
      closed_by_signal_id: null,
      recorded_at: '2026-09-02T13:40:00.000Z',
    });
  });
});
