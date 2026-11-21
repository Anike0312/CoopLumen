import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_TTL_SECONDS = 60 * 60;

const INSECURE_DEV_SECRET = 'dev-insecure-session-secret-change-me';

function getSecret(): string {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AUTH_SESSION_SECRET must be set in production');
    }
    return INSECURE_DEV_SECRET;
  }
  return secret;
}

export interface SessionPayload {
  address: string;
  iat: number;
  exp: number;
}

function sign(data: string): string {
  return createHmac('sha256', getSecret()).update(data).digest('base64url');
}

/**
 * Issues an HMAC-signed session token binding a Stellar address for a limited
 * time, once the caller has proven control of it via signed-challenge auth.
 * Token shape is `base64url(payload).base64url(hmac)` — no external JWT
 * dependency, verified with a constant-time comparison.
 */
export function createSessionToken(
  address: string,
  ttlSeconds = DEFAULT_TTL_SECONDS
): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { address, iat: now, exp: now + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(body);
  return { token: `${body}.${signature}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/** Verifies a session token's signature and expiry, returning its payload or null. */
export function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  const expected = sign(body);
  const provided = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (
      typeof payload.address !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now || payload.iat > now + 30 || payload.exp - payload.iat > DEFAULT_TTL_SECONDS) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
