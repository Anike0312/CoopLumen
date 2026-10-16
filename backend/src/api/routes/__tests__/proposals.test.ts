import request from 'supertest';
import type { PoolClient } from 'pg';
import app from '../../../app';
import { Keypair } from '@stellar/stellar-sdk';
import { db } from '../../../db';
import { createSessionToken } from '../../utils/sessionToken';

jest.mock('../../../db', () => ({
  db: {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(),
    transaction: jest.fn(),
  },
}));

const mockDb = db as jest.Mocked<typeof db>;
const proposalId = '550e8400-e29b-41d4-a716-446655440000';
const communityId = '660e8400-e29b-41d4-a716-446655440000';
const member = 'GDMZRAGTOJHQK3LN3D2EDLEAMS76EDIQEMWCUTYIYHUE5HFPLPGBCGUS';
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
const proposalId = '11111111-1111-4111-8111-111111111111';
const communityId = '22222222-2222-4222-8222-222222222222';
const proposer = Keypair.random().publicKey();

function authHeader(): string {
  return `Bearer ${createSessionToken(proposer).token}`;
}

const proposal = {
  id: proposalId,
  community_id: communityId,
  proposer_address: member,
  title: 'Fund the community clinic',
  description: null,
  type: 'general',
  status: 'active',
  quorum_percent: '50.00',
  metadata: null,
  voting_starts_at: '2026-10-15T10:00:00.000Z',
  voting_ends_at: '2026-10-16T10:00:00.000Z',
  executed_at: null,
  stellar_tx_hash: null,
  created_at: '2026-10-15T10:00:00.000Z',
  updated_at: '2026-10-15T10:00:00.000Z',
  votes_for: '0',
  votes_against: '0',
  votes_abstain: '0',
  total_weight: '0',
};

function authHeader(): string {
  return `Bearer ${createSessionToken(member).token}`;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('governance proposal routes', () => {
  it('returns a proposal with its aggregate tally', async () => {
    mockDb.query.mockResolvedValueOnce([proposal]);

    const response = await request(app).get(`/api/v1/proposals/${proposalId}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(proposal);
  });

  it('requires authentication to create a proposal', async () => {
    const response = await request(app).post('/api/v1/proposals').send({
      communityId,
      title: 'Fund the community clinic',
    });

    expect(response.status).toBe(401);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('creates an active proposal for a community member', async () => {
    mockDb.query
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([{ id: proposalId }])
      .mockResolvedValueOnce([proposal]);

    const response = await request(app)
      .post('/api/v1/proposals')
      .set('Authorization', authHeader())
      .send({ communityId, title: proposal.title });

    expect(response.status).toBe(201);
    expect(response.body.data.id).toBe(proposalId);
    expect(mockDb.query.mock.calls[1][0]).toContain("'active'");
  });

  it('records a member vote in a transaction and returns the new tally', async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            community_id: communityId,
            status: 'active',
            voting_ends_at: new Date(Date.now() + 60_000),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query: clientQuery } as unknown as PoolClient;
    mockDb.transaction.mockImplementation(async (handler) => handler(client));
    mockDb.query.mockResolvedValueOnce([
      { ...proposal, votes_for: '1.0000000', total_weight: '1.0000000' },
    ]);

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/votes`)
      .set('Authorization', authHeader())
      .send({ choice: 'for' });

    expect(response.status).toBe(201);
    expect(response.body.data.votes_for).toBe('1.0000000');
    expect(clientQuery.mock.calls[2][0]).toContain('INSERT INTO votes');
  });

  it('returns a conflict when the member already voted', async () => {
    mockDb.transaction.mockRejectedValue({
      code: '23505',
      constraint: 'votes_unique_per_voter',
    });

    const response = await request(app)
      .post(`/api/v1/proposals/${proposalId}/votes`)
      .set('Authorization', authHeader())
      .send({ choice: 'for' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('This member has already voted');
  proposer_address: proposer,
  title: 'Fund the community garden',
  description: 'Release the approved grant.',
  type: 'treasury_spend',
  status: 'active',
  quorum_percent: '50.00',
  metadata: { amount: '500' },
  voting_starts_at: '2026-10-16T00:00:00.000Z',
  voting_ends_at: '2099-01-01T00:00:00.000Z',
  executed_at: null,
  stellar_tx_hash: null,
  created_at: '2026-10-16T00:00:00.000Z',
  updated_at: '2026-10-16T00:00:00.000Z',
};

describe('governance proposal routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/proposals', () => {
    it('requires a valid communityId query parameter', async () => {
      const response = await request(app).get('/api/v1/proposals?communityId=bad');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.meta.errors[0].path).toBe('communityId');
      expect(query).not.toHaveBeenCalled();
    });

    it('lists proposals for a community with an optional status filter', async () => {
      query.mockResolvedValue([proposal]);

      const response = await request(app).get(
        `/api/v1/proposals?communityId=${communityId}&status=active`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [proposal] });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('p.community_id = $1'), [
        communityId,
        'active',
      ]);
    });
  });

  describe('GET /api/v1/proposals/:id', () => {
    it('rejects a malformed proposal id before querying', async () => {
      const response = await request(app).get('/api/v1/proposals/not-a-uuid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(query).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown proposal', async () => {
      query.mockResolvedValue([]);

      const response = await request(app).get(`/api/v1/proposals/${proposalId}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ data: null, error: 'Proposal not found' });
    });

    it('returns proposal detail with its current database tally', async () => {
      query.mockResolvedValue([{ ...proposal, votes_for: '75', votes_against: '25' }]);

      const response = await request(app).get(`/api/v1/proposals/${proposalId}`);

      expect(response.status).toBe(200);
      expect(response.body.data.votes_for).toBe('75');
      expect(response.body.data.votes_against).toBe('25');
      expect(query).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN votes'), [proposalId]);
    });
  });

  describe('POST /api/v1/proposals', () => {
    const payload = {
      communityId,
      title: proposal.title,
      description: proposal.description,
      type: proposal.type,
      quorumPercent: 50,
      metadata: proposal.metadata,
      votingEndsAt: proposal.voting_ends_at,
    };

    it('requires authentication', async () => {
      const response = await request(app).post('/api/v1/proposals').send(payload);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ data: null, error: 'Authentication required' });
      expect(query).not.toHaveBeenCalled();
    });

    it('validates the request body with Zod', async () => {
      const response = await request(app)
        .post('/api/v1/proposals')
        .set('Authorization', authHeader())
        .send({ ...payload, title: '   ', votingEndsAt: 'yesterday' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.meta.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'title' }),
          expect.objectContaining({ path: 'votingEndsAt' }),
        ])
      );
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects a caller who is not an active community member', async () => {
      query.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/v1/proposals')
        .set('Authorization', authHeader())
        .send(payload);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        data: null,
        error: 'Only active community members can create proposals',
      });
    });

    it('creates an active proposal for an authenticated member', async () => {
      query.mockResolvedValue([proposal]);

      const response = await request(app)
        .post('/api/v1/proposals')
        .set('Authorization', authHeader())
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ data: proposal });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO proposals'), [
        communityId,
        proposer,
        proposal.title,
        proposal.description,
        proposal.type,
        50,
        JSON.stringify(proposal.metadata),
        expect.any(Date),
      ]);
    });

    it('returns the standard envelope for unexpected database errors', async () => {
      query.mockRejectedValue(new Error('database unavailable'));

      const response = await request(app)
        .post('/api/v1/proposals')
        .set('Authorization', authHeader())
        .send(payload);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ data: null, error: 'Internal server error' });
    });
  });
});
