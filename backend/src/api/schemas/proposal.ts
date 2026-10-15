import { z } from 'zod';

export const proposalIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'Proposal ID must be a valid UUID' }),
});

export const createProposalSchema = z.object({
  communityId: z.string().uuid({ message: 'Community ID must be a valid UUID' }),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).optional(),
  type: z
    .enum([
      'general',
      'loan_approval',
      'member_removal',
      'treasury_spend',
      'settings_change',
      'token_issuance',
    ])
    .default('general'),
  quorumPercent: z.coerce.number().min(0).max(100).default(50),
  votingDurationHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const castVoteSchema = z.object({
  choice: z.enum(['for', 'against', 'abstain']),
  reason: z.string().trim().max(2_000).optional(),
});
