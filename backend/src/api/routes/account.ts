import { NextFunction, Request, Response, Router } from 'express';
import { db } from '../../db';
import { requireAuth } from '../middleware/auth';
import { validateParams } from '../middleware/validate';
import { accountParamsSchema } from '../schemas/account';
import { revokeRefreshTokensForAddress } from '../utils/refreshToken';

export const accountRouter = Router();

accountRouter.delete(
  '/:publicKey',
  requireAuth,
  validateParams(accountParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { publicKey } = req.params as { publicKey: string };
    if (req.auth?.address !== publicKey) {
      res.status(403).json({ data: null, error: 'Accounts may only delete their own data' });
      return;
    }

    try {
      const summary = await db.transaction(async (client) => {
        const counts: Record<string, number> = {};
        const remove = async (table: string, column: string): Promise<void> => {
          const result = await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [publicKey]);
          counts[table] = (counts[table] ?? 0) + (result.rowCount ?? 0);
        };

        await remove('notifications', 'stellar_address');
        await remove('kyc_records', 'stellar_address');
        await remove('reputation_scores', 'stellar_address');
        await remove('trustlines', 'stellar_address');
        await remove('multisig_requests', 'proposer_address');
        await remove('loans', 'borrower_address');
        await remove('loans', 'lender_address');
        await remove('members', 'stellar_address');
        await client.query(
          `UPDATE transactions_log
              SET actor_address = NULL,
                  metadata = COALESCE(metadata, '{}'::jsonb) - 'publicKey' - 'address'
            WHERE actor_address = $1`,
          [publicKey]
        );
        await client.query(
          `UPDATE audit_log SET actor_address = NULL,
             after_state = jsonb_build_object('erased', true)
           WHERE actor_address = $1`,
          [publicKey]
        );
        return counts;
      });

      revokeRefreshTokensForAddress(publicKey);
      res.status(200).json({ data: { deleted: true, publicKey, recordsRemoved: summary } });
    } catch (error) {
      next(error);
    }
  }
);
