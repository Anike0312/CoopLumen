import { db } from '../db';

export const UNVERIFIED_DAILY_LIMIT = '100.0000000';

export interface TransferReservation {
  id: string;
  communityId: string;
}

export interface ReserveTransferInput {
  stellarAddress: string;
  assetCode: string;
  assetIssuer: string;
  amount: string;
}

export class DailyTransactionLimitError extends Error {
  readonly code = 'UNVERIFIED_DAILY_LIMIT_EXCEEDED';

  constructor(
    readonly dailyTotal: string,
    readonly attemptedAmount: string
  ) {
    super('Unverified accounts may transfer at most 100 tokens per UTC day.');
    this.name = 'DailyTransactionLimitError';
  }
}

/**
 * Reserves daily allowance for an unverified community-token transfer.
 * Returns null for assets that do not belong to a community and for accounts
 * whose KYC record is verified.
 */
export async function reserveUnverifiedTransfer(
  input: ReserveTransferInput
): Promise<TransferReservation | null> {
  return db.transaction(async (client) => {
    const communityResult = await client.query<{ id: string }>(
      `SELECT id
         FROM communities
        WHERE asset_code = $1
          AND asset_issuer = $2
          AND deleted_at IS NULL`,
      [input.assetCode, input.assetIssuer]
    );
    const community = communityResult.rows[0];
    if (!community) return null;

    const kycResult = await client.query<{ status: string }>(
      `SELECT status
         FROM kyc_records
        WHERE community_id = $1 AND stellar_address = $2`,
      [community.id, input.stellarAddress]
    );
    if (kycResult.rows[0]?.status === 'verified') return null;

    // Serialize reservations for this account and community so simultaneous
    // requests cannot both observe the same remaining allowance.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${community.id}:${input.stellarAddress}`,
    ]);

    const usageResult = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM compliance_transfers
        WHERE community_id = $1
          AND stellar_address = $2
          AND status IN ('reserved', 'submitted')
          AND created_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC')
          AND created_at < (((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date + 1) AT TIME ZONE 'UTC')`,
      [community.id, input.stellarAddress]
    );
    const dailyTotal = usageResult.rows[0]?.total ?? '0';

    if (Number(dailyTotal) + Number(input.amount) > Number(UNVERIFIED_DAILY_LIMIT)) {
      throw new DailyTransactionLimitError(dailyTotal, input.amount);
    }

    const reservationResult = await client.query<{ id: string }>(
      `INSERT INTO compliance_transfers (
         community_id, stellar_address, asset_code, asset_issuer, amount
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [community.id, input.stellarAddress, input.assetCode, input.assetIssuer, input.amount]
    );

    return { id: reservationResult.rows[0].id, communityId: community.id };
  });
}

export async function markTransferSubmitted(reservationId: string, txHash: string): Promise<void> {
  await db.query(
    `UPDATE compliance_transfers
        SET status = 'submitted', stellar_tx_hash = $2
      WHERE id = $1 AND status = 'reserved'`,
    [reservationId, txHash]
  );
}

export async function markTransferFailed(reservationId: string): Promise<void> {
  await db.query(
    `UPDATE compliance_transfers
        SET status = 'failed'
      WHERE id = $1 AND status = 'reserved'`,
    [reservationId]
  );
}
