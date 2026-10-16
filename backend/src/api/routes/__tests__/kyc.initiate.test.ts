import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { PoolClient } from 'pg';
import { db } from '../../../db';
import { createSessionToken } from '../../utils/sessionToken';

jest.mock('../../../db', () => ({
  db: {
    query: jest.fn(),
    transaction: jest.fn(),
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

const transaction = db.transaction as jest.Mock;
const communityId = '11111111-1111-4111-8111-111111111111';
const address = Keypair.random().publicKey();
const otherAddress = Keypair.random().publicKey();
const recordId = '22222222-2222-4222-8222-222222222222';
const initiatedAt = '2026-10-16T00:00:00.000Z';

function authHeader(authAddress = address): string {
  return `Bearer ${createSessionToken(authAddress).token}`;
}

function mockTransaction(rowsByQuery: object[][]): jest.Mock {
  const query = jest.fn();
  rowsByQuery.forEach((rows) => query.mockResolvedValueOnce({ rows }));
  transaction.mockImplementation((callback) => callback({ query } as unknown as PoolClient));
  return query;
}

function kycRecord(status: string, provider = 'sep12'): object {
  return {
    id: recordId,
    community_id: communityId,
    stellar_address: address,
    status,
    provider,
    updated_at: initiatedAt,
  };
}

describe('POST /api/v1/kyc/initiate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires authentication', async () => {
    const response = await request(app).post('/api/v1/kyc/initiate').send({
      communityId,
      address,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ data: null, error: 'Authentication required' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('validates the community and Stellar address with Zod', async () => {
    const response = await request(app)
      .post('/api/v1/kyc/initiate')
      .set('Authorization', authHeader())
      .send({ communityId: 'bad', address: 'bad' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(response.body.meta.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'communityId' }),
        expect.objectContaining({ path: 'address' }),
      ])
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('prevents a caller from initiating KYC for another address', async () => {
    const response = await request(app)
      .post('/api/v1/kyc/initiate')
      .set('Authorization', authHeader(otherAddress))
      .send({ communityId, address });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('your own address');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('requires active community membership', async () => {
    mockTransaction([[]]);

    const response = await request(app)
      .post('/api/v1/kyc/initiate')
      .set('Authorization', authHeader())
      .send({ communityId, address });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('not an active member');
  });

  it('refuses to restart KYC for a verified address', async () => {
    mockTransaction([[{ '?column?': 1 }], [kycRecord('verified')]]);

    const response = await request(app)
      .post('/api/v1/kyc/initiate')
      .set('Authorization', authHeader())
      .send({ communityId, address });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Address is already verified');
  });

  it('returns an existing pending flow idempotently', async () => {
    mockTransaction([[{ '?column?': 1 }], [kycRecord('submitted', 'provider-a')]]);

    const response = await request(app)
      .post('/api/v1/kyc/initiate')
      .set('Authorization', authHeader())
      .send({ communityId, address, provider: 'provider-b' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        id: recordId,
        communityId,
        address,
        status: 'pending',
        provider: 'provider-a',
        initiatedAt,
      },
    });
  });

  it.each(['rejected', 'expired'])('restarts a %s KYC flow', async (status) => {
    const query = mockTransaction([
      [{ '?column?': 1 }],
      [kycRecord(status)],
      [kycRecord('pending', 'provider-b')],
    ]);

    const response = await request(app)
      .post('/api/v1/kyc/initiate')
      .set('Authorization', authHeader())
      .send({ communityId, address, provider: 'provider-b' });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('pending');
    expect(response.body.data.provider).toBe('provider-b');
    expect(query.mock.calls[2][0]).toContain("SET status = 'pending'");
  });

  it('creates a new pending KYC flow', async () => {
    const query = mockTransaction([[{ '?column?': 1 }], [], [kycRecord('pending')]]);

    const response = await request(app)
      .post('/api/v1/kyc/initiate')
      .set('Authorization', authHeader())
      .send({ communityId, address });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({
      id: recordId,
      communityId,
      address,
      status: 'pending',
      provider: 'sep12',
      initiatedAt,
    });
    expect(query.mock.calls[2][0]).toContain('INSERT INTO kyc_records');
  });

  it('uses the standard error envelope for unexpected database failures', async () => {
    transaction.mockRejectedValue(new Error('database unavailable'));

    const response = await request(app)
      .post('/api/v1/kyc/initiate')
      .set('Authorization', authHeader())
      .send({ communityId, address });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ data: null, error: 'Internal server error' });
  });
});
