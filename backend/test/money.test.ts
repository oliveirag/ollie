import { describe, expect, it } from 'vitest';
import {
  applySlippage,
  centsToPrice,
  notionalCents,
  sharesForNotional,
  toCents,
} from '../src/money.js';

describe('toCents', () => {
  it('converts a clean price to cents', () => {
    expect(toCents('19.99')).toBe(1999);
  });

  it('rounds half up at the third decimal', () => {
    expect(toCents('1.005')).toBe(101);
    expect(toCents('1.004')).toBe(100);
  });
});

describe('centsToPrice', () => {
  it('formats cents back to a two-decimal price string', () => {
    expect(centsToPrice(10050)).toBe('100.50');
    expect(centsToPrice(5)).toBe('0.05');
  });
});

describe('notionalCents', () => {
  it('multiplies quantity by price into cents', () => {
    expect(notionalCents('10', '99.50')).toBe(99500);
  });

  it('rounds half up on a fractional-cent result', () => {
    // 3 * 33.335 = 100.005 -> 10000.5 cents -> 10001
    expect(notionalCents('3', '33.335')).toBe(10001);
  });
});

describe('sharesForNotional', () => {
  it('floors rather than rounds, so it never overshoots the target', () => {
    // $10.00 at $3.33/share buys 3.003... shares.
    expect(sharesForNotional(1000, '3.33')).toBe(3);
  });

  it('returns whole shares exactly at the boundary', () => {
    expect(sharesForNotional(100_000, '100.00')).toBe(10);
  });

  it('returns zero when the target cannot afford one share', () => {
    expect(sharesForNotional(50, '100.00')).toBe(0);
  });

  it('returns zero for a non-positive price instead of dividing by it', () => {
    expect(sharesForNotional(1000, '0')).toBe(0);
    expect(sharesForNotional(1000, '-5')).toBe(0);
  });
});

describe('applySlippage', () => {
  it('moves a buy price up', () => {
    expect(applySlippage('100.00', 'buy', 50)).toBe('100.500000');
  });

  it('moves a sell price down by the same amount', () => {
    expect(applySlippage('100.00', 'sell', 50)).toBe('99.500000');
  });

  it('rounds to six decimal places', () => {
    expect(applySlippage('100.00', 'buy', 1)).toBe('100.010000');
  });

  it('is a no-op at zero slippage', () => {
    expect(applySlippage('42.42', 'buy', 0)).toBe('42.420000');
    expect(applySlippage('42.42', 'sell', 0)).toBe('42.420000');
  });
});
