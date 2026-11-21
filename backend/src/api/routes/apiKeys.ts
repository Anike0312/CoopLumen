import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { generateApiKey } from '../utils/apiKey';

const createSchema = z.object({ name: z.string().trim().min(1).max(80), expiresAt: z.coerce.date().optional() });
export const apiKeysRouter = Router();
apiKeysRouter.use(requireAuth);

apiKeysRouter.post('/', validateBody(createSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const generated = generateApiKey();
    const { name, expiresAt } = req.body as { name: string; expiresAt?: Date };
    const [created] = await db.query<{ id: string; created_at: string }>(
      `INSERT INTO api_keys (owner_address, name, key_prefix, key_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [req.auth!.address, name, generated.prefix, generated.hash, expiresAt ?? null]
    );
    res.status(201).json({ data: { id: created.id, name, key: generated.key, prefix: generated.prefix, createdAt: created.created_at }, meta: { warning: 'This API key is shown only once.' } });
  } catch (error) { next(error); }
});

apiKeysRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db.query<{ id: string }>(
      'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND owner_address = $2 AND revoked_at IS NULL RETURNING id',
      [req.params.id, req.auth!.address]
    );
    if (!rows[0]) { res.status(404).json({ data: null, error: 'API key not found' }); return; }
    res.status(204).end();
  } catch (error) { next(error); }
});
