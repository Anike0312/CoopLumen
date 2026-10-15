import request from 'supertest';
import type { PoolClient } from 'pg';
import app from '../../../app';
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
  });
});
