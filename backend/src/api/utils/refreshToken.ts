import { createHash, randomBytes } from 'crypto';
import { Request, Response } from 'express';

/** Name of the httpOnly cookie that carries the refresh (rotation) token. */
export const REFRESH_COOKIE_NAME = 'cooplumen_refresh';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Scoped to the auth routes so the refresh token is not sent to every endpoint. */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

interface RefreshEntry {
  address: string;
  expiresAt: number;
}

/**
 * Live refresh tokens keyed by the SHA-256 of the token, so a dump of this map
 * does not reveal usable tokens. In-memory like the sign-in challenges: a
 * restart just forces a fresh wallet sign-in, and a multi-instance deployment
 * would need this in Redis.
 */
const refreshTokens = new Map<string, RefreshEntry>();

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of refreshTokens) {
    if (entry.expiresAt < now) refreshTokens.delete(key);
  }
}

/** Issues a new opaque single-use refresh token bound to `address`. */
export function issueRefreshToken(address: string): { token: string; expiresAt: Date } {
  prune();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + REFRESH_TTL_MS;
  refreshTokens.set(hash(token), { address, expiresAt });
  return { token, expiresAt: new Date(expiresAt) };
}

/**
 * Redeems a refresh token. It is deleted on every lookup, valid or not, so a
 * token can be used at most once (rotation): presenting a stale token after it
 * was rotated fails. Returns the bound address, or null if unknown/expired.
 */
export function consumeRefreshToken(token: string): string | null {
  prune();
  const key = hash(token);
  const entry = refreshTokens.get(key);
  refreshTokens.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.address;
}

function cookieOptions(): { httpOnly: true; secure: boolean; sameSite: 'strict'; path: string } {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE_NAME, token, { ...cookieOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions());
}

/** Reads the refresh token from the `Cookie` header (no cookie-parser in the app). */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1 || part.slice(0, index).trim() !== REFRESH_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Test helper: drops every stored refresh token. */
export function resetRefreshTokens(): void {
  refreshTokens.clear();
}

/** Invalidates all browser refresh sessions owned by an erased account. */
export function revokeRefreshTokensForAddress(address: string): void {
  for (const [key, entry] of refreshTokens) {
    if (entry.address === address) refreshTokens.delete(key);
  }
}
