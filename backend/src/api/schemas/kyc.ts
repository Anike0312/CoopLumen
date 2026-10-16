import { z } from 'zod';
import { isValidStellarPublicKey } from '../utils/stellar';

export const initiateKycSchema = z.object({
  communityId: z.string().uuid({ message: 'communityId must be a valid UUID' }),
  address: z.string().trim().refine(isValidStellarPublicKey, {
    message: 'address must be a valid Stellar public key',
  }),
  provider: z.string().trim().min(1).max(100).default('sep12'),
});

export type InitiateKycInput = z.infer<typeof initiateKycSchema>;
