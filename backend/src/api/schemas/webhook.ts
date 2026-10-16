import { z } from 'zod';

/**
 * Payload shape for incoming Stellar webhook notifications (e.g. from a
 * Horizon-event forwarder or a custom notification relay watching an
 * account). `data` is intentionally loose — event-specific fields vary by
 * `eventType` and are not re-validated here.
 */
export const stellarWebhookSchema = z.object({
  eventId: z.string().trim().min(1, 'eventId is required'),
  eventType: z.enum([
    'transaction.succeeded',
    'transaction.failed',
    'account.created',
    'trustline.created',
    'trustline.removed',
    'payment.received',
  ]),
  occurredAt: z.string().datetime({ message: 'occurredAt must be an ISO 8601 timestamp' }),
  data: z.record(z.string(), z.unknown()),
});

export type StellarWebhookPayload = z.infer<typeof stellarWebhookSchema>;

const stellarAddress = z
  .string()
  .trim()
  .regex(/^G[A-Z2-7]{55}$/, 'stellarAddress must be a valid Stellar public key');

/** Provider-neutral KYC status callback normalized at the API boundary. */
export const kycWebhookSchema = z
  .object({
    eventId: z.string().trim().min(1, 'eventId is required').max(200),
    provider: z.string().trim().min(1, 'provider is required').max(100),
    providerReference: z.string().trim().min(1, 'providerReference is required').max(200),
    communityId: z.string().uuid('communityId must be a valid UUID'),
    stellarAddress,
    status: z.enum(['pending', 'submitted', 'verified', 'rejected', 'expired']),
    occurredAt: z.string().datetime({ message: 'occurredAt must be an ISO 8601 timestamp' }),
    rejectionReason: z.string().trim().min(1).max(1000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .superRefine(({ status, rejectionReason }, context) => {
    if (status === 'rejected' && !rejectionReason) {
      context.addIssue({
        code: 'custom',
        path: ['rejectionReason'],
        message: 'rejectionReason is required when status is rejected',
      });
    }
  });

export type KycWebhookPayload = z.infer<typeof kycWebhookSchema>;
