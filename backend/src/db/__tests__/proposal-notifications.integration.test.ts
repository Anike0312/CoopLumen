/**
 * Integration test: verifies proposal creation produces member-facing alerts
 * in a real migrated PostgreSQL database. Skipped when DATABASE_URL is absent.
 */

import { Pool, PoolClient } from 'pg';
import {
  createCommunity,
  createMember,
  makeTestPool,
  TEST_MEMBERS,
  truncateAll,
} from '../../testing/fixtures';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIf = RUN ? describe : describe.skip;

interface ProposalNotification {
  stellar_address: string;
  community_id: string;
  type: string;
  title: string;
  body: string;
  metadata: {
    proposalId: string;
    proposalType: string;
    proposalStatus: string;
    votingEndsAt: string;
  };
}

describeIf('proposal member notifications (integration)', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = makeTestPool();
    client = await pool.connect();
    await truncateAll(client);
  });

  afterAll(async () => {
    await truncateAll(client);
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  it('alerts every current member when a proposal is created', async () => {
    const community = await createCommunity(client, { name: 'ProposalAlertsDAO' });
    await createMember(client, community.id, TEST_MEMBERS[0]);
    await createMember(client, community.id, TEST_MEMBERS[1], 'admin');
    await createMember(client, community.id, TEST_MEMBERS[2]);
    await client.query(
      'UPDATE members SET deleted_at = NOW() WHERE community_id = $1 AND stellar_address = $2',
      [community.id, TEST_MEMBERS[2]]
    );

    const proposal = await client.query<{ id: string }>(
      `INSERT INTO proposals
         (community_id, proposer_address, title, description, type, status, voting_ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        community.id,
        TEST_MEMBERS[0],
        'Expand the community fund',
        'Allocate more tokens to member lending.',
        'treasury_spend',
        'active',
        '2030-01-01T00:00:00Z',
      ]
    );

    const { rows } = await client.query<ProposalNotification>(
      `SELECT stellar_address, community_id, type, title, body, metadata
       FROM notifications
       ORDER BY stellar_address`
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.stellar_address)).toEqual(
      [TEST_MEMBERS[0], TEST_MEMBERS[1]].sort()
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          community_id: community.id,
          type: 'proposal_created',
          title: 'New proposal: Expand the community fund',
          body: 'Allocate more tokens to member lending.',
          metadata: expect.objectContaining({
            proposalId: proposal.rows[0].id,
            proposalType: 'treasury_spend',
            proposalStatus: 'active',
          }),
        }),
      ])
    );
  });

  it('uses a useful fallback message when the proposal has no description', async () => {
    const community = await createCommunity(client, { name: 'FallbackAlertsDAO' });
    await createMember(client, community.id, TEST_MEMBERS[0]);

    await client.query(
      `INSERT INTO proposals
         (community_id, proposer_address, title, voting_ends_at)
       VALUES ($1, $2, $3, $4)`,
      [community.id, TEST_MEMBERS[0], 'Review the bylaws', '2030-01-01T00:00:00Z']
    );

    const { rows } = await client.query<{ body: string }>(
      `SELECT body FROM notifications WHERE stellar_address = $1`,
      [TEST_MEMBERS[0]]
    );

    expect(rows).toEqual([{ body: 'A new governance proposal is ready for review.' }]);
  });
});
