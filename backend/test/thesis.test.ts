import { describe, expect, it, vi } from 'vitest';
import {
  generateThesis,
  templateThesis,
  type ThesisInput,
} from '../src/orchestrator/anthropic/thesis.js';
import type { CandidateSignal } from '../src/orchestrator/strategy/index.js';

function candidate(overrides: Partial<CandidateSignal> = {}): CandidateSignal {
  return {
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'technical',
    quantity: '3',
    rule: 'rsi_oversold',
    barTime: '2026-06-25T00:00:00Z',
    referenceClose: '275.15',
    indicators: {
      rsi: 32.6912,
      rsiPrev: 46.5871,
      rsiPeriod: 14,
      rsiOversold: 35,
      rsiOverbought: 70,
      macd: -4.17,
      macdSignal: -1.55,
      macdHistogram: -2.6194,
      macdPrev: -3.1,
      macdSignalPrev: -1.55,
      macdHistogramPrev: -1.5491,
      macdFast: 12,
      macdSlow: 26,
      macdSignalPeriod: 9,
      close: 275.15,
      closePrev: 293.08,
    },
    ...overrides,
  };
}

function input(overrides: Partial<ThesisInput> = {}): ThesisInput {
  return {
    candidate: candidate(),
    estimatedPrice: '275.20',
    reviewWarnings: [],
    ...overrides,
  };
}

const okResponse = (text: string) => ({
  id: 'msg_test',
  type: 'message' as const,
  role: 'assistant' as const,
  model: 'claude-opus-5',
  content: [{ type: 'text' as const, text, citations: null }],
  stop_reason: 'end_turn' as const,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50 },
});

/** Minimal stand-in for the SDK surface generateThesis actually uses. */
const fakeClient = (impl: () => unknown) =>
  ({ messages: { create: vi.fn(impl) } }) as never;

describe('happy path', () => {
  it('returns the model text and marks the source as llm', async () => {
    const result = await generateThesis(input(), {
      client: fakeClient(() => Promise.resolve(okResponse('RSI(14) crossed below 35.'))),
    });

    expect(result.source).toBe('llm');
    expect(result.text).toBe('RSI(14) crossed below 35.');
    expect(result.failureReason).toBeUndefined();
  });

  it('trims surrounding whitespace from the model output', async () => {
    const result = await generateThesis(input(), {
      client: fakeClient(() => Promise.resolve(okResponse('  padded thesis.\n\n'))),
    });
    expect(result.text).toBe('padded thesis.');
  });

  it('sends only the computed indicators, never a free-text instruction', async () => {
    const create = vi.fn((..._args: unknown[]) => Promise.resolve(okResponse('ok')));
    await generateThesis(input(), { client: { messages: { create } } as never });

    const payload = JSON.parse((create.mock.calls[0]![0] as never as {
      messages: { content: string }[];
    }).messages[0]!.content);

    expect(payload.symbol).toBe('AAPL');
    expect(payload.side).toBe('buy');
    expect(payload.indicators.rsi).toBe(32.7);
    expect(payload.estimated_price).toBe('275.20');
  });

  it('requests low effort, since naming numbers is not a reasoning problem', async () => {
    const create = vi.fn((..._args: unknown[]) => Promise.resolve(okResponse('ok')));
    await generateThesis(input(), { client: { messages: { create } } as never });

    const request = create.mock.calls[0]![0] as never as Record<string, unknown>;
    expect(request['output_config']).toEqual({ effort: 'low' });
    // max_tokens must leave room for thinking, which counts against the same
    // budget on this model family — a three-sentence budget would truncate.
    expect(request['max_tokens']).toBeGreaterThan(1000);
    // Sampling parameters are rejected outright by this model family.
    expect(request['temperature']).toBeUndefined();
    expect(request['top_p']).toBeUndefined();
  });
});

// The thesis is narration. Every one of these paths still produces a signal —
// that is the property under test, not the wording.
describe('every failure falls back to the deterministic template', () => {
  it('falls back when the API throws', async () => {
    const result = await generateThesis(input(), {
      client: fakeClient(() => Promise.reject(new Error('connection reset'))),
    });

    expect(result.source).toBe('fallback_template');
    expect(result.failureReason).toBe('connection reset');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('falls back when the request times out', async () => {
    const result = await generateThesis(input(), {
      client: fakeClient(() => Promise.reject(new Error('Request timed out'))),
      timeoutMs: 1,
    });
    expect(result.source).toBe('fallback_template');
  });

  it('falls back when the model declines the request', async () => {
    const result = await generateThesis(input(), {
      client: fakeClient(() =>
        Promise.resolve({ ...okResponse(''), stop_reason: 'refusal' as const }),
      ),
    });

    expect(result.source).toBe('fallback_template');
    expect(result.failureReason).toBe('model declined the request');
  });

  it('falls back when the response carries no text', async () => {
    const result = await generateThesis(input(), {
      client: fakeClient(() => Promise.resolve({ ...okResponse(''), content: [] })),
    });

    expect(result.source).toBe('fallback_template');
    expect(result.failureReason).toBe('model returned no text');
  });

  it('falls back when the response is whitespace only', async () => {
    const result = await generateThesis(input(), {
      client: fakeClient(() => Promise.resolve(okResponse('   \n  '))),
    });
    expect(result.source).toBe('fallback_template');
  });

  it('never throws, whatever the client does', async () => {
    await expect(
      generateThesis(input(), { client: fakeClient(() => Promise.reject('not an Error')) }),
    ).resolves.toMatchObject({ source: 'fallback_template' });
  });
});

describe('template thesis', () => {
  it('is deterministic', () => {
    expect(templateThesis(input())).toBe(templateThesis(input()));
  });

  it('states the RSI oversold crossing with both bars', () => {
    const text = templateThesis(input());
    expect(text).toContain('Buy 3 AAPL at an estimated 275.20');
    expect(text).toContain('RSI(14) fell from 46.6 to 32.7');
    expect(text).toContain('oversold threshold of 35');
  });

  it('states an RSI overbought crossing as a sell', () => {
    const text = templateThesis(
      input({
        candidate: candidate({
          side: 'sell',
          rule: 'rsi_overbought',
          indicators: { ...candidate().indicators, rsi: 71.6, rsiPrev: 69.0 },
        }),
      }),
    );
    expect(text).toContain('Sell 3 AAPL');
    expect(text).toContain('RSI(14) rose from 69 to 71.6');
    expect(text).toContain('overbought threshold of 70');
  });

  it.each([
    ['macd_bullish_cross', 'turned positive'],
    ['macd_bearish_cross', 'turned negative'],
  ] as const)('describes %s', (rule, phrase) => {
    expect(templateThesis(input({ candidate: candidate({ rule }) }))).toContain(phrase);
  });

  it('surfaces broker pre-trade alerts', () => {
    const text = templateThesis(input({ reviewWarnings: ['EQUITY_NOT_ENOUGH_BP'] }));
    expect(text).toContain('Broker pre-trade alerts: EQUITY_NOT_ENOUGH_BP.');
  });

  it('omits the alerts sentence when the broker raised nothing', () => {
    expect(templateThesis(input())).not.toContain('Broker pre-trade alerts');
  });

  it('invents no number that is not in the indicators', () => {
    const text = templateThesis(input());
    const numbers = text.match(/\d+(\.\d+)?/g) ?? [];
    const known = new Set([
      '3', '275.20', '14', '32.7', '46.6', '35', '2.62', '2026', '06', '25', '00',
    ]);
    for (const n of numbers) expect(known).toContain(n);
  });
});
