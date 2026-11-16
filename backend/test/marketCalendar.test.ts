import { describe, expect, it } from 'vitest';
import { exchangeDate, isMarketHoliday, lastCoveredYear } from '../src/orchestrator/marketCalendar.js';

describe('the NYSE holiday table', () => {
  it('reads the date on the exchange clock, not UTC', () => {
    // 01:00 UTC on Nov 27 is still the evening of Thanksgiving in New York.
    expect(exchangeDate(new Date('2026-11-27T01:00:00Z'))).toBe('2026-11-26');
    expect(isMarketHoliday(new Date('2026-11-27T01:00:00Z'))).toBe(true);
  });

  it('knows a closure, an ordinary weekday, and an early close apart', () => {
    expect(isMarketHoliday(new Date('2026-11-26T21:15:00Z'))).toBe(true);
    expect(isMarketHoliday(new Date('2026-11-25T21:15:00Z'))).toBe(false);
    // Day after Thanksgiving closes at 1 pm but has a session.
    expect(isMarketHoliday(new Date('2026-11-27T21:15:00Z'))).toBe(false);
  });

  it('does not observe New Year on a Saturday', () => {
    expect(isMarketHoliday(new Date('2027-12-31T21:15:00Z'))).toBe(false);
  });

  it('answers null for a year it does not cover', () => {
    expect(isMarketHoliday(new Date('2031-07-04T16:00:00Z'))).toBeNull();
  });

  it('covers next year (a tripwire: extend the table when NYSE publishes it)', () => {
    expect(lastCoveredYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 1);
  });
});
