import { describe, expect, it } from 'vitest';
import { buildReviewSnapshot, parseReviewSnapshot } from '../src/orchestrator/reviewSnapshot.js';
import type { ReviewResult } from '../src/orchestrator/robinhood/client.js';

const review: ReviewResult = {
  symbol: 'AAPL',
  side: 'buy',
  quantity: '10',
  estimatedPrice: '190.25',
  alerts: [{ type: 'high_volatility', details: { threshold: 0.05 } }],
  raw: { reviewId: 'r-1', ask: '190.25' },
};

describe('buildReviewSnapshot', () => {
  it('derives the persisted snapshot from a review result', () => {
    const snapshot = buildReviewSnapshot(
      review,
      { symbol: 'AAPL', side: 'buy', quantity: '10' },
      new Date('2026-09-22T14:30:00.000Z'),
    );

    expect(snapshot).toEqual({
      schema_version: 1,
      estimated_price: '190.25',
      alerts: [{ type: 'high_volatility', details: { threshold: 0.05 } }],
      requested: { symbol: 'AAPL', side: 'buy', quantity: '10', type: 'market' },
      captured_at: '2026-09-22T14:30:00.000Z',
      raw: { reviewId: 'r-1', ask: '190.25' },
    });
  });

  it('records an empty alerts array when the broker raised nothing', () => {
    const snapshot = buildReviewSnapshot(
      { ...review, alerts: [] },
      { symbol: 'AAPL', side: 'sell', quantity: '5' },
      new Date('2026-09-22T14:30:00.000Z'),
    );

    expect(snapshot.alerts).toEqual([]);
    expect(snapshot.requested.side).toBe('sell');
  });
});

describe('parseReviewSnapshot', () => {
  it('round-trips a snapshot built by buildReviewSnapshot', () => {
    const built = buildReviewSnapshot(
      review,
      { symbol: 'AAPL', side: 'buy', quantity: '10' },
      new Date('2026-09-22T14:30:00.000Z'),
    );

    expect(parseReviewSnapshot(built)).toEqual(built);
  });

  it('throws on a snapshot missing a required field', () => {
    const built = buildReviewSnapshot(
      review,
      { symbol: 'AAPL', side: 'buy', quantity: '10' },
      new Date('2026-09-22T14:30:00.000Z'),
    );
    const { estimated_price: _estimated_price, ...withoutEstimatedPrice } = built;

    expect(() => parseReviewSnapshot(withoutEstimatedPrice)).toThrow(/review_snapshot is not readable/);
  });

  it('throws on a snapshot with the wrong schema version', () => {
    const built = buildReviewSnapshot(
      review,
      { symbol: 'AAPL', side: 'buy', quantity: '10' },
      new Date('2026-09-22T14:30:00.000Z'),
    );

    expect(() => parseReviewSnapshot({ ...built, schema_version: 2 })).toThrow(/review_snapshot is not readable/);
  });
});
