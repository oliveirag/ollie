import { Prisma, type Signal } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { toSignalSummary } from '../src/server/schemas.js';

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
