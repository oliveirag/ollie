import { Prisma, type Signal } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_FIELDS,
  PublishedSignalSchema,
  UnpublishedSignalError,
  toPublishedSignal,
} from '../src/published/signal.js';

/**
 * The redaction test (Phase 4, milestone 4.1). `toPublishedSignal` is the one
 * projection every subscriber-facing surface goes through, so proving the
 * forbidden fields are absent from its output — against a signal in which every
 * one of them is populated with something recognisable — is what proves the
 * subset. No grant, view, or query is trusted to do this.
 */

/** Every column filled, and every forbidden one filled with a canary value. */
function maximalSignal(): Signal {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-09-01T13:35:00.000Z'),
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'technical',
    quantity: new Prisma.Decimal('2'),
    thesis: 'RSI(14) crossed below 30.',
    thesisSource: 'llm',
    indicators: { rsi: 27.3, rsiPeriod: 14, macdHistogram: -0.42 },
    reviewSnapshot: {
      schema_version: 1,
      estimated_price: '182.50',
      alerts: [{ type: 'CANARY_ALERT', details: { buying_power: 'CANARY_BP' } }],
      requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' },
      captured_at: '2026-09-01T13:34:59.000Z',
      raw: { account: 'CANARY_ACCOUNT', order_checks: 'CANARY_RAW' },
    },
    status: 'approved',
    executionMode: 'paper',
    decidedAt: new Date('2026-09-01T13:40:00.000Z'),
    decideReason: 'CANARY_REASON',
    published: true,
    publishedAt: new Date('2026-09-01T13:40:01.000Z'),
    dedupeKey: 'CANARY_DEDUPE',
    refId: '22222222-2222-4222-8222-222222222222',
    autoDecideAt: new Date('2026-09-01T13:40:00.000Z'),
  };
}

describe('toPublishedSignal', () => {
  it('carries exactly the published fields', () => {
    const published = toPublishedSignal(maximalSignal());

    expect(Object.keys(published).sort()).toEqual(
      [
        'created_at',
        'estimated_price',
        'id',
        'indicators',
        'published_at',
        'quantity',
        'side',
        'signal_type',
        'symbol',
        'thesis',
        'thesis_source',
      ].sort(),
    );
    expect(PublishedSignalSchema.parse(published)).toEqual(published);
  });

  it.each(FORBIDDEN_FIELDS)('omits %s', (field) => {
    const published = toPublishedSignal(maximalSignal()) as Record<string, unknown>;
    expect(published).not.toHaveProperty(field);
  });

  it('leaks no canary value anywhere in the serialized payload', () => {
    // Belt and braces over the field list: a forbidden value smuggled under a
    // new key, or nested inside an allowed one, still fails.
    const serialized = JSON.stringify(toPublishedSignal(maximalSignal()));
    for (const canary of [
      'CANARY_ALERT',
      'CANARY_BP',
      'CANARY_ACCOUNT',
      'CANARY_RAW',
      'CANARY_REASON',
      'CANARY_DEDUPE',
      '22222222-2222-4222-8222-222222222222',
      'paper',
      'approved',
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('projects the values it does carry verbatim', () => {
    const published = toPublishedSignal(maximalSignal());

    expect(published).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      created_at: '2026-09-01T13:35:00.000Z',
      published_at: '2026-09-01T13:40:01.000Z',
      symbol: 'AAPL',
      side: 'buy',
      signal_type: 'technical',
      quantity: '2',
      thesis: 'RSI(14) crossed below 30.',
      thesis_source: 'llm',
      indicators: { rsi: 27.3, rsiPeriod: 14, macdHistogram: -0.42 },
      estimated_price: '182.50',
    });
  });

  it('reads estimated_price from the snapshot and nothing else from it', () => {
    const signal = maximalSignal();
    signal.reviewSnapshot = { not: 'a snapshot' };

    expect(toPublishedSignal(signal).estimated_price).toBeNull();
  });

  it('renders an unknown thesis_source as null rather than a guess', () => {
    const signal = { ...maximalSignal(), thesisSource: 'hand_edited' };
    expect(toPublishedSignal(signal).thesis_source).toBeNull();
  });

  it('refuses to project an unpublished signal', () => {
    const unpublished = { ...maximalSignal(), published: false, publishedAt: null };
    expect(() => toPublishedSignal(unpublished)).toThrow(UnpublishedSignalError);

    // A flag without a timestamp is not a published signal either; the
    // database refuses to store that state and the projection agrees.
    const halfway = { ...maximalSignal(), publishedAt: null };
    expect(() => toPublishedSignal(halfway)).toThrow(UnpublishedSignalError);
  });
});
