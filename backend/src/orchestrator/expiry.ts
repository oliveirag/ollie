import type { Config } from '../config/index.js';
import { TIMEZONE } from '../config/index.js';
import { exchangeDate, isMarketHoliday } from './marketCalendar.js';

/**
 * When a pending signal stops being decidable.
 *
 * Signals are proposed at 09:35 ET from the last *completed* daily bar. That
 * bar does not change until today's session closes, and the next pipeline run
 * is not until the next session's 09:35, so the decision behind a signal is
 * as valid at 15:00 as it was at 09:40. A 15-minute window threw most of that
 * away: half the paper run's proposals expired unanswered.
 *
 * So a signal born during a session lives until that session's regular 16:00
 * ET close. The close, not the next open, because an approval should fill in
 * regular hours: a paper fill is re-priced at approval (see PaperExecutor) and
 * an after-hours quote is not a price a market order would get.
 *
 * `SIGNAL_EXPIRY_MINUTES` stays as the floor. It is the whole window for a
 * signal created outside a session (a manual run, a weekend, a holiday), and
 * for every signal when `SIGNAL_EXPIRES_AT_CLOSE` is off.
 *
 * Computed at read time from `created_at`, never stored, so the immutability
 * triggers have nothing new to guard. The expiry sweep is the authority; every
 * other caller (API `expires_at`, push copy, reminders) asks this function so
 * they cannot disagree with it.
 *
 * Early closes (13:00 ET, two or three days a year) are not modelled; on those
 * days the window runs to 16:00 like any other.
 */

export type ExpiryConfig = Pick<Config, 'signalExpiryMinutes' | 'signalExpiresAtClose'>;

/** Regular session close, ET. */
export const SESSION_CLOSE_ET = { hour: 16, minute: 0 } as const;

export function signalExpiresAt(createdAt: Date, config: ExpiryConfig): Date {
  const floor = new Date(createdAt.getTime() + config.signalExpiryMinutes * 60_000);
  if (!config.signalExpiresAtClose) return floor;

  const close = sessionCloseFor(createdAt);
  if (!close) return floor;
  return close.getTime() > floor.getTime() ? close : floor;
}

/** Why the sweep expired it, for the append-only audit. */
export function expiryReason(createdAt: Date, config: ExpiryConfig): string {
  const expiresAt = signalExpiresAt(createdAt, config);
  const close = config.signalExpiresAtClose ? sessionCloseFor(createdAt) : null;
  if (close && close.getTime() === expiresAt.getTime()) {
    return 'not decided before the 16:00 ET close';
  }
  return `not decided within ${config.signalExpiryMinutes} minutes`;
}

/**
 * 16:00 ET on the exchange date of `when`, or null when that date has no
 * session (weekend or full-day closure). A year the holiday table does not
 * cover counts as a session: the floor still applies, and the calendar's own
 * staleness test is what flags the table.
 */
export function sessionCloseFor(when: Date): Date | null {
  const date = exchangeDate(when);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  if (isMarketHoliday(when) === true) return null;
  return etWallClockToUtc(y, m, d, SESSION_CLOSE_ET.hour, SESSION_CLOSE_ET.minute);
}

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** The ET wall-clock reading of an instant, expressed as if it were UTC. */
function etWallClockMs(when: Date): number {
  const parts = Object.fromEntries(
    etParts.formatToParts(when).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/** An ET wall-clock time on a date, as an instant. DST-correct. */
function etWallClockToUtc(y: number, m: number, d: number, hour: number, minute: number): Date {
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  const offset = etWallClockMs(new Date(naive)) - naive;
  let instant = naive - offset;
  // The offset read at `naive` can be the other side of a DST change from the
  // answer. Never at 16:00 (changes happen at 02:00), but cheap to get right.
  const corrected = etWallClockMs(new Date(instant)) - instant;
  if (corrected !== offset) instant = naive - corrected;
  return new Date(instant);
}

const etTime = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
});

/** "4:00 PM ET", for push copy. */
export function formatEtTime(when: Date): string {
  // Newer ICU puts a narrow no-break space before AM/PM; a lock screen wants a plain one.
  return `${etTime.format(when).replace(/\u202f/g, ' ')} ET`;
}
