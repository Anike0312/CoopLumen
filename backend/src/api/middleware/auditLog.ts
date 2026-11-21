import { NextFunction, Request, Response } from 'express';
import { db } from '../../db';
import { logger } from '../../utils/logger';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function resourceFromPath(path: string): { type: string; id: string | null } {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  return { type: parts[2] ?? 'unknown', id: parts[3] ?? null };
}

/** Records every successful API mutation after the response completes. */
export function auditStateChange(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    const resource = resourceFromPath(req.originalUrl);
    void db.query(
      `INSERT INTO audit_log
         (actor_address, ip_address, action, resource_type, resource_id, after_state)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        req.auth?.address ?? null,
        req.ip,
        `${req.method} ${req.route?.path ?? req.path}`,
        resource.type,
        resource.id,
        JSON.stringify({ status: res.statusCode, requestId: res.getHeader('x-request-id') ?? null }),
      ]
    ).catch((error) => logger.error('Failed to persist mutation audit event', { error }));
  });
  next();
}
