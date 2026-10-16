import request from 'supertest';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { db } from '../../../db';

const mockRedisClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  get: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  on: jest.fn(),
  isOpen: true,
};

jest.mock('redis', () => ({
  createClient: jest.fn(() => mockRedisClient),
}));

jest.mock('../../../db', () => ({
  db: {
    query: jest.fn().mockResolvedValue([]),
    ping: jest.fn().mockResolvedValue(true),
    end: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('../../../services/compliance', () => {
  const actual = jest.requireActual('../../../services/compliance');
  return {
    ...actual,
    reserveUnverifiedTransfer: jest.fn().mockResolvedValue(null),
    markTransferSubmitted: jest.fn().mockResolvedValue(undefined),
    markTransferFailed: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('@stellar/stellar-sdk', () => ({
  ...jest.requireActual('@stellar/stellar-sdk'),
  TransactionBuilder: {
    ...jest.requireActual('@stellar/stellar-sdk').TransactionBuilder,
    fromXDR: jest.fn(),
  },
}));

jest.mock('../../../contracts/assets', () => ({
  buildUnsignedIssueAsset: jest.fn(),
  burnAsset: jest.fn(),
  getAssetHolders: jest.fn(),
  getAssetSupply: jest.fn(),
}));

jest.mock('../../../contracts/trustlines', () => ({
  buildUnsignedTrustline: jest.fn(),
}));

jest.mock('../../../contracts/transactions', () => ({
  submitSignedXdr: jest.fn(),
}));

import app from '../../../app';
import { buildUnsignedIssueAsset } from '../../../contracts/assets';
import { buildUnsignedTrustline } from '../../../contracts/trustlines';
import { submitSignedXdr } from '../../../contracts/transactions';
import { StellarService } from '../../../contracts/stellar';

const mockFromXDR = TransactionBuilder.fromXDR as jest.Mock;

describe('Token lifecycle: build, sign, submit, transfer', () => {
  const issuerKeypair = Keypair.random();
  const distributorKeypair = Keypair.random();
  const userKeypair = Keypair.random();
  const assetCode = 'COOP123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await db.end();
  });

  it('carries a token through issuance, trustline and transfer', async () => {
    // Build the unsigned issuance transaction. The issuer's secret never
    // reaches the server; the wallet signs the XDR that comes back.
    (buildUnsignedIssueAsset as jest.Mock).mockResolvedValueOnce('unsigned-issue-xdr');

    const buildIssueRes = await request(app).post('/api/v1/tokens/build-issue').send({
      issuerPublicKey: issuerKeypair.publicKey(),
      assetCode,
      distributorPublicKey: distributorKeypair.publicKey(),
      amount: '1000',
    });

    expect(buildIssueRes.status).toBe(200);
    expect(buildIssueRes.body.data.xdr).toBe('unsigned-issue-xdr');

    (submitSignedXdr as jest.Mock).mockResolvedValueOnce('tx-hash-issue');

    const submitIssueRes = await request(app)
      .post('/api/v1/tokens/submit')
      .send({ signedXdr: 'signed-issue-xdr' });

    expect(submitIssueRes.status).toBe(200);
    expect(submitIssueRes.body.data.txHash).toBe('tx-hash-issue');
    expect(submitSignedXdr).toHaveBeenCalledWith('signed-issue-xdr');

    // Same shape for the holder's trustline.
    (buildUnsignedTrustline as jest.Mock).mockResolvedValueOnce('unsigned-trustline-xdr');

    const buildTrustlineRes = await request(app).post('/api/v1/tokens/build-trustline').send({
      accountPublicKey: userKeypair.publicKey(),
      assetCode,
      assetIssuer: issuerKeypair.publicKey(),
    });

    expect(buildTrustlineRes.status).toBe(200);
    expect(buildTrustlineRes.body.data.xdr).toBe('unsigned-trustline-xdr');

    (submitSignedXdr as jest.Mock).mockResolvedValueOnce('tx-hash-trustline');

    const submitTrustlineRes = await request(app)
      .post('/api/v1/tokens/submit')
      .send({ signedXdr: 'signed-trustline-xdr' });

    expect(submitTrustlineRes.status).toBe(200);
    expect(submitTrustlineRes.body.data.txHash).toBe('tx-hash-trustline');

    // Transfer already took a signed envelope.
    const submitTransactionMock = jest.fn().mockResolvedValue({ hash: 'tx-hash-transfer' });
    (StellarService as unknown as { server: unknown }).server = {
      submitTransaction: submitTransactionMock,
    };

    mockFromXDR.mockReturnValueOnce({
      fee: 100,
      source: distributorKeypair.publicKey(),
      operations: [
        {
          type: 'payment',
          destination: userKeypair.publicKey(),
          asset: {
            isNative: (): boolean => false,
            code: assetCode,
            issuer: issuerKeypair.publicKey(),
          },
          amount: '100',
        },
      ],
    });

    const transferRes = await request(app).post('/api/v1/tokens/transfer').send({
      signedXdr: 'fake_xdr',
    });

    expect(transferRes.status).toBe(200);
    expect(transferRes.body.data.txHash).toBe('tx-hash-transfer');
  });

  it('rejects an invalid asset code before building anything', async () => {
    const res = await request(app).post('/api/v1/tokens/build-issue').send({
      issuerPublicKey: issuerKeypair.publicKey(),
      assetCode: 'INVALID-CODE_WITH_SPECIAL_CHARS',
      distributorPublicKey: distributorKeypair.publicKey(),
      amount: '1000',
    });

    expect(res.status).toBe(400);
    expect(res.body.meta.errors).toBeDefined();
    expect(buildUnsignedIssueAsset).not.toHaveBeenCalled();
  });
});
