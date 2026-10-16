import { createHmac, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

export const STELLAR_WEBHOOK_SIGNATURE_HEADER = 'x-stellar-webhook-signature';
export const KYC_WEBHOOK_SIGNATURE_HEADER = 'x-kyc-webhook-signature';

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

function computeSignature(secret: string, payload: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Compares two hex-encoded HMAC digests in constant time. Falls back to a
 * length check (which is not itself timing-safe, but leaks nothing about the
 * secret) when the strings can't be compared because their lengths differ,
 * since `timingSafeEqual` throws on mismatched buffer lengths.
 */
function signaturesMatch(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(provided, 'hex');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Verifies the `X-Stellar-Webhook-Signature` header against an HMAC-SHA256
 * digest of the raw request body, computed with `STELLAR_WEBHOOK_SECRET`.
 * Rejects the request with 401 when the signature is missing, malformed, or
 * does not match, and with 503 when the server has no secret configured
 * (misconfiguration should fail closed, not silently accept anything).
 *
 * Must run after the raw-body-capturing `express.json({ verify })` in
 * app.ts — it verifies over the exact bytes received, not a re-serialized
 * copy of the parsed body.
 */
function createWebhookSignatureVerifier(
  secretEnvironmentVariable: string,
  signatureHeaderName: string
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = process.env[secretEnvironmentVariable];
    if (!secret) {
      logger.error(`${secretEnvironmentVariable} is not configured; rejecting webhook request`);
      res.status(503).json({
        data: null,
        error: 'Webhook signature verification is not configured on this server.',
      });
      return;
    }

    const signatureHeader = req.header(signatureHeaderName);
    if (!signatureHeader) {
      res.status(401).json({
        data: null,
        error: `Missing ${signatureHeaderName} header.`,
      });
      return;
    }

    const rawBody = (req as RequestWithRawBody).rawBody;
    if (!rawBody) {
      logger.error('Webhook signature check ran without a captured raw request body');
      res.status(500).json({ data: null, error: 'Unable to verify webhook signature.' });
      return;
    }

    const expectedSignature = computeSignature(secret, rawBody);

    let isValid: boolean;
    try {
      isValid = signaturesMatch(expectedSignature, signatureHeader);
    } catch {
      isValid = false;
    }

    if (!isValid) {
      logger.warn('Rejected webhook request with an invalid signature', {
        signatureHeaderName,
      });
      res.status(401).json({ data: null, error: 'Invalid webhook signature.' });
      return;
    }

    next();
  };
}

export const verifyWebhookSignature = createWebhookSignatureVerifier(
  'STELLAR_WEBHOOK_SECRET',
  STELLAR_WEBHOOK_SIGNATURE_HEADER
);

export const verifyKycWebhookSignature = createWebhookSignatureVerifier(
  'KYC_WEBHOOK_SECRET',
  KYC_WEBHOOK_SIGNATURE_HEADER
);
