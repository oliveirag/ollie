import { TIMEZONE } from '../config/index.js';

/**
 * NYSE full-day closures, from the exchange's 2026-2028 calendar (announced
 * 2025-12-23). Early closes are not here: those days have a session and a
 * close, and are marked like any other.
 *
 * A fixed table rather than a broker check on purpose. Daily bars cannot
 * answer "was there a session today" at 16:15 ET: the in-progress day is
 * absent from them (see the note in the AAPL fixture), so a bar-based check
 * would skip every trading day's mark too. The exchange publishes these
 * dates years ahead; extend the table when it does.
 */
const NYSE_CLOSED: Readonly<Record<number, readonly string[]>> = {
  2026: [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  ],
  2027: [
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
    '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  ],
  // No New Year's holiday: Jan 1 2028 is a Saturday and is not observed.
  2028: [
    '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
    '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
  ],
};

const etDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The exchange's calendar date for an instant, as YYYY-MM-DD. */
export function exchangeDate(when: Date): string {
  return etDate.format(when);
}

/**
 * True on a full-day NYSE closure, false on a session day, null when the
 * table does not cover that year (the caller decides what unknown means).
 */
export function isMarketHoliday(when: Date): boolean | null {
  const date = exchangeDate(when);
  const closed = NYSE_CLOSED[Number(date.slice(0, 4))];
  if (!closed) return null;
  return closed.includes(date);
}

/** The last year the table covers, for the staleness tripwire in the tests. */
export function lastCoveredYear(): number {
  return Math.max(...Object.keys(NYSE_CLOSED).map(Number));
}
