import { Router, Request, Response, NextFunction } from 'express';
import { TransactionBuilder } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { buildUnsignedIssueAsset, getAssetHolders, getTotalSupply } from '../../contracts/assets';
import { buildUnsignedTrustline } from '../../contracts/trustlines';
import { buildBatchPayment } from '../../contracts/batchPayments';
import { buildUnsignedPayment, submitSignedXdr } from '../../contracts/transactions';
import { db } from '../../db';
import { invalidateBalanceCache } from '../../cache/balances';
import { StellarService } from '../../contracts/stellar';
import { validateBody } from '../middleware/validate';
import { requireAdmin, requireAuth } from '../middleware/auth';
import {
  buildAirdropSchema,
  buildBurnTokenSchema,
  buildIssueTokenSchema,
  buildTrustlineTokenSchema,
  submitTokenXdrSchema,
  adminTokensQuerySchema,
} from '../schemas/token';
import { isValidStellarPublicKey } from '../utils/stellar';
import { mapHorizonError } from '../utils/horizonError';
import { parsePagination, pageMeta, parseSort } from '../utils/http';
import {
  DailyTransactionLimitError,
  markTransferFailed,
  markTransferSubmitted,
  reserveUnverifiedTransfer,
  UNVERIFIED_DAILY_LIMIT,
} from '../../services/compliance';
import type { TransferReservation } from '../../services/compliance';
import { logger } from '../../utils/logger';
import {
  getNativeBalance,
  getRequiredXlmForTransaction,
  getTransactionDestination,
  getTransactionSource,
} from '../utils/stellarTransaction';

export const tokenRouter = Router();

const tokenParamsSchema = z.object({
  assetCode: z
    .string()
    .trim()
    .min(1, 'assetCode is required')
    .max(12, 'assetCode must be 12 characters or fewer')
    .regex(/^[A-Za-z0-9]+$/, 'assetCode must be alphanumeric'),
  issuer: z.string().refine(isValidStellarPublicKey, 'issuer must be a valid Stellar public key'),
});

const transferSchema = z.object({
  signedXdr: z.string().trim().min(1, 'signedXdr is required').max(100_000),
});

interface Token {
  id: string;
  community_id: string;
  asset_code: string;
  asset_issuer: string;
  distributor_address: string;
  total_supply: string;
  name: string | null;
  description: string | null;
  icon_url: string | null;
  decimals: number | null;
  created_at: string;
  updated_at: string;
}

interface CommunityRow {
  asset_code: string;
  asset_issuer: string;
}

interface MemberRow {
  stellar_address: string;
}

interface TokenWithCommunity extends Token {
  community_name: string;
}

/**
 * GET /api/v1/tokens
 * Admin endpoint to list all tokens across all communities.
 * Requires admin authentication (currently placeholder).
 * Supports pagination via page/limit query parameters.
 */
