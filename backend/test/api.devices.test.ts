import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listDevices, upsertDevice } from '../src/db/devices.js';
import { authHeader, buildTestApp } from './helpers/api.js';
import { closeTestPrisma, resetDatabase, testPrisma } from './helpers/db.js';

const db = testPrisma();

describe('device registration API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await closeTestPrisma();
  });

  it('registers a device once however often it is re-registered', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(),
        payload: { apns_token: 'aa11', environment: 'sandbox' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).not.toHaveProperty('apns_token');
    }

    expect((await listDevices(db)).map((d) => d.apnsToken)).toEqual(['aa11']);
  });

  it('unregisters only the device it names', async () => {
    await upsertDevice({ apnsToken: 'aa11', environment: 'sandbox' }, db);
    await upsertDevice({ apnsToken: 'bb22', environment: 'production' }, db);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/devices/unregister',
      headers: authHeader(),
      payload: { apns_token: 'aa11' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect((await listDevices(db)).map((d) => d.apnsToken)).toEqual(['bb22']);
  });

  it('treats an unknown token as already unregistered', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/devices/unregister',
      headers: authHeader(),
      payload: { apns_token: 'never-registered' },
    });

    expect(response.statusCode).toBe(204);
  });

  it('rejects an empty token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/devices/unregister',
      headers: authHeader(),
      payload: { apns_token: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('requires the owner token', async () => {
    await upsertDevice({ apnsToken: 'aa11', environment: 'sandbox' }, db);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/devices/unregister',
      payload: { apns_token: 'aa11' },
    });

    expect(response.statusCode).toBe(401);
    expect(await listDevices(db)).toHaveLength(1);
  });
});
