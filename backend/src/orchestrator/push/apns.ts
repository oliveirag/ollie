import { createSign } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';

/**
 * A minimal APNs client, token-based auth, over HTTP/2.
 *
 * Hand-rolled for two reasons. Node's `fetch` speaks HTTP/1.1 only and APNs
 * requires HTTP/2, so the standard client is out. And the mainstream package
 * is in the state `technicalindicators` was in during Phase 1 — aging, and we
 * rejected that one on the same grounds. The whole surface is a JWT, a POST,
 * and a table of documented status codes.
 */

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

export type ApnsEnvironment = keyof typeof APNS_HOSTS;

export interface ApnsCredentials {
  /** Contents of the .p8 private key (PEM). */
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

export interface ApnsNotification {
  deviceToken: string;
  environment: ApnsEnvironment;
  title: string;
  body: string;
  /** Merged into the payload alongside `aps`. */
  data?: Record<string, unknown>;
  /** Collapses to one visible notification per signal on retry. */
  collapseId?: string;
}

export type ApnsResult =
  | { ok: true }
  /** The token is dead. The dispatcher deletes the row. */
  | { ok: false; unregistered: true; reason: string }
  | { ok: false; unregistered: false; reason: string; retryable: boolean };

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * APNs provider tokens must be *reused* for 20–60 minutes. Minting one per
 * push is rejected with `TooManyProviderTokenUpdates`, which is a failure mode
 * that only appears under load — exactly the kind that would first show up on
 * a busy trading morning.
 */
export class ProviderToken {
  private cached: { jwt: string; issuedAt: number } | null = null;

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly now: () => number = Date.now,
    /** Refresh at 45 minutes: comfortably inside Apple's 60-minute ceiling. */
    private readonly maxAgeMs = 45 * 60_000,
  ) {}

  value(): string {
    const now = this.now();
    if (this.cached && now - this.cached.issuedAt < this.maxAgeMs) {
      return this.cached.jwt;
    }

    const issuedAt = now;
    const header = base64url(
      JSON.stringify({ alg: 'ES256', kid: this.credentials.keyId, typ: 'JWT' }),
    );
    const claims = base64url(
      JSON.stringify({ iss: this.credentials.teamId, iat: Math.floor(issuedAt / 1000) }),
    );

    const signer = createSign('SHA256');
    signer.update(`${header}.${claims}`);
    signer.end();
    // ES256 requires the JOSE fixed-width (r||s) form, not the DER encoding
    // Node emits by default.
    const signature = base64url(
      signer.sign({ key: this.credentials.keyP8, dsaEncoding: 'ieee-p1363' }),
    );

    const jwt = `${header}.${claims}.${signature}`;
    this.cached = { jwt, issuedAt };
    return jwt;
  }
}

export interface ApnsClientOptions {
  credentials: ApnsCredentials;
  /** Overridden in tests to point at a local HTTP/2 server. */
  hosts?: Record<ApnsEnvironment, string>;
  now?: () => number;
  timeoutMs?: number;
}

export class ApnsClient {
  private readonly token: ProviderToken;
  private readonly hosts: Record<ApnsEnvironment, string>;
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(private readonly options: ApnsClientOptions) {
    this.token = new ProviderToken(options.credentials, options.now);
    this.hosts = options.hosts ?? { ...APNS_HOSTS };
  }

  private session(host: string): ClientHttp2Session {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = connect(host);
    // A dead session must not be reused; APNs closes idle connections and the
    // next push would otherwise fail on a socket nobody is listening to.
    session.on('error', () => this.sessions.delete(host));
    session.on('close', () => this.sessions.delete(host));
    this.sessions.set(host, session);
    return session;
  }

  async send(notification: ApnsNotification): Promise<ApnsResult> {
    const host = this.hosts[notification.environment];
    const payload = JSON.stringify({
      aps: {
        alert: { title: notification.title, body: notification.body },
        sound: 'default',
        // A 15-minute expiry is what justifies interrupting a Focus mode.
        'interruption-level': 'time-sensitive',
      },
      ...notification.data,
    });

    const headers: Record<string, string> = {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${notification.deviceToken}`,
      authorization: `bearer ${this.token.value()}`,
      'apns-topic': this.options.credentials.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    };
    if (notification.collapseId) headers['apns-collapse-id'] = notification.collapseId;

    return new Promise<ApnsResult>((resolve) => {
      let settled = false;
      const settle = (result: ApnsResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      let request;
      try {
        request = this.session(host).request(headers);
      } catch (error) {
        return settle({
          ok: false,
          unregistered: false,
          retryable: true,
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      request.setTimeout(this.options.timeoutMs ?? 10_000, () => {
        request.close();
        settle({ ok: false, unregistered: false, retryable: true, reason: 'timeout' });
      });

      let status = 0;
      let body = '';
      request.on('response', (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('error', (error) =>
        settle({ ok: false, unregistered: false, retryable: true, reason: error.message }),
      );
      request.on('end', () => settle(interpret(status, body)));

      request.end(payload);
    });
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

/**
 * The documented status codes that matter.
 *
 * 410, and 400 with `BadDeviceToken`, both mean the token will never work
 * again — Apple uses 400 for a token that was never valid and 410 for one
 * that has been uninstalled. Treating only 410 as terminal leaves dead rows
 * accumulating forever.
 */
export function interpret(status: number, body: string): ApnsResult {
  if (status === 200) return { ok: true };

  let reason = body;
  try {
    const parsed = JSON.parse(body) as { reason?: string };
    if (parsed.reason) reason = parsed.reason;
  } catch {
    // Non-JSON body; the raw text is the best available reason.
  }

  if (status === 410 || (status === 400 && reason === 'BadDeviceToken')) {
    return { ok: false, unregistered: true, reason };
  }

  // 429 and 5xx are Apple asking us to come back later; everything else is a
  // request we built wrong and retrying would not fix.
  const retryable = status === 429 || status >= 500;
  return { ok: false, unregistered: false, retryable, reason: reason || `HTTP ${status}` };
}
