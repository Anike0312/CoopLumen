import useSWR from 'swr';
import { api } from '@/lib/api';

export type ProposalType =
  | 'general'
  | 'loan_approval'
  | 'member_removal'
  | 'treasury_spend'
  | 'settings_change'
  | 'token_issuance';

export type ProposalStatus = 'draft' | 'active' | 'passed' | 'rejected' | 'executed' | 'cancelled';

/** Proposal metadata and the latest aggregate ballot weights. */
export interface Proposal {
  id: string;
  community_id: string;
  proposer_address: string;
  title: string;
  description: string | null;
  type: ProposalType;
  status: ProposalStatus;
  quorum_percent: string;
  metadata: Record<string, unknown> | null;
  voting_starts_at: string;
  voting_ends_at: string;
  executed_at: string | null;
  stellar_tx_hash: string | null;
  created_at: string;
  updated_at: string;
  votes_for: string;
  votes_against: string;
  votes_abstain: string;
  total_weight: string;
}

/** How often an open proposal's tally is refreshed from the backend. */
export const PROPOSAL_REFRESH_MS = 5_000;

/**
 * Reads one proposal and keeps its vote tally current while the view is open.
 * Pass an empty or null id to defer the request until route data is available.
 */
export function useProposal(id: string | null | undefined) {
  const path = id ? `/api/v1/proposals/${encodeURIComponent(id)}` : null;

  return useSWR<Proposal>(path, () => api.get<Proposal>(path as string, { auth: false }), {
    refreshInterval: PROPOSAL_REFRESH_MS,
    keepPreviousData: true,
    refreshWhenHidden: false,
    revalidateOnFocus: true,
  });
}
