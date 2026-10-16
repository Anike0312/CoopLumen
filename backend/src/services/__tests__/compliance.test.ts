jest.mock('../../db', () => ({
  db: {
    transaction: jest.fn(),
    query: jest.fn(),
  },
}));

import { db } from '../../db';
import {
  DailyTransactionLimitError,
  markTransferFailed,
  markTransferSubmitted,
  reserveUnverifiedTransfer,
} from '../compliance';

const input = {
  stellarAddress: `G${'A'.repeat(55)}`,
  assetCode: 'COOP',
  assetIssuer: `G${'B'.repeat(55)}`,
  amount: '25.0000000',
};

function useClient(...results: Array<{ rows: object[] }>): jest.Mock {
  const query = jest.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  (db.transaction as jest.Mock).mockImplementationOnce(
    (callback: (client: { query: jest.Mock }) => unknown) => callback({ query })
  );
  return query;
}

describe('unverified account daily transfer limits', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not reserve allowance for an asset outside a CoopLumen community', async () => {
    const query = useClient({ rows: [] });

    await expect(reserveUnverifiedTransfer(input)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not limit a verified account', async () => {
    const query = useClient({ rows: [{ id: 'community-id' }] }, { rows: [{ status: 'verified' }] });

    await expect(reserveUnverifiedTransfer(input)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reserves allowance when the cumulative UTC-day total remains at the limit', async () => {
    const query = useClient(
      { rows: [{ id: 'community-id' }] },
      { rows: [{ status: 'pending' }] },
      { rows: [] },
      { rows: [{ total: '75.0000000' }] },
      { rows: [{ id: 'reservation-id' }] }
    );

    await expect(reserveUnverifiedTransfer(input)).resolves.toEqual({
      id: 'reservation-id',
      communityId: 'community-id',
    });
    expect(query.mock.calls[2][0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[4][0]).toContain('INSERT INTO compliance_transfers');
  });

  it('rejects a transfer that would push the account over 100 tokens for the UTC day', async () => {
    useClient(
      { rows: [{ id: 'community-id' }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ total: '80.0000000' }] }
    );

    await expect(reserveUnverifiedTransfer(input)).rejects.toMatchObject({
      name: 'DailyTransactionLimitError',
      code: 'UNVERIFIED_DAILY_LIMIT_EXCEEDED',
      dailyTotal: '80.0000000',
      attemptedAmount: '25.0000000',
    } satisfies Partial<DailyTransactionLimitError>);
  });

  it('moves reservations to submitted or failed states', async () => {
    (db.query as jest.Mock).mockResolvedValue([]);

    await markTransferSubmitted('reservation-id', 'tx-hash');
    await markTransferFailed('reservation-id');

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("status = 'submitted'"), [
      'reservation-id',
      'tx-hash',
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'failed'"), [
      'reservation-id',
    ]);
  });
});
