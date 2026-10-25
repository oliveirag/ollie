import { Prisma, type LiveOrder, type Signal } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { toOrderView, toSignalDetail, toSignalEvent, toSignalSummary } from '../src/server/schemas.js';

const validSnapshot = () => ({
  schema_version: 1,
  estimated_price: '182.50',
  alerts: [],
  requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' },
  captured_at: '2026-08-01T13:30:00.000Z',
  raw: {},
});

function pendingSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-08-01T13:30:00.000Z'),
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'technical',
    quantity: new Prisma.Decimal('2'),
    thesis: 'a thesis',
    thesisSource: 'llm',
    indicators: {},
    reviewSnapshot: validSnapshot(),
    status: 'pending',
    executionMode: 'paper',
    decidedAt: null,
    decideReason: null,
    published: false,
    publishedAt: null,
    autoDecideAt: null,
    dedupeKey: 'macd_bullish_cross:AAPL:buy:2026-08-01T13:30:00.000Z',
    refId: '22222222-2222-4222-8222-222222222222',
    ...overrides,
  };
}

describe('toSignalSummary', () => {
  it('reports an unreadable review snapshot as a null estimated price', () => {
    const summary = toSignalSummary(pendingSignal({ reviewSnapshot: { not: 'a snapshot' } }), 15);

    expect(summary.estimated_price).toBeNull();
  });

  it('reads the estimated price out of a valid snapshot', () => {
    const summary = toSignalSummary(pendingSignal(), 15);

    expect(summary.estimated_price).toBe('182.50');
  });

  it('reads a thesis_source the app does not recognize as null rather than passing it through', () => {
    // thesis_source is a plain text column, not a database enum, so a hand
    // edit or a future source this build predates must not be rendered as
    // one of the two values the app knows how to show.
    const summary = toSignalSummary(pendingSignal({ thesisSource: 'some_future_source' }), 15);

    expect(summary.thesis_source).toBeNull();
  });

  it('passes a known thesis_source straight through', () => {
    expect(toSignalSummary(pendingSignal({ thesisSource: 'fallback_template' }), 15).thesis_source).toBe(
      'fallback_template',
    );
  });

  it('computes expires_at from created_at and the expiry minutes for a pending signal', () => {
    const summary = toSignalSummary(pendingSignal(), 15);

    expect(summary.expires_at).toBe('2026-08-01T13:45:00.000Z');
  });

  it('reports no expiry for a signal that has already been decided', () => {
    const summary = toSignalSummary(pendingSignal({ status: 'approved' }), 15);

    expect(summary.expires_at).toBeNull();
  });
});

function liveOrder(overrides: Partial<LiveOrder> = {}): LiveOrder {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    signalId: '11111111-1111-4111-8111-111111111111',
    brokerOrderId: 'broker-order-1',
    refId: '22222222-2222-4222-8222-222222222222',
    state: 'filled',
    cumulativeQuantity: new Prisma.Decimal('2'),
    averagePrice: new Prisma.Decimal('182.50'),
    placedAt: new Date('2026-08-01T13:30:00.000Z'),
    lastPolledAt: null,
    terminalAt: new Date('2026-08-01T13:31:00.000Z'),
    lastResponse: null,
    ...overrides,
  };
}

describe('toOrderView', () => {
  it('reports the broker state and quantities as wire strings', () => {
    const order = toOrderView(liveOrder());

    expect(order).toEqual({
      broker_order_id: 'broker-order-1',
      state: 'filled',
      cumulative_quantity: '2',
      average_price: '182.5',
      placed_at: '2026-08-01T13:30:00.000Z',
      terminal_at: '2026-08-01T13:31:00.000Z',
    });
  });

  it('reports a null average price and terminal_at for an order still open', () => {
    const order = toOrderView(liveOrder({ averagePrice: null, terminalAt: null }));

    expect(order.average_price).toBeNull();
    expect(order.terminal_at).toBeNull();
  });
});

describe('toSignalEvent', () => {
  it('converts a stored transition to the wire shape', () => {
    const event = toSignalEvent({
      fromStatus: 'pending',
      toStatus: 'approved',
      reason: 'owner approved',
      createdAt: new Date('2026-08-01T13:32:00.000Z'),
    });

    expect(event).toEqual({
      from_status: 'pending',
      to_status: 'approved',
      reason: 'owner approved',
      created_at: '2026-08-01T13:32:00.000Z',
    });
  });

  it('passes a null reason through rather than inventing one', () => {
    const event = toSignalEvent({
      fromStatus: 'pending',
      toStatus: 'expired',
      reason: null,
      createdAt: new Date('2026-08-01T13:32:00.000Z'),
    });

    expect(event.reason).toBeNull();
  });
});

describe('toSignalDetail', () => {
  const events = [
    {
      fromStatus: 'pending',
      toStatus: 'approved',
      reason: 'owner approved',
      createdAt: new Date('2026-08-01T13:32:00.000Z'),
    },
  ];

  it('parses the review snapshot into estimated price, capture time, and alerts', () => {
    const detail = toSignalDetail(pendingSignal(), events, 15);

    expect(detail.review).toEqual({
      estimated_price: '182.50',
      captured_at: '2026-08-01T13:30:00.000Z',
      alerts: [],
    });
  });

  it('reports a null review rather than failing on an unreadable snapshot', () => {
    const detail = toSignalDetail(
      pendingSignal({ reviewSnapshot: { not: 'a snapshot' } }),
      events,
      15,
    );

    expect(detail.review).toBeNull();
    // The rest of the detail view is still usable even though review is not.
    expect(detail.id).toBe(pendingSignal().id);
  });

  it('carries the raw indicators payload through untouched', () => {
    const indicators = { rsi: 45, macdHistogram: 0.5 };
    const detail = toSignalDetail(pendingSignal({ indicators }), events, 15);

    expect(detail.indicators).toEqual(indicators);
  });

  it('maps every event to its wire shape in order', () => {
    const detail = toSignalDetail(pendingSignal(), events, 15);

    expect(detail.events).toEqual([
      {
        from_status: 'pending',
        to_status: 'approved',
        reason: 'owner approved',
        created_at: '2026-08-01T13:32:00.000Z',
      },
    ]);
  });

  it('includes the live order view when one is passed', () => {
    const detail = toSignalDetail(pendingSignal(), events, 15, liveOrder());

    expect(detail.order?.broker_order_id).toBe('broker-order-1');
  });
});
