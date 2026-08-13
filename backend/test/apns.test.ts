import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Http2Server } from 'node:http2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApnsClient, interpret, ProviderToken } from '../src/orchestrator/push/apns.js';

/**
 * The APNs client is hand-rolled, so the details it has to get right are
 * pinned here against a real local HTTP/2 server rather than a stubbed
 * transport: the status-code table, 410 handling, and the provider-token
 * cache Apple rejects you for ignoring.
 */

const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const credentials = {
  keyP8: privateKey,
  keyId: 'ABC123DEFG',
  teamId: 'TEAM123456',
  bundleId: 'com.guilhermeoliveira.Ollie',
};

interface Received {
  path: string;
  authorization: string;
  topic: string;
  collapseId: string | undefined;
  body: string;
}

describe('interpret', () => {
  it('treats 200 as delivered', () => {
    expect(interpret(200, '')).toEqual({ ok: true });
  });

  it('treats 410 as a dead token', () => {
    const result = interpret(410, JSON.stringify({ reason: 'Unregistered' }));
    expect(result).toEqual({ ok: false, unregistered: true, reason: 'Unregistered' });
  });

  it('treats 400 BadDeviceToken as a dead token too', () => {
    // Apple uses 400 for a token that was never valid and 410 for one that has
    // been uninstalled. Pruning only on 410 leaves dead rows forever.
    const result = interpret(400, JSON.stringify({ reason: 'BadDeviceToken' }));
    expect(result).toMatchObject({ ok: false, unregistered: true });
  });

  it('does not prune on an unrelated 400', () => {
    const result = interpret(400, JSON.stringify({ reason: 'PayloadTooLarge' }));
    expect(result).toMatchObject({ ok: false, unregistered: false, retryable: false });
  });

  it('marks 429 and 5xx retryable and 4xx not', () => {
    expect(interpret(429, '{}')).toMatchObject({ retryable: true });
    expect(interpret(503, '{}')).toMatchObject({ retryable: true });
    expect(interpret(403, JSON.stringify({ reason: 'InvalidProviderToken' })))
      .toMatchObject({ retryable: false });
  });

  it('survives a non-JSON body', () => {
    expect(interpret(500, '<html>nope</html>')).toMatchObject({
      ok: false,
      retryable: true,
    });
  });
});

describe('ProviderToken', () => {
  it('mints an ES256 JWT with the key id and team id', () => {
    const token = new ProviderToken(credentials).value();
    const [header, claims, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toMatchObject({
      alg: 'ES256',
      kid: credentials.keyId,
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: credentials.teamId,
    });
    // JOSE fixed-width r||s, not DER: 64 raw bytes.
    expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
  });

  it('reuses the same token within the refresh window', () => {
    // Minting per push is rejected as TooManyProviderTokenUpdates, a failure
    // that only shows up under load.
    let now = 1_000_000;
    const token = new ProviderToken(credentials, () => now);

    const first = token.value();
    now += 30 * 60_000;
    expect(token.value()).toBe(first);
  });

  it('mints a fresh token once the window elapses', () => {
    let now = 1_000_000;
    const token = new ProviderToken(credentials, () => now);

    const first = token.value();
    now += 46 * 60_000;
    expect(token.value()).not.toBe(first);
  });
});

describe('ApnsClient against a local HTTP/2 server', () => {
  let server: Http2Server;
  let received: Received[] = [];
  let respond: (path: string) => { status: number; body: string };
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.on('data', (chunk) => {
        body += chunk;
      });
      stream.on('end', () => {
        const path = String(headers[':path']);
        received.push({
          path,
          authorization: String(headers.authorization ?? ''),
          topic: String(headers['apns-topic'] ?? ''),
          collapseId: headers['apns-collapse-id'] as string | undefined,
          body,
        });
        const reply = respond(path);
        stream.respond({ ':status': reply.status });
        stream.end(reply.body);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(): ApnsClient {
    return new ApnsClient({
      credentials,
      hosts: { production: baseUrl, sandbox: baseUrl },
    });
  }

  it('posts to /3/device/<token> with the bearer token and topic', async () => {
    received = [];
    respond = () => ({ status: 200, body: '' });
    const apns = client();

    const result = await apns.send({
      deviceToken: 'devicetoken123',
      environment: 'production',
      title: 'Buy AAPL',
      body: '2 shares at ~182.50. Expires in 15 min.',
      data: { signal_id: 'abc' },
      collapseId: 'abc',
    });
    await apns.close();

    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/3/device/devicetoken123');
    expect(received[0]!.authorization).toMatch(/^bearer eyJ/);
    expect(received[0]!.topic).toBe(credentials.bundleId);
    expect(received[0]!.collapseId).toBe('abc');

    const payload = JSON.parse(received[0]!.body);
    expect(payload.aps.alert.title).toBe('Buy AAPL');
    // A 15-minute window is what justifies breaking through a Focus mode.
    expect(payload.aps['interruption-level']).toBe('time-sensitive');
    expect(payload.signal_id).toBe('abc');
  });

  it('reports an unregistered token so the caller can prune it', async () => {
    received = [];
    respond = () => ({ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) });
    const apns = client();

    const result = await apns.send({
      deviceToken: 'dead',
      environment: 'production',
      title: 't',
      body: 'b',
    });
    await apns.close();

    expect(result).toMatchObject({ ok: false, unregistered: true });
  });

  it('reuses one provider token across many pushes', async () => {
    received = [];
    respond = () => ({ status: 200, body: '' });
    const apns = client();

    for (const token of ['a', 'b', 'c']) {
      await apns.send({ deviceToken: token, environment: 'production', title: 't', body: 'b' });
    }
    await apns.close();

    const authorizations = new Set(received.map((r) => r.authorization));
    expect(authorizations.size).toBe(1);
  });
});
