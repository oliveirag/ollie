import { describe, expect, it } from 'vitest';
import {
  expiryReason,
  formatEtTime,
  sessionCloseFor,
  signalExpiresAt,
} from '../src/orchestrator/expiry.js';

const CLOSE_ON = { signalExpiryMinutes: 15, signalExpiresAtClose: true };
const CLOSE_OFF = { signalExpiryMinutes: 15, signalExpiresAtClose: false };

describe('signalExpiresAt', () => {
  it('runs a 09:35 proposal to that session\'s 16:00 ET close (EDT)', () => {
    // Thursday 2026-07-02, 09:35 EDT.
    expect(signalExpiresAt(new Date('2026-07-02T13:35:00Z'), CLOSE_ON).toISOString()).toBe(
      '2026-07-02T20:00:00.000Z',
    );
  });

  it('tracks the close through daylight saving (EST)', () => {
    // Friday 2026-11-20, 09:35 EST.
    expect(signalExpiresAt(new Date('2026-11-20T14:35:00Z'), CLOSE_ON).toISOString()).toBe(
      '2026-11-20T21:00:00.000Z',
    );
  });

  it('keeps the floor for a signal created near or after the close', () => {
    // 15:50 EDT: the close is 10 minutes away, the floor is 15.
    expect(signalExpiresAt(new Date('2026-07-02T19:50:00Z'), CLOSE_ON).toISOString()).toBe(
      '2026-07-02T20:05:00.000Z',
    );
    // 18:00 EDT, after the close.
    expect(signalExpiresAt(new Date('2026-07-02T22:00:00Z'), CLOSE_ON).toISOString()).toBe(
      '2026-07-02T22:15:00.000Z',
    );
  });

  it('uses only the floor on a weekend or a full-day closure', () => {
    // Saturday.
    expect(signalExpiresAt(new Date('2026-08-01T13:35:00Z'), CLOSE_ON).toISOString()).toBe(
      '2026-08-01T13:50:00.000Z',
    );
    // Thanksgiving 2026.
    expect(signalExpiresAt(new Date('2026-11-26T14:35:00Z'), CLOSE_ON).toISOString()).toBe(
      '2026-11-26T14:50:00.000Z',
    );
  });

  it('is the fixed window with SIGNAL_EXPIRES_AT_CLOSE off', () => {
    expect(signalExpiresAt(new Date('2026-07-02T13:35:00Z'), CLOSE_OFF).toISOString()).toBe(
      '2026-07-02T13:50:00.000Z',
    );
  });
});

describe('sessionCloseFor', () => {
  it('reads the session on the exchange clock, not UTC', () => {
    // 01:00 UTC Saturday is still Friday evening in New York.
    expect(sessionCloseFor(new Date('2026-08-01T01:00:00Z'))?.toISOString()).toBe(
      '2026-07-31T20:00:00.000Z',
    );
  });
});

describe('expiryReason', () => {
  it('names the close when the close was the deadline', () => {
    expect(expiryReason(new Date('2026-07-02T13:35:00Z'), CLOSE_ON)).toBe(
      'not decided before the 16:00 ET close',
    );
  });

  it('names the minutes when the floor was the deadline', () => {
    expect(expiryReason(new Date('2026-08-01T13:35:00Z'), CLOSE_ON)).toBe(
      'not decided within 15 minutes',
    );
    expect(expiryReason(new Date('2026-07-02T13:35:00Z'), CLOSE_OFF)).toBe(
      'not decided within 15 minutes',
    );
  });
});

describe('formatEtTime', () => {
  it('prints the ET wall clock for push copy', () => {
    expect(formatEtTime(new Date('2026-07-02T20:00:00Z'))).toBe('4:00 PM ET');
    expect(formatEtTime(new Date('2026-11-20T20:30:00Z'))).toBe('3:30 PM ET');
  });
});
