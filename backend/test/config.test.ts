import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';

const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/ollie_test',
    ...overrides,
  } as NodeJS.ProcessEnv);

describe('buildConfig validation', () => {
  it('throws when the RSI oversold threshold is not below the overbought one', () => {
    expect(() => buildConfig(env({ RSI_OVERSOLD: '70', RSI_OVERBOUGHT: '70' }))).toThrow(
      /RSI_OVERSOLD \(70\) must be below RSI_OVERBOUGHT \(70\)/,
    );
  });

  it('throws when the MACD fast period is not shorter than the slow one', () => {
    expect(() => buildConfig(env({ MACD_FAST: '26', MACD_SLOW: '26' }))).toThrow(
      /MACD_FAST \(26\) must be below MACD_SLOW \(26\)/,
    );
  });

  it('throws when the order notional exceeds the position cap, since every order would be rejected', () => {
    expect(() =>
      buildConfig(env({ ORDER_NOTIONAL_CENTS: '200000', MAX_POSITION_CENTS: '100000' })),
    ).toThrow(/exceeds MAX_POSITION_CENTS/);
  });

  it('throws when the symbol allowlist is empty after parsing', () => {
    expect(() => buildConfig(env({ SYMBOL_ALLOWLIST: ' , ,' }))).toThrow(
      /SYMBOL_ALLOWLIST must name at least one symbol/,
    );
  });

  it('throws when the owner API token is set but shorter than 32 characters', () => {
    expect(() => buildConfig(env({ OWNER_API_TOKEN: 'too-short' }))).toThrow(
      /OWNER_API_TOKEN: must be at least 32 characters/,
    );
  });
});

describe('symbol allowlist parsing', () => {
  it('trims, uppercases, and deduplicates symbols', () => {
    const config = buildConfig(env({ SYMBOL_ALLOWLIST: ' aapl, AAPL ,msft,MSFT ' }));
    expect(config.symbolAllowlist).toEqual(['AAPL', 'MSFT']);
  });
});

describe('derived fields', () => {
  it('decodes the base64 APNs key, leaving it empty when unset', () => {
    expect(buildConfig(env()).apns.keyP8).toBe('');

    const withKey = buildConfig(
      env({ APNS_KEY_P8_BASE64: Buffer.from('fake-key').toString('base64') }),
    );
    expect(withKey.apns.keyP8).toBe('fake-key');
  });

  it('reports the owner API token as null rather than an empty string when unset', () => {
    expect(buildConfig(env()).ownerApiToken).toBeNull();
  });

  it('parses comma-separated subscriber invite codes, dropping blanks', () => {
    const config = buildConfig(env({ SUBSCRIBER_INVITE_CODES: ' abc123 ,, def456' }));
    expect(config.signalService.inviteCodes).toEqual(['abc123', 'def456']);
  });

  it('reports the robinhood account number as null rather than an empty string when unset', () => {
    expect(buildConfig(env()).robinhood.accountNumber).toBeNull();
  });

  it('reports the signal service database url and public url as null when unset', () => {
    const config = buildConfig(env());
    expect(config.signalService.databaseUrl).toBeNull();
    expect(config.signalService.publicUrl).toBeNull();
  });
});
