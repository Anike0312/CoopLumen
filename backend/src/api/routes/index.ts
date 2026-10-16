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
import { proposalRouter } from './proposals';
import { kycRouter } from './kyc';

/**
 * Combined API router. Mounted under the `/api/v1` version prefix in app.ts so
 * that future breaking changes can ship under `/api/v2` without disturbing
 * existing clients.
 */
export const apiRouter: Router = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/communities', communityRouter);
apiRouter.use('/tokens', tokenRouter);
apiRouter.use('/balances', balanceRouter);
apiRouter.use('/loans', loanRouter);
apiRouter.use('/reputation', reputationRouter);
apiRouter.use('/transactions', transactionRouter);
apiRouter.use('/fees', feeRouter);
apiRouter.use('/webhooks', webhookRouter);
apiRouter.use('/prices', pricesRouter);
apiRouter.use('/trustlines', trustlineRouter);
apiRouter.use('/accounts', accountsRouter);
apiRouter.use('/multisig', multisigRouter);
apiRouter.use('/batch', batchRouter);
apiRouter.use('/stream', streamRouter);
apiRouter.use('/proposals', proposalRouter);
apiRouter.use('/kyc', kycRouter);
