import { NextFunction, Request, Response, Router } from 'express';
import { db } from '../../db';
import { validateParams } from '../middleware/validate';
import { kycStatusParamsSchema } from '../schemas/kyc';

export const kycRouter = Router();

type StoredKycStatus = 'pending' | 'submitted' | 'verified' | 'rejected' | 'expired';
type PublicKycStatus = 'none' | 'pending' | 'approved' | 'rejected';

function toPublicStatus(status: StoredKycStatus | undefined): PublicKycStatus {
  if (!status) return 'none';
  if (status === 'verified') return 'approved';
  if (status === 'pending' || status === 'submitted') return 'pending';
  return 'rejected';
}

/** Returns the latest KYC outcome recorded for a Stellar account. */
kycRouter.get(
  '/status/:address',
  validateParams(kycStatusParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const [record] = await db.query<{ status: StoredKycStatus }>(
        `SELECT status
           FROM kyc_records
          WHERE stellar_address = $1
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1`,
        [req.params.address]
      );

      res.json({
        data: {
          address: req.params.address,
          status: toPublicStatus(record?.status),
import { PoolClient } from 'pg';
import { db } from '../../db';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { initiateKycSchema, InitiateKycInput } from '../schemas/kyc';

export const kycRouter = Router();

class KycInitiationError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'KycInitiationError';
  }
}

interface KycRecord {
  id: string;
  community_id: string;
  stellar_address: string;
  status: 'pending' | 'submitted' | 'verified' | 'rejected' | 'expired';
  provider: string | null;
  updated_at: Date | string;
}

async function initiateKyc(
  client: PoolClient,
  input: InitiateKycInput
): Promise<{ record: KycRecord; started: boolean }> {
  const member = await client.query(
    `SELECT 1
       FROM members
      WHERE community_id = $1
        AND stellar_address = $2
        AND deleted_at IS NULL`,
    [input.communityId, input.address]
  );
  if (member.rows.length === 0) {
    throw new KycInitiationError('Address is not an active member of the community', 403);
  }

  const existingResult = await client.query<KycRecord>(
    `SELECT id, community_id, stellar_address, status, provider, updated_at
       FROM kyc_records
      WHERE community_id = $1 AND stellar_address = $2
      FOR UPDATE`,
    [input.communityId, input.address]
  );
  const existing = existingResult.rows[0];
  if (existing?.status === 'verified') {
    throw new KycInitiationError('Address is already verified', 409);
  }
  if (existing?.status === 'pending' || existing?.status === 'submitted') {
    return { record: existing, started: false };
  }

  if (existing) {
    const restarted = await client.query<KycRecord>(
      `UPDATE kyc_records
          SET status = 'pending',
              provider = $3,
              provider_reference = NULL,
              verified_at = NULL,
              rejected_reason = NULL
        WHERE community_id = $1 AND stellar_address = $2
        RETURNING id, community_id, stellar_address, status, provider, updated_at`,
      [input.communityId, input.address, input.provider]
    );
    return { record: restarted.rows[0], started: true };
  }

  const created = await client.query<KycRecord>(
    `INSERT INTO kyc_records (community_id, stellar_address, status, provider)
     VALUES ($1, $2, 'pending', $3)
     RETURNING id, community_id, stellar_address, status, provider, updated_at`,
    [input.communityId, input.address, input.provider]
  );
  return { record: created.rows[0], started: true };
}

kycRouter.post(
  '/initiate',
  requireAuth,
  validateBody(initiateKycSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const input = req.body as InitiateKycInput;
    if (req.auth!.address !== input.address) {
      res.status(403).json({ data: null, error: 'KYC can only be initiated for your own address' });
      return;
    }

    try {
      const result = await db.transaction((client) => initiateKyc(client, input));
      res.status(result.started ? 201 : 200).json({
        data: {
          id: result.record.id,
          communityId: result.record.community_id,
          address: result.record.stellar_address,
          status: 'pending',
          provider: result.record.provider,
          initiatedAt: result.record.updated_at,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);