tokenRouter.get(
  '/',
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queryValidation = adminTokensQuerySchema.safeParse(req.query);
      if (!queryValidation.success) {
        res.status(400).json({
          data: null,
          error: 'Invalid query parameters',
          meta: {
            errors: queryValidation.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
        return;
      }

      const pagination = parsePagination(req);
      const allowedSortColumns = ['created_at', 'name', 'asset_code', 'total_supply'];
      const { sortBy, order } = parseSort(req, allowedSortColumns, 'created_at');

      const [{ count }] = await db.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM tokens'
      );

      const tokens = await db.query<TokenWithCommunity>(
        `SELECT 
           t.id,
           t.community_id,
           t.asset_code,
           t.asset_issuer,
           t.distributor_address,
           t.total_supply,
           t.name,
           t.description,
           t.icon_url,
           t.decimals,
           t.created_at,
           t.updated_at,
           c.name AS community_name
         FROM tokens t
         LEFT JOIN communities c ON t.community_id = c.id
         ORDER BY ${sortBy === 'name' ? 't.name' : sortBy === 'asset_code' ? 't.asset_code' : sortBy === 'total_supply' ? 't.total_supply' : 't.created_at'} ${order}
         LIMIT $1 OFFSET $2`,
        [pagination.limit, pagination.offset]
      );

      res.json({
        data: tokens,
        meta: pageMeta(count, pagination),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/tokens/build-issue
 * Builds an unsigned XDR transaction for issuing a community token, so the
 * issuer's wallet (e.g. Freighter) can sign it client-side instead of
 * sending the issuer's secret key to the server. Sign the returned XDR and
 * submit it through POST /api/v1/tokens/submit.
 */
tokenRouter.post(
  '/build-issue',
  validateBody(buildIssueTokenSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { issuerPublicKey, assetCode, distributorPublicKey, amount, memo } = req.body as {
        issuerPublicKey: string;
        assetCode: string;
        distributorPublicKey: string;
        amount: string;
        memo?: string;
      };

      const xdr = await buildUnsignedIssueAsset({
        issuerPublicKey,
        assetCode,
        distributorPublicKey,
        amount,
        memo,
      });

      res.status(200).json({ data: { xdr } });
    } catch (err) {
      if ((err as { response?: unknown }).response) {
        const mapped = mapHorizonError(err);
        res.status(mapped.status).json({ data: null, error: mapped.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/tokens/build-trustline
 * Builds an unsigned changeTrust XDR transaction so a member's wallet can
 * sign it client-side instead of sending the account's secret key to the
 * server. Sign the returned XDR and submit it through
 * POST /api/v1/tokens/submit.
 */
tokenRouter.post(
  '/build-trustline',
  validateBody(buildTrustlineTokenSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accountPublicKey, assetCode, assetIssuer, limit } = req.body as {
        accountPublicKey: string;
        assetCode: string;
        assetIssuer: string;
        limit?: string;
      };

      const xdr = await buildUnsignedTrustline({ accountPublicKey, assetCode, assetIssuer, limit });

      res.status(200).json({ data: { xdr } });
    } catch (err) {
      if ((err as { response?: unknown }).response) {
        const mapped = mapHorizonError(err);
        res.status(mapped.status).json({ data: null, error: mapped.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/tokens/build-burn
 * Builds an unsigned transaction returning tokens to their issuing account,
 * where they stop counting toward circulating supply. The holder's wallet
 * signs the returned XDR; submit it through POST /api/v1/tokens/submit with
 * `refreshSupply` set so the recorded supply is re-read from Horizon.
 */
tokenRouter.post(
  '/build-burn',
  validateBody(buildBurnTokenSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { holderPublicKey, assetCode, assetIssuer, amount } = req.body as {
        holderPublicKey: string;
        assetCode: string;
        assetIssuer: string;
        amount: string;
      };

      const xdr = await buildUnsignedPayment({
        senderPublicKey: holderPublicKey,
        destinationPublicKey: assetIssuer,
        assetCode,
        assetIssuer,
        amount,
      });

      res.status(200).json({ data: { xdr } });
    } catch (err) {
      if ((err as { response?: unknown }).response) {
        const mapped = mapHorizonError(err);
        res.status(mapped.status).json({ data: null, error: mapped.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/tokens/build-airdrop
 * Builds one unsigned transaction paying an equal amount of the community's
 * token to every current member, for the issuer's wallet to sign.
 *
 * The batch is atomic: every member is paid or none is, which is why this
 * replaced the previous implementation's loop of one transaction per member -
 * that could stop half way through, having already paid some of them.
 */
tokenRouter.post(
  '/build-airdrop',
  validateBody(buildAirdropSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { communityId, issuerPublicKey, amount, memo } = req.body as {
        communityId: string;
        issuerPublicKey: string;
        amount: string;
        memo?: string;
      };

      const [community] = await db.query<CommunityRow>(
        `SELECT asset_code, asset_issuer FROM communities WHERE id = $1 AND deleted_at IS NULL`,
        [communityId]
      );

      if (!community) {
        res.status(404).json({ data: null, error: 'Community not found' });
        return;
      }

      if (community.asset_issuer !== issuerPublicKey) {
        res.status(400).json({
          data: null,
          error: 'issuerPublicKey does not belong to the community token issuer',
        });
        return;
      }

      const members = await db.query<MemberRow>(
        `SELECT stellar_address FROM members WHERE community_id = $1 AND deleted_at IS NULL`,
        [communityId]
      );

      if (members.length === 0) {
        res
          .status(400)
          .json({ data: null, error: 'Community has no members to receive the airdrop' });
        return;
      }

      const xdr = await buildBatchPayment({
        senderPublicKey: issuerPublicKey,
        payments: members.map((member) => ({
          destinationPublicKey: member.stellar_address,
          assetCode: community.asset_code,
          assetIssuer: community.asset_issuer,
          amount,
        })),
        memo,
      });

      res.status(200).json({ data: { xdr, recipientCount: members.length, amount } });
    } catch (err) {
      if ((err as { response?: unknown }).response) {
        const mapped = mapHorizonError(err);
        res.status(mapped.status).json({ data: null, error: mapped.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/tokens/submit
 * Submits a client-signed transaction XDR built by /build-issue or
 * /build-trustline. Unlike POST /api/v1/tokens/transfer, this does not
 * restrict the transaction to a single payment operation, since a signed
 * changeTrust envelope must also pass through here.
 */
tokenRouter.post('/submit', async (req: Request, res: Response): Promise<void> => {
  const parsed = submitTokenXdrSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      meta: {
        errors: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
      error: 'Invalid request body',
    });
    return;
  }

  try {
    const txHash = await submitSignedXdr(parsed.data.signedXdr);

    // A burn changes circulating supply, and the transaction that did it was
    // built and signed on the client, so the server reads the new figure back
    // from Horizon rather than deriving it from anything the caller sent.
    const refresh = parsed.data.refreshSupply;
    if (refresh) {
      const supply = await getTotalSupply(refresh.assetCode, refresh.assetIssuer);
      await db.query(
        `UPDATE tokens SET total_supply = $1 WHERE asset_code = $2 AND asset_issuer = $3`,
        [supply, refresh.assetCode, refresh.assetIssuer]
      );
    }

    res.status(200).json({ data: { txHash } });
  } catch (error) {
    if ((error as { response?: unknown }).response) {
      const mapped = mapHorizonError(error);
      res.status(mapped.status).json({ data: null, error: mapped.message });
      return;
    }
    res.status(400).json({
      data: null,
      error: 'The signedXdr is not a valid transaction for the configured Stellar network.',
    });
  }
});

/**
 * POST /api/v1/tokens/transfer
 * Submits a client-signed payment transaction on behalf of a user.
 */
tokenRouter.post('/transfer', async (req: Request, res: Response): Promise<void> => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      meta: {
        errors: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
      error: 'Invalid request body',
    });
    return;
  }

  let transaction: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    transaction = TransactionBuilder.fromXDR(parsed.data.signedXdr, StellarService.getNetwork());
  } catch {
    res.status(400).json({
      data: null,
      error: 'The signedXdr is not a valid transaction for the configured Stellar network.',
    });
    return;
  }

  if (transaction.operations.length !== 1 || transaction.operations[0]?.type !== 'payment') {
    res.status(400).json({
      data: null,
      error: 'The signed transaction must contain exactly one payment operation.',
    });
    return;
  }

  const payment = transaction.operations[0];
  const sourcePublicKey = getTransactionSource(transaction);
  if (!sourcePublicKey) {
    res
      .status(400)
      .json({ data: null, error: 'The signed transaction must have a source account.' });
    return;
  }

  let reservation: TransferReservation | null = null;
  if (!payment.asset.isNative()) {
    try {
      reservation = await reserveUnverifiedTransfer({
        stellarAddress: sourcePublicKey,
        assetCode: payment.asset.code,
        assetIssuer: payment.asset.issuer,
        amount: payment.amount,
      });
    } catch (error) {
      if (error instanceof DailyTransactionLimitError) {
        res.status(403).json({
          data: null,
          error: {
            code: error.code,
            message: error.message,
            limit: UNVERIFIED_DAILY_LIMIT,
            dailyTotal: error.dailyTotal,
            attemptedAmount: error.attemptedAmount,
          },
        });
        return;
      }
      logger.error('Failed to evaluate compliance transfer limit', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ data: null, error: 'Unable to evaluate transaction limits.' });
      return;
    }
  }

  try {
    const result = await StellarService.submitTransaction(transaction);
    if (reservation) {
      try {
        await markTransferSubmitted(reservation.id, result.hash);
      } catch (error) {
        logger.error('Failed to finalize compliance transfer reservation', {
          reservationId: reservation.id,
          txHash: result.hash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await invalidateBalanceCache([sourcePublicKey, getTransactionDestination(transaction)]);
    res.status(200).json({ data: { txHash: result.hash } });
  } catch (error) {
    if (reservation) {
      try {
        await markTransferFailed(reservation.id);
      } catch (reservationError) {
        logger.error('Failed to release compliance transfer reservation', {
          reservationId: reservation.id,
          error:
            reservationError instanceof Error ? reservationError.message : String(reservationError),
        });
      }
    }
    const account =
      sourcePublicKey !== undefined
        ? await StellarService.loadAccount(sourcePublicKey).catch(() => null)
        : null;
    const mapped = mapHorizonError(error, {
      requiredXlm: getRequiredXlmForTransaction(transaction),
      currentBalance: account ? getNativeBalance(account) : undefined,
    });

    if (mapped.code === 'INSUFFICIENT_BALANCE') {
      res.status(mapped.status).json({
        data: null,
        error: {
          code: mapped.code,
          message: mapped.message,
          requiredXlm: mapped.requiredXlm,
          currentBalance: mapped.currentBalance,
        },
      });
      return;
    }

    res.status(mapped.status).json({ data: null, error: mapped.message });
  }
});

/**
 * GET /api/v1/tokens/:assetCode/:issuer
 * Fetches metadata for a single token by its community's primary asset.
 */
tokenRouter.get('/:assetCode/:issuer', async (req: Request, res: Response, next: NextFunction) => {
  const parsed = tokenParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      error: 'Validation failed',
      meta: {
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  try {
    const [token] = await db.query(
      `SELECT id, asset_code, asset_issuer, name, description
         FROM communities
         WHERE asset_code = $1 AND asset_issuer = $2`,
      [parsed.data.assetCode, parsed.data.issuer]
    );

    if (!token) {
      res.status(404).json({ data: null, error: 'Token not found' });
      return;
    }

    res.json({ data: token });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tokens/:communityId
 * Lists all tokens issued for a community.
 */
tokenRouter.get('/:communityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tokens = await db.query<Token>(
      'SELECT * FROM tokens WHERE community_id = $1 ORDER BY created_at',
      [req.params.communityId]
    );
    res.json({ data: tokens });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tokens/holders/:assetCode/:issuer
 * Lists accounts holding a given asset by querying Horizon.
 */
tokenRouter.get(
  '/holders/:assetCode/:issuer',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { assetCode, issuer } = req.params;
      if (!/^[A-Za-z0-9]{1,12}$/.test(assetCode)) {
        res.status(400).json({ data: null, error: 'Invalid asset code' });
        return;
      }
      if (!isValidStellarPublicKey(issuer)) {
        res.status(400).json({ data: null, error: 'Invalid Stellar issuer address' });
        return;
      }

      const holders = await getAssetHolders(assetCode, issuer);
      res.json({ data: holders });
    } catch (err) {
      if ((err as { response?: unknown }).response) {
        const mapped = mapHorizonError(err);
        res.status(mapped.status).json({ data: null, error: mapped.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * GET /api/v1/tokens/supply/:assetCode/:issuer
 * Returns the current circulating supply Horizon reports for an issued asset.
 */
tokenRouter.get(
  '/supply/:assetCode/:issuer',
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = tokenParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: 'Invalid request parameters',
        meta: {
          errors: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
      return;
    }

    try {
      const supply = await getTotalSupply(parsed.data.assetCode, parsed.data.issuer);
      res.json({ data: { assetCode: parsed.data.assetCode, issuer: parsed.data.issuer, supply } });
    } catch (err) {
      if ((err as { response?: unknown }).response) {
        res.status(502).json({
          data: null,
          error: 'Horizon is temporarily unavailable. Please try again later.',
        });
        return;
      }
      next(err);
    }
  }
);

/**
 * GET /api/v1/tokens/history/:assetCode/:issuer
 * Returns recent payment activity for an asset. Horizon has no
 * "operations/payments for an asset" endpoint, so the issuer account's
 * payment history filtered to this asset is the closest available proxy.
 */
tokenRouter.get(
  '/history/:assetCode/:issuer',
  (req: Request, res: Response, next: NextFunction): void => {
    const parsed = tokenParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid token history parameters' },
        meta: { errors: parsed.error.issues },
      });
      return;
    }

    const { assetCode, issuer } = parsed.data;

    StellarService.call('payments.forAccount', () =>
      StellarService.getServer().payments().forAccount(issuer).limit(20).order('desc').call()
    )
      .then((page) => {
        const records = page.records.filter(
          (record) =>
            'asset_code' in record &&
            record.asset_code === assetCode &&
            'asset_issuer' in record &&
            record.asset_issuer === issuer
        );

        res.status(200).json({ data: records, meta: { assetCode, issuer, limit: 20 } });
      })
      .catch(next);
  }
);
