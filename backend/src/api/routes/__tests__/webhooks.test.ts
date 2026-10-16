import request from 'supertest';
import { createHmac } from 'crypto';

jest.mock('../../../db', () => ({
  db: {
    query: jest.fn(),
    ping: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock('../../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import app from '../../../app';
import { db } from '../../../db';
import {
  KYC_WEBHOOK_SIGNATURE_HEADER,
  STELLAR_WEBHOOK_SIGNATURE_HEADER,
} from '../../middleware/webhookSignature';

const SECRET = 'integration-test-secret';

function sign(payload: object): string {
  return createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
}

describe('POST /api/v1/webhooks/stellar', () => {
  const originalSecret = process.env.STELLAR_WEBHOOK_SECRET;
  const validPayload = {
    eventId: 'evt_12345',
    eventType: 'payment.received',
    occurredAt: '2026-01-01T00:00:00.000Z',
    data: { amount: '10.0000000', assetCode: 'ECO' },
  };

  beforeEach(() => {
    process.env.STELLAR_WEBHOOK_SECRET = SECRET;
  });

  afterAll(() => {
    process.env.STELLAR_WEBHOOK_SECRET = originalSecret;
  });

  it('accepts a validly signed, well-formed webhook payload', async () => {
    const response = await request(app)
      .post('/api/v1/webhooks/stellar')
      .set(STELLAR_WEBHOOK_SIGNATURE_HEADER, sign(validPayload))
      .send(validPayload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { received: true, eventId: 'evt_12345' } });
  });

  it('rejects a request with no signature header', async () => {
    const response = await request(app).post('/api/v1/webhooks/stellar').send(validPayload);

    expect(response.status).toBe(401);
    expect(response.body.data).toBeNull();
  });

  it('rejects a request with an incorrect signature', async () => {
    const response = await request(app)
      .post('/api/v1/webhooks/stellar')
      .set(STELLAR_WEBHOOK_SIGNATURE_HEADER, 'a'.repeat(64))
      .send(validPayload);

    expect(response.status).toBe(401);
  });

  it('rejects a correctly-signed but malformed payload with 400 before touching the DB', async () => {
    const malformedPayload = { eventId: '', eventType: 'not.a.real.event', data: {} };
    const response = await request(app)
      .post('/api/v1/webhooks/stellar')
      .set(STELLAR_WEBHOOK_SIGNATURE_HEADER, sign(malformedPayload))
      .send(malformedPayload);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(response.body.meta.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'eventId' }),
        expect.objectContaining({ path: 'eventType' }),
        expect.objectContaining({ path: 'occurredAt' }),
      ])
    );
  });

  it('validates signature before payload shape, so a bad signature wins over a malformed body', async () => {
    const malformedPayload = { eventId: '' };
    const response = await request(app)
      .post('/api/v1/webhooks/stellar')
      .set(STELLAR_WEBHOOK_SIGNATURE_HEADER, 'a'.repeat(64))
      .send(malformedPayload);

    expect(response.status).toBe(401);
  });

  it('fails closed with 503 when the server has no webhook secret configured', async () => {
    delete process.env.STELLAR_WEBHOOK_SECRET;

    const response = await request(app)
      .post('/api/v1/webhooks/stellar')
      .set(STELLAR_WEBHOOK_SIGNATURE_HEADER, 'a'.repeat(64))
      .send(validPayload);

    expect(response.status).toBe(503);
  });
});

describe('POST /api/v1/webhooks/kyc', () => {
  const originalSecret = process.env.KYC_WEBHOOK_SECRET;
  const validPayload = {
    eventId: 'kyc_evt_12345',
    provider: 'example-provider',
    providerReference: 'applicant_789',
    communityId: '11111111-1111-4111-8111-111111111111',
    stellarAddress: `G${'A'.repeat(55)}`,
    status: 'verified',
    occurredAt: '2026-01-02T00:00:00.000Z',
    metadata: { reviewLevel: 'standard' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KYC_WEBHOOK_SECRET = SECRET;
    (db.query as jest.Mock).mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        status: 'verified',
        verified_at: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  afterAll(() => {
    process.env.KYC_WEBHOOK_SECRET = originalSecret;
  });

  it('authenticates, validates, and persists a provider status callback', async () => {
    const response = await request(app)
      .post('/api/v1/webhooks/kyc')
      .set(KYC_WEBHOOK_SIGNATURE_HEADER, sign(validPayload))
      .send(validPayload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        received: true,
        eventId: 'kyc_evt_12345',
        recordId: '22222222-2222-4222-8222-222222222222',
        status: 'verified',
        verifiedAt: '2026-01-02T00:00:00.000Z',
      },
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO kyc_records'),
      expect.arrayContaining([
        validPayload.communityId,
        validPayload.stellarAddress,
        'verified',
        'example-provider',
        'applicant_789',
      ])
    );
  });

  it('rejects an unsigned provider callback before writing KYC state', async () => {
    const response = await request(app).post('/api/v1/webhooks/kyc').send(validPayload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      data: null,
      error: `Missing ${KYC_WEBHOOK_SIGNATURE_HEADER} header.`,
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns envelope-formatted validation errors for a malformed callback', async () => {
    const malformedPayload = {
      ...validPayload,
      communityId: 'not-a-uuid',
      stellarAddress: 'not-a-stellar-address',
      status: 'rejected',
      rejectionReason: undefined,
    };
    const response = await request(app)
      .post('/api/v1/webhooks/kyc')
      .set(KYC_WEBHOOK_SIGNATURE_HEADER, sign(malformedPayload))
      .send(malformedPayload);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      data: null,
      error: 'Validation failed',
      meta: {
        errors: expect.arrayContaining([
          expect.objectContaining({ path: 'communityId' }),
          expect.objectContaining({ path: 'stellarAddress' }),
          expect.objectContaining({ path: 'rejectionReason' }),
        ]),
      },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns 404 when the callback references an unknown community', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce([]);
    const response = await request(app)
      .post('/api/v1/webhooks/kyc')
      .set(KYC_WEBHOOK_SIGNATURE_HEADER, sign(validPayload))
      .send(validPayload);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ data: null, error: 'Community not found' });
  });

  it('fails closed when the KYC webhook secret is not configured', async () => {
    delete process.env.KYC_WEBHOOK_SECRET;
    const response = await request(app)
      .post('/api/v1/webhooks/kyc')
      .set(KYC_WEBHOOK_SIGNATURE_HEADER, sign(validPayload))
      .send(validPayload);

    expect(response.status).toBe(503);
    expect(db.query).not.toHaveBeenCalled();
  });
});
