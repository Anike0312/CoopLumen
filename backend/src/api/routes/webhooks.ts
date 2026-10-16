import { Router, Request, Response, NextFunction } from 'express';
import { verifyKycWebhookSignature, verifyWebhookSignature } from '../middleware/webhookSignature';
import { validateBody } from '../middleware/validate';
import { kycWebhookSchema, KycWebhookPayload, stellarWebhookSchema } from '../schemas/webhook';
import { logger } from '../../utils/logger';
import { db } from '../../db';

export const webhookRouter = Router();

/**
 * POST /api/v1/webhooks/stellar
 * Receives Stellar account/transaction event notifications from a trusted
 * webhook source. The request must carry a valid HMAC-SHA256 signature (see
 * `verifyWebhookSignature`) computed over the raw request body with
 * `STELLAR_WEBHOOK_SECRET`; requests without one are rejected before the
 * body is even validated.
 */
webhookRouter.post(
  '/stellar',
  verifyWebhookSignature,
  validateBody(stellarWebhookSchema),
  (req: Request, res: Response): void => {
    const { eventId, eventType } = req.body as { eventId: string; eventType: string };

    logger.info('Received Stellar webhook event', { eventId, eventType });

    res.status(200).json({ data: { received: true, eventId } });
  }
);

interface KycRecordRow {
  id: string;
  status: KycWebhookPayload['status'];
  verified_at: string | null;
}

/**
 * POST /api/v1/webhooks/kyc
 * Applies a signed status callback from a third-party KYC provider to the
 * community-scoped KYC record for the supplied Stellar address.
 */
webhookRouter.post(
  '/kyc',
  verifyKycWebhookSignature,
  validateBody(kycWebhookSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const payload = req.body as KycWebhookPayload;

    try {
      const metadata = {
        ...payload.metadata,
        lastEventId: payload.eventId,
        lastEventAt: payload.occurredAt,
      };
      const rows = await db.query<KycRecordRow>(
        `INSERT INTO kyc_records (
           community_id,
           stellar_address,
           status,
           provider,
           provider_reference,
           verified_at,
           rejected_reason,
           metadata
         )
         SELECT $1, $2, $3, $4, $5,
                CASE WHEN $3 = 'verified' THEN $6::timestamptz ELSE NULL END,
                CASE WHEN $3 = 'rejected' THEN $7 ELSE NULL END,
                $8::jsonb
          WHERE EXISTS (
            SELECT 1 FROM communities WHERE id = $1 AND deleted_at IS NULL
          )
         ON CONFLICT (community_id, stellar_address) DO UPDATE SET
           status = EXCLUDED.status,
           provider = EXCLUDED.provider,
           provider_reference = EXCLUDED.provider_reference,
           verified_at = CASE
             WHEN EXCLUDED.status = 'verified'
               THEN COALESCE(kyc_records.verified_at, EXCLUDED.verified_at)
             ELSE kyc_records.verified_at
           END,
           rejected_reason = CASE
             WHEN EXCLUDED.status = 'rejected' THEN EXCLUDED.rejected_reason
             ELSE NULL
           END,
           metadata = COALESCE(kyc_records.metadata, '{}'::jsonb) || EXCLUDED.metadata
         RETURNING id, status, verified_at`,
        [
          payload.communityId,
          payload.stellarAddress,
          payload.status,
          payload.provider,
          payload.providerReference,
          payload.occurredAt,
          payload.rejectionReason ?? null,
          JSON.stringify(metadata),
        ]
      );

      const record = rows[0];
      if (!record) {
        res.status(404).json({ data: null, error: 'Community not found' });
        return;
      }

      logger.info('Applied KYC provider webhook event', {
        eventId: payload.eventId,
        provider: payload.provider,
        status: record.status,
        kycRecordId: record.id,
      });
      res.status(200).json({
        data: {
          received: true,
          eventId: payload.eventId,
          recordId: record.id,
          status: record.status,
          verifiedAt: record.verified_at,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);
