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
const proposalId = '11111111-1111-4111-8111-111111111111';
const communityId = '22222222-2222-4222-8222-222222222222';
const delegator = Keypair.random().publicKey();
const delegatee = Keypair.random().publicKey();

function authHeader(address = delegator): string {
  return `Bearer ${createSessionToken(address).token}`;
}

function mockTransaction(rowsByQuery: object[][]): jest.Mock {
  const query = jest.fn();
  rowsByQuery.forEach((rows) => query.mockResolvedValueOnce({ rows }));
  transaction.mockImplementation((callback) => callback({ query } as unknown as PoolClient));
  return query;
}

function activeProposal(): object {
  return {
    id: proposalId,
    community_id: communityId,
    status: 'active',
    voting_ends_at: '2099-01-01T00:00:00.000Z',
  };
}

describe('POST /api/v1/proposals/:id/delegate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires authentication', async () => {
    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .send({ delegateeAddress: delegatee });

    expect(response.status).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('validates the proposal id and delegatee address', async () => {
    const invalidId = await request(app)
      .post('/api/v1/proposals/not-a-uuid/delegate')
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegatee });
    const invalidAddress = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: 'bad-address' });

    expect(invalidId.status).toBe(400);
    expect(invalidId.body.error).toBe('Validation failed');
    expect(invalidAddress.status).toBe(400);
    expect(invalidAddress.body.error).toBe('Validation failed');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects self-delegation', async () => {
    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegator });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      data: null,
      error: 'Cannot delegate voting power to yourself',
    });
  });

  it('returns 404 for an unknown proposal', async () => {
    mockTransaction([[]]);

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegatee });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ data: null, error: 'Proposal not found' });
  });

  it('rejects a proposal that is not accepting delegations', async () => {
    mockTransaction([[{ ...activeProposal(), status: 'passed' }]]);

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegatee });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Proposal is not accepting delegations');
  });

  it('requires both accounts to be active community members', async () => {
    mockTransaction([[activeProposal()], [{ stellar_address: delegator }]]);

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegatee });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('active members');
  });

  it('rejects delegation after either account has voted', async () => {
    mockTransaction([
      [activeProposal()],
      [{ stellar_address: delegator }, { stellar_address: delegatee }],
      [{ voter_address: delegatee }],
    ]);

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegatee });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('after either account votes');
  });

  it('rejects delegation chains and cycles', async () => {
    mockTransaction([
      [activeProposal()],
      [{ stellar_address: delegator }, { stellar_address: delegatee }],
      [],
      [{ exists: true }],
    ]);

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegatee });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Delegation chains and cycles are not allowed');
  });

  it('creates or replaces the caller delegation', async () => {
    const now = '2026-10-16T00:00:00.000Z';
    const query = mockTransaction([
      [activeProposal()],
      [{ stellar_address: delegator }, { stellar_address: delegatee }],
      [],
      [{ exists: false }],
      [
        {
          proposal_id: proposalId,
          delegator_address: delegator,
          delegatee_address: delegatee,
          created_at: now,
          updated_at: now,
        },
      ],
    ]);

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegatee });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        proposalId,
        delegatorAddress: delegator,
        delegateeAddress: delegatee,
        createdAt: now,
        updatedAt: now,
      },
    });
    expect(query.mock.calls[4][0]).toContain('ON CONFLICT');
    expect(query.mock.calls[4][1]).toEqual([proposalId, delegator, delegatee]);
  });

  it('returns the standard error envelope for unexpected database failures', async () => {
    transaction.mockRejectedValue(new Error('database unavailable'));

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/delegate`)
      .set('Authorization', authHeader())
      .send({ delegateeAddress: delegatee });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ data: null, error: 'Internal server error' });
  });
});
