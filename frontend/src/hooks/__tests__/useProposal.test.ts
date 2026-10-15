import { renderHook } from '@testing-library/react';
import { api } from '@/lib/api';
import { PROPOSAL_REFRESH_MS, useProposal, type Proposal } from '../useProposal';

const PROPOSAL: Proposal = {
  id: 'proposal-1',
  community_id: 'community-1',
  proposer_address: `G${'A'.repeat(55)}`,
  title: 'Fund the community clinic',
  description: 'Release the approved grant',
  type: 'treasury_spend',
  status: 'active',
  quorum_percent: '50.00',
  metadata: { amount: '500' },
  voting_starts_at: '2026-10-15T10:00:00.000Z',
  voting_ends_at: '2026-10-16T10:00:00.000Z',
  executed_at: null,
  stellar_tx_hash: null,
  created_at: '2026-10-15T10:00:00.000Z',
  updated_at: '2026-10-15T10:00:00.000Z',
  votes_for: '600.0000000',
  votes_against: '100.0000000',
  votes_abstain: '0',
  total_weight: '700.0000000',
};

type SwrOptions = {
  refreshInterval?: number;
  keepPreviousData?: boolean;
  refreshWhenHidden?: boolean;
  revalidateOnFocus?: boolean;
};

type CapturedCall = {
  key: string | null;
  fetcher: () => Promise<unknown>;
  options: SwrOptions;
};

let lastCall: CapturedCall | undefined;

const swrMock = jest.fn(
  (key: string | null, fetcher: () => Promise<unknown>, options: SwrOptions) => {
    lastCall = { key, fetcher, options };
    return { data: key ? PROPOSAL : undefined, error: undefined, isLoading: false };
  }
);

jest.mock('swr', () => ({
  __esModule: true,
  default: (...args: [string | null, () => Promise<unknown>, SwrOptions]) => swrMock(...args),
}));

beforeEach(() => {
  swrMock.mockClear();
  lastCall = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useProposal', () => {
  it('defers the request until an id is available', () => {
    const { result } = renderHook(() => useProposal(null));

    expect(lastCall?.key).toBeNull();
    expect(result.current.data).toBeUndefined();
  });

  it('encodes the id and returns the current proposal tally', () => {
    const { result } = renderHook(() => useProposal('proposal/one'));

    expect(lastCall?.key).toBe('/api/v1/proposals/proposal%2Fone');
    expect(result.current.data?.votes_for).toBe('600.0000000');
    expect(result.current.data?.total_weight).toBe('700.0000000');
  });

  it('polls visibly open views without discarding previous data', () => {
    renderHook(() => useProposal('proposal-1'));

    expect(lastCall?.options).toEqual({
      refreshInterval: PROPOSAL_REFRESH_MS,
      keepPreviousData: true,
      refreshWhenHidden: false,
      revalidateOnFocus: true,
    });
  });

  it('uses the public proposal endpoint fetcher', async () => {
    const get = jest.spyOn(api, 'get').mockResolvedValue(PROPOSAL);
    renderHook(() => useProposal('proposal-1'));

    await expect(lastCall?.fetcher()).resolves.toEqual(PROPOSAL);
    expect(get).toHaveBeenCalledWith('/api/v1/proposals/proposal-1', { auth: false });
  });
});
