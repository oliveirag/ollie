import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  APPLE_ISSUER,
  InvalidIdentityTokenError,
  buildSiwaVerifier,
  type SiwaVerifier,
} from '../src/signal-server/siwa.js';

/**
 * The verifier against locally-minted tokens. No network: the key set is a
 * generated RSA pair exported as a JWKS, which is exactly the shape Apple
 * serves. A second pair stands in for "someone else's key".
 */
const AUDIENCE = 'com.guilhermeoliveira.Ollie';

let verifier: SiwaVerifier;
let sign: (claims: Record<string, unknown>, options?: { key?: CryptoKey; alg?: string }) => Promise<string>;
let appleKey: CryptoKey;
let strangerKey: CryptoKey;

const now = () => new Date('2026-09-15T12:00:00.000Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

beforeAll(async () => {
  const apple = await generateKeyPair('RS256');
  const stranger = await generateKeyPair('RS256');
  appleKey = apple.privateKey;
  strangerKey = stranger.privateKey;

  const jwk = await exportJWK(apple.publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'apple-1', alg: 'RS256', use: 'sig' }] });
  verifier = buildSiwaVerifier({ audience: AUDIENCE, keys, now });

  sign = async (claims, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: 'apple-1' })
      .sign(options.key ?? appleKey);
});

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: APPLE_ISSUER,
    aud: AUDIENCE,
    sub: '001234.abcdef.5678',
    email: 'xyz@privaterelay.appleid.com',
    iat: seconds(now()) - 60,
    exp: seconds(now()) + 600,
    ...overrides,
  };
}

describe('Sign in with Apple verification', () => {
  it('accepts a valid token and returns the subject and email', async () => {
    const identity = await verifier.verify(await sign(validClaims()));

    expect(identity).toEqual({ appleUserId: '001234.abcdef.5678', email: 'xyz@privaterelay.appleid.com' });
  });

  it('treats a missing email as null rather than an error', async () => {
    const claims = validClaims();
    delete (claims as { email?: unknown }).email;

    expect((await verifier.verify(await sign(claims))).email).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const token = await sign(validClaims());
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify(validClaims({ sub: 'someone-else' })))
      .toString('base64url');

    await expect(verifier.verify(`${header}.${forged}.${signature}`)).rejects.toThrow(
      InvalidIdentityTokenError,
    );
    void payload;
  });

  it('rejects a token signed by a key Apple does not hold', async () => {
    await expect(
      verifier.verify(await sign(validClaims(), { key: strangerKey })),
    ).rejects.toThrow(InvalidIdentityTokenError);
  });

  it('rejects the wrong audience', async () => {
    await expect(
      verifier.verify(await sign(validClaims({ aud: 'com.example.NotOllie' }))),
    ).rejects.toThrow(InvalidIdentityTokenError);
  });

  it('rejects the wrong issuer', async () => {
    await expect(
      verifier.verify(await sign(validClaims({ iss: 'https://accounts.example.com' }))),
    ).rejects.toThrow(InvalidIdentityTokenError);
  });

  it('rejects an expired token', async () => {
    await expect(
      verifier.verify(await sign(validClaims({ exp: seconds(now()) - 1 }))),
    ).rejects.toThrow(InvalidIdentityTokenError);
  });

  it('rejects a token with no subject', async () => {
    const claims = validClaims();
    delete (claims as { sub?: unknown }).sub;

    await expect(verifier.verify(await sign(claims))).rejects.toThrow(/missing subject/);
  });

  it('rejects garbage', async () => {
    await expect(verifier.verify('not.a.jwt')).rejects.toThrow(InvalidIdentityTokenError);
    await expect(verifier.verify('')).rejects.toThrow(InvalidIdentityTokenError);
  });
});
