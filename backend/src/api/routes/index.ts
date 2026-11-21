import { Router } from 'express';
import { authRouter } from './auth';
import { communityRouter } from './communities';
import { tokenRouter } from './tokens';
import { balanceRouter } from './balances';
import { loanRouter } from './loans';
import { reputationRouter } from './reputation';
import { transactionRouter } from './transactions';
import { feeRouter } from './fees';
import { webhookRouter } from './webhooks';
import { pricesRouter } from './prices';
import { trustlineRouter } from './trustlines';
import { accountsRouter } from './accounts';
import { multisigRouter } from './multisig';
import { batchRouter } from './batch';
import { streamRouter } from './stream';
import { kycRouter } from './kyc';
import { accountRouter } from './account';
import { proposalRouter } from './proposals';
import {
  apiLimiter,
  apiSlowDown,
  authLimiter,
  authSlowDown,
  tokenLimiter,
  tokenSlowDown,
} from '../middleware/rateLimit';

/**
 * Combined API router. Mounted under the `/api/v1` version prefix in app.ts so
 * that future breaking changes can ship under `/api/v2` without disturbing
 * existing clients.
 */
export const apiRouter: Router = Router();

// Signed webhook deliveries arrive in bursts from a few source IPs, and are
// authenticated by HMAC rather than by client identity, so they sit ahead of the
// per-IP limiter instead of competing with ordinary clients for its budget.
apiRouter.use('/webhooks', webhookRouter);

// API-wide backstop: gradual slowdown first, then a hard limit.
apiRouter.use(apiSlowDown, apiLimiter);

// Tighter per-route limits for the sensitive resources. Each slowdown sits in
// front of its hard limit so a client is throttled before it is blocked.
apiRouter.use('/auth', authSlowDown, authLimiter, authRouter);
apiRouter.use('/communities', communityRouter);
apiRouter.use('/tokens', tokenSlowDown, tokenLimiter, tokenRouter);
apiRouter.use('/balances', balanceRouter);
apiRouter.use('/loans', loanRouter);
apiRouter.use('/reputation', reputationRouter);
apiRouter.use('/transactions', transactionRouter);
apiRouter.use('/fees', feeRouter);
apiRouter.use('/prices', pricesRouter);
apiRouter.use('/trustlines', trustlineRouter);
apiRouter.use('/accounts', accountsRouter);
apiRouter.use('/multisig', multisigRouter);
apiRouter.use('/batch', batchRouter);
apiRouter.use('/stream', streamRouter);
apiRouter.use('/kyc', kycRouter);
apiRouter.use('/account', accountRouter);
apiRouter.use('/proposals', proposalRouter);
