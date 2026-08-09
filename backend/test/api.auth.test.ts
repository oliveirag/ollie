import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { logger } from '../src/logger.js';
import { buildApp } from '../src/server/app.js';
import { MissingOwnerTokenError } from '../src/server/auth.js';
import { authHeader, buildTestApp, TEST_OWNER_TOKEN } from './helpers/api.js';

describe('owner API authentication', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses to build without an owner token', async () => {
    const config = { ...buildConfig(), ownerApiToken: null };
    await expect(buildApp({ config, logger })).rejects.toThrow(MissingOwnerTokenError);
  });

  it('serves /healthz without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'up' });
  });

  describe.each([
    ['no Authorization header', undefined],
    ['an empty bearer token', { authorization: 'Bearer ' }],
    ['a non-bearer scheme', { authorization: `Basic ${TEST_OWNER_TOKEN}` }],
    ['the raw token without the scheme', { authorization: TEST_OWNER_TOKEN }],
    ['a wrong token of the same length', { authorization: `Bearer ${'z'.repeat(TEST_OWNER_TOKEN.length)}` }],
    ['a token that is a prefix of the real one', { authorization: `Bearer ${TEST_OWNER_TOKEN.slice(0, -1)}` }],
    ['a token with trailing content', { authorization: `Bearer ${TEST_OWNER_TOKEN}x` }],
  ])('rejects %s', (_label, headers) => {
    it('with a bodyless 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/signals',
        ...(headers ? { headers } : {}),
      });

      expect(response.statusCode).toBe(401);
      // No detail: the owner knows their token, and anyone else should learn
      // nothing about which half of the check they failed.
      expect(response.json()).toEqual({ error: 'unauthorized' });
    });
  });

  it('accepts the correct token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/signals',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('signals');
  });

  it('does not leak the auth hook onto the public health route', async () => {
    // Encapsulation regression: registering the hook on the root instance
    // instead of the /v1 scope would take /healthz down with a 401 and, with
    // it, the platform health check.
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: 'Bearer definitely-wrong' },
    });

    expect(response.statusCode).toBe(200);
  });
});
