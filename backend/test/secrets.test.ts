import { describe, expect, it } from 'vitest';
import { generateSecret, hashSecret, secretsMatch } from '../src/secrets.js';

describe('hashSecret', () => {
  it('returns the hex sha256 digest of the plaintext', () => {
    expect(hashSecret('hello-token')).toBe(
      '1a659e2ea31ab6f0ac2c9a9ba262d574a53263bc55bca387f12260872a78dd18',
    );
  });

  it('hashes the empty string to the known sha256 constant', () => {
    expect(hashSecret('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is deterministic and case-sensitive', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
    expect(hashSecret('abc')).not.toBe(hashSecret('ABC'));
  });
});

describe('secretsMatch', () => {
  it('returns true for identical strings', () => {
    expect(secretsMatch('super-secret', 'super-secret')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(secretsMatch('super-secreT', 'super-secret')).toBe(false);
  });

  it('returns false for strings of different lengths without throwing', () => {
    expect(secretsMatch('short', 'much-longer-secret')).toBe(false);
  });

  it('returns false against the empty string', () => {
    expect(secretsMatch('', 'super-secret')).toBe(false);
  });
});

describe('generateSecret', () => {
  it('prefixes the token and separates it with an underscore', () => {
    expect(generateSecret('sub')).toMatch(/^sub_[0-9a-f]{64}$/);
  });

  it('produces 64 hex characters after the prefix, from 32 random bytes', () => {
    const token = generateSecret('ollie');
    const [prefix, hex] = token.split('_');
    expect(prefix).toBe('ollie');
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it('never repeats across calls', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateSecret('x')));
    expect(tokens.size).toBe(20);
  });
});
