import { Request, Response, NextFunction } from 'express';
import { db } from '../../db';
import { verifySessionToken } from '../utils/sessionToken';
import { readAuthCookie } from '../utils/authCookie';
import { logger } from '../../utils/logger';
import { authenticateApiKey } from '../utils/apiKey';

export interface AuthContext {
  /** The Stellar address that proved control of its key via /api/v1/auth/verify. */
  address: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Requires a session token minted by POST /api/v1/auth/verify after the caller
 * signed a Freighter challenge. The httpOnly `cooplumen_session` cookie is read
 * first; without one, an `Authorization: Bearer` token is accepted so API
 * clients keep working. A cookie is never combined with the header, and the
 * token is never echoed. On success, `req.auth.address` is the authenticated
 * Stellar address.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.header('x-api-key');
  if (apiKey) {
    const address = await authenticateApiKey(apiKey);
    if (!address) {
      res.status(401).json({ data: null, error: 'Invalid or expired API key' });
      return;
    }
    req.auth = { address };
    next();
    return;
  }
  const cookieToken = readAuthCookie(req);
  const header = req.headers.authorization;
  const token = cookieToken ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);

  if (!token) {
    res.status(401).json({ data: null, error: 'Authentication required' });
    return;
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ data: null, error: 'Invalid or expired session token' });
    return;
  }

  req.auth = { address: payload.address };
  next();
}

/** Roles a member can hold in a community (the `members_role_check` values). */
export type MemberRole = 'admin' | 'treasurer' | 'member' | 'observer';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RBAC guard. Requires the authenticated address (set by {@link requireAuth},
 * which must run first) to hold one of `roles` as an active member of the
 * community identified by `:id` in the route params.
 *
 * Responses use the `{ data, error }` envelope: 401 when unauthenticated and
 * 403 when the caller is not an active member or holds a role outside `roles`. An empty `roles` list matches nobody, so it fails closed.
 */
export function requireRole(roles: readonly MemberRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ data: null, error: 'Authentication required' });
      return;
    }

    try {
      let communityId =
        req.params?.id ??
        (req.params as Record<string, string> | undefined)?.communityId ??
        (req.body as Record<string, unknown> | undefined)?.communityId;

      // Reject a caller-supplied id that is not a UUID before it reaches a uuid
      // column, where Postgres would raise and surface as a 500.
      if (communityId && !UUID_PATTERN.test(String(communityId))) {
        res.status(400).json({
          data: null,
          error: 'Validation failed',
          meta: { errors: [{ path: 'id', message: 'id must be a valid UUID' }] },
        });
        return;
      }

      if (!communityId && (req.body as Record<string, unknown> | undefined)?.issuerPublicKey) {
        const issuerKey = (req.body as Record<string, unknown>).issuerPublicKey;
        const [c] = await db.query<{ id: string }>(
          `SELECT id FROM communities WHERE (issuer_public_key = $1 OR asset_issuer = $1) AND deleted_at IS NULL`,
          [issuerKey]
        );
        communityId = c?.id;
      }

      if (!communityId) {
        res.status(404).json({ data: null, error: 'Community not found' });
        return;
      }

      const members =
        (await db.query<{ role: string }>(
          `SELECT role FROM members
         WHERE community_id = $1 AND stellar_address = $2 AND deleted_at IS NULL`,
          [communityId, req.auth.address]
        )) ?? [];
      const member = members[0];

      if (!member) {
        // Only look the community up on the rejection path, so an unknown
        // community reads as 404 rather than a misleading 403.
        const [community] =
          (await db.query<{ id: string }>(
            'SELECT id FROM communities WHERE id = $1 AND deleted_at IS NULL',
            [communityId]
          )) ?? [];
        if (!community) {
          res.status(404).json({ data: null, error: 'Community not found' });
          return;
        }
      }

      if (!member || !(roles as readonly string[]).includes(member.role)) {
        res.status(403).json({
          data: null,
          error: `Requires community role: ${roles.join(' or ')}`,
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Addresses allowed to call operator-only routes, read once at startup from
 * ADMIN_ADDRESSES (comma-separated Stellar public keys).
 *
 * An unset or empty list means nobody qualifies. That is deliberate: an
 * unconfigured deployment should refuse operator actions rather than allow
 * them, which is what the previous no-op implementation did.
 */
function readAdminAddresses(): Set<string> {
  return new Set(
    (process.env.ADMIN_ADDRESSES ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean)
  );
}

let adminAddresses: Set<string> | null = null;

/** Re-reads ADMIN_ADDRESSES. Exported for tests that set the variable per case. */
export function resetAdminAddressCache(): void {
  adminAddresses = null;
}

/**
 * Requires the authenticated address to be an operator of this deployment.
 *
 * Server-wide admin is not a community role - the routes it guards are not
 * scoped to a community - so membership is not consulted; the address must
 * appear in ADMIN_ADDRESSES. Mount it after {@link requireAuth}, which
 * populates `req.auth`.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ data: null, error: 'Authentication required' });
    return;
  }

  if (adminAddresses === null) {
    adminAddresses = readAdminAddresses();
    if (adminAddresses.size === 0) {
      logger.warn('ADMIN_ADDRESSES is unset; every operator route will reject with 403');
    }
  }

  if (!adminAddresses.has(req.auth.address)) {
    logger.warn('Rejected an operator request from a non-admin address', {
      address: req.auth.address,
      path: req.path,
    });
    res.status(403).json({ data: null, error: 'Requires operator privileges' });
    return;
  }

  next();
}
