import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { db } from '../../../db';

jest.mock('../../../db', () => ({
  db: {
    query: jest.fn(),
    ping: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock('../../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

import app from '../../../app';

const query = db.query as jest.Mock;
const address = Keypair.random().publicKey();

describe('GET /api/v1/kyc/status/:address', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns none when the account has no KYC record', async () => {
    query.mockResolvedValue([]);

    const response = await request(app).get(`/api/v1/kyc/status/${address}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { address, status: 'none' } });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM kyc_records'), [address]);
  });

  it.each([
    ['pending', 'pending'],
    ['submitted', 'pending'],
    ['verified', 'approved'],
    ['rejected', 'rejected'],
    ['expired', 'rejected'],
  ])('maps stored %s status to public %s status', async (stored, expected) => {
    query.mockResolvedValue([{ status: stored }]);

    const response = await request(app).get(`/api/v1/kyc/status/${address}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { address, status: expected } });
  });

  it('rejects an invalid Stellar address before querying the database', async () => {
    const response = await request(app).get('/api/v1/kyc/status/not-a-stellar-address');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      data: null,
      error: 'Validation failed',
      meta: {
        errors: [
          {
            path: 'address',
            message: 'address must be a valid Stellar public key',
          },
        ],
      },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the standard error envelope when the database fails', async () => {
    query.mockRejectedValue(new Error('database unavailable'));

    const response = await request(app).get(`/api/v1/kyc/status/${address}`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ data: null, error: 'Internal server error' });
  });
});
